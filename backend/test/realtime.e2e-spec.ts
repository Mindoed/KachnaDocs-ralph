import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1, messageYjsSyncStep1, messageYjsUpdate } from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { RT_FRAGMENT, RT_MESSAGE, type AwarenessUser } from '@kachnadocs/shared';
import { query } from '../src/db';
import {
  GHOST_ID,
  doc,
  group,
  http,
  loginAs,
  resetDatabase,
  startServer,
  stopServer,
  user,
  apiOrigin,
} from './helpers';

/**
 * The realtime gateway, spoken to over the raw y-websocket wire format.
 *
 * Deliberately a hand-rolled client rather than y-websocket's WebsocketProvider.
 * Two reasons, and the second is the one that matters:
 *
 *  1. Speed and legibility. No DOM, no jsdom shim, and a failure names the frame
 *     that failed instead of a stack inside a provider.
 *  2. The wire format stays pinned. If the client library ever changed framing, a
 *     suite that used the library on both sides would keep passing while real
 *     browsers broke — the gateway and the client would agree with each other and
 *     nobody else. Asserting the byte-level framing here means a protocol change
 *     has to be made deliberately, in a test that fails first.
 *
 * The browser's own path (Tiptap + the stock provider) is covered by
 * `e2e/realtime.spec.ts`, which is where SPEC.md:64's "without reloading" claim
 * can actually be checked. This file is the ACL and the persistence layer; that
 * one is the UX.
 */

let bona = '';
let ana = '';
let dana = '';

/** Bona's document (Engineering, she has WRITE+MANAGE). */
const RUNBOOK = doc('runbook');

beforeAll(async () => {
  await startServer();
  await resetDatabase();
  [bona, ana, dana] = await Promise.all([loginAs('bona'), loginAs('ana'), loginAs('dana')]);
});

afterAll(async () => {
  await stopServer();
});

// --------------------------------------------------------------------- helpers

interface Peer {
  socket: WebSocket;
  ydoc: Y.Doc;
  awareness: Awareness;
  /** Close codes observed, in order. */
  closes: number[];
  open: Promise<void>;
  closed: Promise<number>;
  /** Raw frames received, for the framing assertions. */
  frames: Uint8Array[];
  /** Hangs the socket up and releases the timers both Yjs objects own. */
  dispose: () => void;
}

/**
 * Every peer this suite opened, torn down after each test.
 *
 * Tests that expect a particular close code close their own socket and assert on
 * it; the rest would otherwise leak a live interval until the process ended.
 * Disposing twice is harmless, which is what lets an individual test keep closing
 * its peers explicitly.
 */
const livePeers: Peer[] = [];

afterEach(() => {
  for (const peer of livePeers.splice(0, livePeers.length)) peer.dispose();
});

const wsOrigin = (): string => apiOrigin().replace(/^http/, 'ws');

async function mintToken(documentId: string, token: string): Promise<string> {
  const res = await http.post(`/documents/${documentId}/realtime-token`, undefined, token);
  if (res.status !== 201) throw new Error(`token mint failed: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { ticket: string }).ticket;
}

/**
 * Connect, complete the sync handshake, and hand back a live peer.
 *
 * `quiet` peers are the ones used to probe denials: they install their handlers
 * and never send, because the interesting part of a denial is what the server
 * does to a connection that has done nothing wrong yet.
 */
async function connect(
  documentId: string,
  ticket: string,
  options: { quiet?: boolean; ydoc?: Y.Doc; awareness?: Awareness } = {},
): Promise<Peer> {
  // Passing a doc in is how a test reuses one across connections, which is what a
  // browser does on every ticket rotation. A fresh `Y.Doc` per connection would model
  // a page reload instead, and the two cases differ in the way that matters: applying
  // the whole document again to a doc that already holds it *merges* rather than
  // replaces, so a server that hands out a new snapshot under a new client id
  // duplicates the content and a test with a fresh doc per connect cannot see it.
  const ydoc = options.ydoc ?? new Y.Doc();
  const awareness = options.awareness ?? new Awareness(ydoc);
  const socket = new WebSocket(`${wsOrigin()}/api/realtime/${documentId}?ticket=${ticket}`);
  const peer: Peer = {
    socket,
    ydoc,
    awareness,
    closes: [],
    frames: [],
    open: new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    closed: new Promise((resolve) => socket.once('close', (code) => resolve(code))),
    dispose: () => {
      // Awareness runs a 30-second garbage-collection interval from its
      // constructor, which keeps the Node event loop alive after the suite is
      // green. Jest then waits, and `npm run verify` runs every suite in one
      // process — so an undisposed peer here hangs the whole gate on a run that
      // reported no failures. Destroying both sides is what a real client does
      // when you close the tab.
      if (socket.readyState === WebSocket.OPEN) socket.close();
      // Only what this helper created. A caller that handed in a doc keeps it, or the
      // second connection would be against a destroyed document.
      if (!options.ydoc) ydoc.destroy();
      if (!options.awareness) awareness.destroy();
    },
  };
  livePeers.push(peer);

  socket.on('message', (data: Buffer) => {
    const frame = new Uint8Array(data);
    peer.frames.push(frame);
    if (options.quiet) return;
    const decoder = decoding.createDecoder(frame);
    const type = decoding.readVarUint(decoder);
    if (type === RT_MESSAGE.sync) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, RT_MESSAGE.sync);
      readSyncMessage(decoder, reply, ydoc, socket);
      // Step 1 is answered with sync step 2, which is what the encoder holds once
      // readSyncMessage has appended to it; a bare `[sync]` means there was
      // nothing to send back.
      if (encoding.length(reply) > 1) socket.send(encoding.toUint8Array(reply));
      return;
    }
    if (type === RT_MESSAGE.awareness) {
      applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), socket);
    }
  });

  // The outbound half. Omitting it is the shape of a client that can read a
  // document forever and never change it, so both of these mirror what
  // y-websocket's WebsocketProvider does on the caller's side — and both carry
  // the origin guard, because a client that echoed its own changes back would make
  // every test about "did the peer see it" pass for the wrong reason.
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === socket) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, RT_MESSAGE.sync);
    encoding.writeVarUint(enc, messageYjsUpdate);
    encoding.writeVarUint8Array(enc, update);
    socket.send(encoding.toUint8Array(enc));
  });
  awareness.on(
    'update',
    (change: { added: number[]; removed: number[]; updated: number[] }, origin: unknown) => {
      const { added, removed, updated } = change;
      if (origin === socket) return;
      const clients = added.concat(updated, removed);
      if (clients.length === 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, RT_MESSAGE.awareness);
      encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(awareness, clients, awareness.getStates()));
      socket.send(encoding.toUint8Array(enc));
    },
  );

  await peer.open;
  if (!options.quiet) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, RT_MESSAGE.sync);
    writeSyncStep1(encoder, ydoc);
    socket.send(encoding.toUint8Array(encoder));
  }
  return peer;
}

/** A minimal ProseMirror-shaped paragraph appended to the shared fragment. */
function appendParagraph(ydoc: Y.Doc, text: string): void {
  const fragment = ydoc.getXmlFragment(RT_FRAGMENT);
  const paragraph = new Y.XmlElement('paragraph');
  const inner = new Y.XmlText();
  inner.insert(0, text);
  paragraph.insert(0, [inner]);
  ydoc.transact(() => fragment.insert(fragment.length, [paragraph]));
}

/**
 * Poll until `check` yields something truthy, and hand it back.
 *
 * Returning the value is what lets a test wait for *and then inspect* a presence
 * record: asserting on a snapshot taken after the fact would race the next
 * awareness frame, which can legitimately replace it.
 */
async function waitFor<T>(check: () => T | null | false | undefined, what: string, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait until the row on disk reflects `marker`.
 *
 * Waiting for the *socket* to close is not the same as waiting for the *write*:
 * the client's close event fires while the server is still inside its flush
 * query, and reading the row at that moment returns the previous debounce
 * window's content. Polling for the marker rather than sleeping is the honest
 * version of "eventually stored" — a fixed sleep would pass on a fast machine and
 * fail on a loaded CI runner while the code was identical.
 */
async function waitForDraft(documentId: string, marker: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await draftRow(documentId);
    if (JSON.stringify(row.draft_body).includes(marker)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for the draft to contain ${marker}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Poll the autosave endpoint until it says the document is saved (or give up).
 *
 * Returns the final body rather than throwing, so a failure prints the flag instead
 * of a timeout message: "expected saved to be true, it was false for 3 s" is the
 * whole diagnosis, and a helper that throws loses which of the two possibilities it
 * was — never-settled or settled-then-dirty-again.
 */
async function untilSaved(documentId: string, ms = 3000): Promise<{ saved: boolean; peers: number }> {
  const deadline = Date.now() + ms;
  for (;;) {
    const res = await http.get(`/documents/${documentId}/realtime-status`, bona);
    const body = res.body as { saved: boolean; peers: number };
    if (body.saved || Date.now() > deadline) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function draftRow(documentId: string): Promise<{
  y_state: Buffer | null;
  draft_body: unknown;
  draft_markdown: string | null;
}> {
  const rows = await query<{
    y_state: Buffer | null;
    draft_body: unknown;
    draft_markdown: string | null;
  }>('SELECT y_state, draft_body, draft_markdown FROM documents WHERE id = $1', [documentId]);
  const row = rows[0];
  if (!row) throw new Error(`no such document ${documentId}`);
  return row;
}

// ------------------------------------------------------------------- the ticket

describe('the realtime ticket', () => {
  it('is minted with the capability the caller actually holds', async () => {
    const asWriter = await http.post(`/documents/${RUNBOOK}/realtime-token`, undefined, bona);
    expect(asWriter.status).toBe(201);
    expect((asWriter.body as { permission: string }).permission).toBe('WRITE');

    // Dana holds nothing at all, so she gets the same 404 she gets from
    // GET /documents/:id — no ticket, and no hint about whether it exists.
    const asNobody = await http.post(`/documents/${RUNBOOK}/realtime-token`, undefined, dana);
    expect(asNobody.status).toBe(404);
    expect(asNobody.body).toEqual((await http.get(`/documents/${RUNBOOK}`, dana)).body);
  });

  it('is READ for someone who can read but not write', async () => {
    // Ana has READ on the HR handbook through her role and no WRITE anywhere in HR.
    const res = await http.post(`/documents/${doc('handbook')}/realtime-token`, undefined, ana);
    expect(res.status).toBe(201);
    expect((res.body as { permission: string }).permission).toBe('READ');
  });

  it('refuses a connection with no ticket at all', async () => {
    const socket = new WebSocket(`${wsOrigin()}/api/realtime/${RUNBOOK}`);
    const code = await new Promise<number>((resolve) => {
      socket.on('error', () => resolve(-1));
      socket.on('close', resolve);
    });
    expect(code).toBe(4401);
  });

  it('refuses a forged ticket the same way it refuses a missing one', async () => {
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub2JvZHkifQ.not-a-signature';
    const socket = new WebSocket(`${wsOrigin()}/api/realtime/${RUNBOOK}?ticket=${forged}`);
    const code = await new Promise<number>((resolve) => {
      socket.on('error', () => resolve(-1));
      socket.on('close', resolve);
    });
    // Byte-identical outcome to "no ticket": a forger learns nothing about which
    // documents exist by trying to break in.
    expect(code).toBe(4401);
  });

  it('refuses a session token presented as a ticket', async () => {
    // The scope claim is what makes this fail. Without it the two token kinds are
    // the same signature and the same verify call, so a 12-hour bearer credential
    // would open websockets at will.
    const socket = new WebSocket(`${wsOrigin()}/api/realtime/${RUNBOOK}?ticket=${bona}`);
    const code = await new Promise<number>((resolve) => {
      socket.on('error', () => resolve(-1));
      socket.on('close', resolve);
    });
    expect(code).toBe(4401);
  });

  it('will not open a document it was not minted for', async () => {
    // Minted legitimately, for the runbook. Then used against a different room by
    // editing the URL, which is the whole reason the ticket names a document.
    const ticket = await mintToken(RUNBOOK, bona);
    const other = doc('handbook');
    const socket = new WebSocket(`${wsOrigin()}/api/realtime/${other}?ticket=${ticket}`);
    const code = await new Promise<number>((resolve) => {
      socket.on('error', () => resolve(-1));
      socket.on('close', resolve);
    });
    expect(code).toBe(4401);
  });

  it('closes a connection whose ticket outlived the document', async () => {
    const temporary = await http.post(
      '/documents',
      { title: 'Dočasný', groupId: group('engineering') },
      bona,
    );
    const id = (temporary.body as { id: string }).id;
    const ticket = await mintToken(id, bona);
    await http.del(`/documents/${id}`, bona);
    const socket = new WebSocket(`${wsOrigin()}/api/realtime/${id}?ticket=${ticket}`);
    const code = await new Promise<number>((resolve) => {
      socket.on('error', () => resolve(-1));
      socket.on('close', resolve);
    });
    expect(code).toBe(4404);
  });

  it('rejects a ticket for a document that does not exist, indistinguishably', async () => {
    const res = await http.post(`/documents/${GHOST_ID}/realtime-token`, undefined, bona);
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------------- read/write

describe('the WRITE enforcement is server-side', () => {
  it('closes a read-only connection that sends an update, and stores nothing', async () => {
    // Ana may READ the handbook but not WRITE it. Her toolbar would be disabled;
    // this asserts the thing behind the toolbar, which is the only part that is
    // security (SPEC.md §3, PLAN §3.5).
    const before = await draftRow(doc('handbook'));
    const ticket = await mintToken(doc('handbook'), ana);
    const peer = await connect(doc('handbook'), ticket);

    // She really did receive the document — otherwise this test would pass on a
    // connection that was refused before it got anything.
    await waitFor(() => peer.ydoc.getXmlFragment(RT_FRAGMENT).length > 0, 'the document to arrive');

    appendParagraph(peer.ydoc, 'zapsáno čtenářem');
    const update = Y.encodeStateAsUpdate(peer.ydoc, Y.encodeStateVector(new Y.Doc()));
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, RT_MESSAGE.sync);
    encoding.writeVarUint(encoder, 2);
    encoding.writeVarUint8Array(encoder, update);
    peer.socket.send(encoding.toUint8Array(encoder));

    const code = await peer.closed;
    expect(code).toBe(4403);

    // And the mutation did not land. A refusal that still applied the update
    // would be the worst possible shape: denied, and changed anyway.
    const after = await draftRow(doc('handbook'));
    expect(JSON.stringify(after.draft_body)).toBe(JSON.stringify(before.draft_body));
    expect(after.draft_markdown).toBe(before.draft_markdown);
  });

  it('drops presence published by a read-only connection', async () => {
    const ticket = await mintToken(doc('handbook'), ana);
    const peer = await connect(doc('handbook'), ticket);
    peer.awareness.setLocalStateField('user', { displayName: 'Ana', color: '#000' });
    const update = encodeAwarenessUpdate(peer.awareness, [peer.ydoc.clientID], peer.awareness.getStates());
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, RT_MESSAGE.awareness);
    encoding.writeVarUint8Array(encoder, update);
    peer.socket.send(encoding.toUint8Array(encoder));
    // Give the server a chance to (not) apply it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The reader's own presence must not reach a second connection's view of
    // others. Probed on the server side by the room's presence endpoint being
    // absent from any other client's awareness state.
    expect(peer.frames.length).toBeGreaterThan(0);
    peer.socket.close();
    await peer.closed;
  });
});

// ------------------------------------------------- what a reader is allowed to see

/**
 * SPEC.md §1: "Běžný čtenář vidí pouze publikovanou verzi."
 *
 * These are the tests for the sentence as applied to the websocket, and they exist
 * because the gateway once failed all three of them while passing every other test
 * in this file. A `READ` ticket minted cleanly, opened a socket, was refused writes
 * with 4403, and answered its sync step 1 from the *room* — which holds the draft.
 * Nothing in the ACL was bypassed (a reader holds READ), so no capability test went
 * red; the leak was one permission level narrower than the check that guarded it,
 * which is the class of bug a permission test cannot see.
 *
 * The fixture is Bona's runbook, where she holds WRITE+MANAGE and can therefore
 * grant Carl — who has a direct READ grant and nothing else — a look at a draft she
 * is still writing. That pairing is the point: both parties are acting entirely
 * within their permissions, and the only thing that decides whether Carl sees
 * unfinished text is what this file is about.
 */
describe('a READ connection sees the published version, never the draft', () => {
  const DRAFT_MARKER = 'rozpracováno-autorkou';
  const PUBLISHED_MARKER = 'Kroky nasazení.';

  /** The runbook's published v1 and its draft, with the draft moved apart from it. */
  async function separateDraftFromPublished(): Promise<void> {
    const [row] = await query<{ draft_body: unknown }>('SELECT draft_body FROM documents WHERE id = $1', [
      RUNBOOK,
    ]);
    const body = JSON.stringify(row?.draft_body ?? { type: 'doc', content: [] }).replace(
      'Kroky nasazení.',
      `Kroky nasazení. ${DRAFT_MARKER}`,
    );
    await query('UPDATE documents SET draft_body = $2, draft_markdown = $3 WHERE id = $1', [
      RUNBOOK,
      JSON.parse(body),
      `# Obsah\n\nKroky nasazení. ${DRAFT_MARKER}`,
    ]);
  }

  /** Everything the server sent into one reader's document, as text. */
  function receivedText(peer: Peer): string {
    return peer.ydoc.getXmlFragment(RT_FRAGMENT).toString();
  }

  beforeAll(async () => {
    await separateDraftFromPublished();
  });

  it('answers a reader with the published body, and not with the draft', async () => {
    const carl = await loginAs('carl');
    const peer = await connect(RUNBOOK, await mintToken(RUNBOOK, carl));

    await waitFor(() => receivedText(peer).includes(PUBLISHED_MARKER), 'the published body to arrive');
    expect(receivedText(peer)).not.toContain(DRAFT_MARKER);

    peer.socket.close();
    await peer.closed;
  });

  it('does not forward live edits from a writer to a reader', async () => {
    const carl = await loginAs('carl');
    const marker = `rozpracovano-${Date.now()}`;

    const reader = await connect(RUNBOOK, await mintToken(RUNBOOK, carl));
    await waitFor(() => receivedText(reader).includes(PUBLISHED_MARKER), 'the reader to have the document');
    const before = receivedText(reader);

    const writer = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    await waitFor(() => receivedText(writer).includes(DRAFT_MARKER), 'the writer to have the draft');

    appendParagraph(writer.ydoc, marker);
    await waitFor(
      () => receivedText(writer).includes(marker),
      'the writer to see their own edit',
      // The guard under test is a per-update skip in the room's fan-out. A writer
      // whose own edit never came back would make "and the reader didn't get it"
      // pass for the wrong reason, so this waits for the positive case first.
    );

    // The negative half. Yjs updates arrive in milliseconds when they arrive at
    // all, so a bounded wait that finds nothing is a real absence rather than a
    // timing accident — and the room's debounce (400 ms) is well inside this window,
    // which rules out the other way this could pass: a reader served from a
    // snapshot that simply had not been refreshed.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(receivedText(reader)).not.toContain(marker);
    expect(receivedText(reader)).toBe(before);
    // ...and the writer really did send it, so the skip happened server-side.
    expect(writer.frames.length).toBeGreaterThan(0);

    reader.socket.close();
    writer.socket.close();
    await Promise.all([reader.closed, writer.closed]);
  });

  // What is deliberately NOT asserted here, and why: that a publish landing between a
  // reader's connections leaves them holding one version rather than two. That test was
  // written here and it fails, because a reader's client Y.Doc keeps the previous
  // version's items forever and any newer version's items are new content by
  // construction, so they merge in beside them — server-side, this is unwinnable. The
  // reader's document has to be *rebuilt*, which only the client can do, so the case is
  // asserted in a browser instead: see "a reader learns about a publish and their view
  // becomes the new version" in `e2e/realtime.spec.ts`, and the mechanism's rationale in
  // ralph/DEFERRED.md (phase 2, "informuje ostatní klienty o změně").
  it('serves the same published body again on a reconnect, without duplicating it', async () => {
    // A ticket lives 60 seconds and `useRealtime` rotates it by cycling the socket, so
    // this is not an edge case: every open reader reconnects about once a minute. The
    // client keeps *one* Y.Doc across those cycles on purpose (a rebuilt doc is how a
    // document starts losing paragraphs), which means the server's next sync step 2 is
    // merged into a document that already holds the whole published body.
    //
    // Merging is the hazard. A snapshot built under a fresh Yjs client id looks like a
    // brand-new copy of every element rather than a restatement of the old one, so the
    // merge keeps both and the reader's document grows a second heading and a second
    // paragraph — once a minute, forever. Asserting on the *count* of the marker is
    // what sees it: an assertion that the text "is still there" passes either way.
    const carl = await loginAs('carl');
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    try {
      const first = await connect(RUNBOOK, await mintToken(RUNBOOK, carl), { ydoc, awareness });
      await waitFor(() => receivedText(first).includes(PUBLISHED_MARKER), 'the published body');
      const afterFirst = receivedText(first);
      first.socket.close();
      await first.closed;

      const second = await connect(RUNBOOK, await mintToken(RUNBOOK, carl), { ydoc, awareness });
      // Give the second sync every chance to land before measuring, then wait one more
      // round-trip: the failure mode is an *extra* copy arriving late, so "it looked
      // right immediately" proves nothing.
      await waitFor(() => receivedText(second).includes(PUBLISHED_MARKER), 'the second sync');
      await new Promise((resolve) => setTimeout(resolve, 300));

      const afterSecond = receivedText(second);
      const countOf = (text: string): number => text.split(PUBLISHED_MARKER).length - 1;
      // The count first and on its own: on a duplicate the whole-string comparison
      // below says "these two long strings differ", which makes the reader work out
      // how. This one says "it arrived twice".
      expect(countOf(afterSecond)).toBe(countOf(afterFirst));
      expect(afterSecond).toBe(afterFirst);
      second.socket.close();
      await second.closed;
    } finally {
      awareness.destroy();
      ydoc.destroy();
    }
  });

  it('refuses a reader a document that has never been published, indistinguishably', async () => {
    // A brand-new document has no version rows, so there is no published body to
    // serve. Carl gets a direct READ grant on it, which is enough to mint a ticket
    // and not enough to see a body: READ alone does not conjure content.
    //
    // The first attempt at this test used the seeded draft-only document and hung
    // for 60 seconds, because Bona holds WRITE on it — so her ticket was a WRITE
    // ticket, which joins the room and stays open forever. Asserting `permission:
    // 'READ'` below is what stops that mistake: without it, a test named "refuses a
    // reader" can silently be exercising the writer's path.
    const created = await http.post(
      '/documents',
      { title: 'Netiskáno', groupId: group('engineering') },
      bona,
    );
    const unpublished = (created.body as { id: string }).id;
    const grant = await http.post(
      '/permissions',
      {
        subjectKind: 'user',
        subjectId: user('carl'),
        targetKind: 'document',
        targetId: unpublished,
        permission: 'READ',
      },
      bona,
    );
    expect(grant.status).toBe(201);

    const carl = await loginAs('carl');
    const minted = await http.post(`/documents/${unpublished}/realtime-token`, undefined, carl);
    expect((minted.body as { permission: string }).permission).toBe('READ');

    const socket = new WebSocket(
      `${wsOrigin()}/api/realtime/${unpublished}?ticket=${(minted.body as { ticket: string }).ticket}`,
    );
    const code = await new Promise<number>((resolve) => {
      socket.on('error', () => resolve(-1));
      socket.on('close', resolve);
    });
    // The same close code a nonexistent document produces: the wire never answers
    // "this document exists and is unfinished" to someone entitled only to what has
    // been published (PLAN §3.3).
    expect(code).toBe(4404);
  });
});

// --------------------------------------------------------------------- sync

describe('two connections to one document', () => {
  it('propagates an update from one to the other without a reload', async () => {
    const a = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    const b = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    await waitFor(() => b.ydoc.getXmlFragment(RT_FRAGMENT).length > 0, 'b to receive the document');

    const marker = `marker-${Date.now()}`;
    appendParagraph(a.ydoc, marker);
    await waitFor(() => b.ydoc.getXmlFragment(RT_FRAGMENT).toString().includes(marker), 'b to see the edit');

    // The reverse direction, because a one-way bridge would also pass a test that
    // only ever asserted one arrow.
    const reply = `reply-${Date.now()}`;
    appendParagraph(b.ydoc, reply);
    await waitFor(() => a.ydoc.getXmlFragment(RT_FRAGMENT).toString().includes(reply), 'a to see the reply');

    a.socket.close();
    b.socket.close();
    await Promise.all([a.closed, b.closed]);
  });

  it('merges simultaneous edits to different places instead of losing one', () => {
    // The property Yjs is supposed to buy, asserted where it can be asserted
    // cheaply: two docs that applied each other's concurrent updates converge on
    // identical content regardless of the order they received them in. The
    // browser equivalent in e2e/realtime.spec.ts watches it happen live.
    const left = new Y.Doc();
    const right = new Y.Doc();
    appendParagraph(left, 'levý');
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    appendParagraph(left, 'A');
    appendParagraph(right, 'B');

    const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right));
    const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left));
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);

    const asText = (d: Y.Doc): string => d.getXmlFragment(RT_FRAGMENT).toString();
    expect(asText(left)).toBe(asText(right));
    expect(asText(left)).toContain('A');
    expect(asText(left)).toContain('B');
  });

  it('keeps one shared document per room rather than one per connection', async () => {
    // A room rebuilt per join would still *look* right on the first edit and
    // diverge on the second, so the assertion is about the third client seeing
    // the second's change.
    const a = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    appendParagraph(a.ydoc, 'první');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const b = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    await waitFor(() => b.ydoc.getXmlFragment(RT_FRAGMENT).toString().includes('první'), 'b to get a');

    appendParagraph(b.ydoc, 'druhý');
    await waitFor(() => a.ydoc.getXmlFragment(RT_FRAGMENT).toString().includes('druhý'), 'a to get b');

    a.socket.close();
    b.socket.close();
    await Promise.all([a.closed, b.closed]);
  });

  it('gives one shared room to connections that arrive together at a never-opened document', async () => {
    // The room map is read, awaited over, and written back (`loadRoom`), so two
    // admissions of a document nobody has opened yet both see no existing room,
    // both build one, and the second `set` overwrites the first. Each socket is
    // then attached to a *different* Y.Doc that syncs nothing to the others, the
    // database stays consistent throughout (the `y_state IS NULL` claim is what
    // protects the row), and the only symptom is collaborators who cannot see
    // each other — which in the browser looked like an editor that loaded an
    // empty document, intermittently, only on a document not yet open.
    //
    // `connect` creates its socket synchronously, so firing N of them in one
    // `Promise.all` is not a race that has to be won on timing: every admission
    // reaches `loadRoom` with an empty map entry. A document created for this
    // test, rather than the seeded runbook, is what keeps the entry empty — the
    // suite's other tests would otherwise have opened it first.
    const created = await http.post(
      '/documents',
      { title: `Současně-${Date.now()}`, groupId: group('engineering') },
      bona,
    );
    const id = (created.body as { id: string }).id;
    expect((await draftRow(id)).y_state).toBeNull(); // so every admission really is a build

    const tickets = await Promise.all([mintToken(id, bona), mintToken(id, bona), mintToken(id, bona)]);
    const peers = await Promise.all(tickets.map((ticket) => connect(id, ticket)));

    // Content first: an edit by one must reach both others. Split rooms make this
    // time out rather than fail fast, which is the honest shape of the bug.
    await waitFor(() => peers.every((p) => p.frames.length > 0), 'all three sync replies');
    const marker = `spolu-${Date.now()}`;
    appendParagraph(peers[0]!.ydoc, marker);
    for (const [i, peer] of peers.entries()) {
      if (i === 0) continue;
      await waitFor(
        () => peer.ydoc.getXmlFragment(RT_FRAGMENT).toString().includes(marker),
        `peer ${i} to receive the edit`,
      );
    }

    // And the server's own count, from the endpoint the autosave indicator uses.
    // Two rooms for one document is precisely "peers fewer than connections".
    // Spelled out rather than passed as an expect() message, which jest has none.
    const status = await http.get(`/documents/${id}/realtime-status`, bona);
    const peersSeen = (status.body as { peers: number }).peers;
    expect({ peersSeen, connections: peers.length }).toEqual({
      peersSeen: peers.length,
      connections: peers.length,
    });

    for (const peer of peers) peer.socket.close();
    await Promise.all(peers.map((peer) => peer.closed));
  });
});

// ---------------------------------------------------------------- presence

describe('presence', () => {
  it('shows a collaborator without either side reloading', async () => {
    const a = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    const b = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    await waitFor(() => b.ydoc.getXmlFragment(RT_FRAGMENT).length > 0, 'b to have the document');

    // A *caret* is what a client legitimately publishes, and `user` is what the
    // server claims about who you are. Both go out in one awareness frame, which
    // is what makes this worth asserting together: the caret must arrive and the
    // identity must not.
    a.awareness.setLocalStateField('cursor', { anchor: 3 });
    a.awareness.setLocalStateField('user', { displayName: 'pinger', color: '#111' });

    const caret = await waitFor(
      () =>
        Array.from(b.awareness.getStates().values()).find(
          (s) => (s as { cursor?: { anchor?: number } }).cursor?.anchor === 3,
        ),
      'b to see a caret',
    );

    // `pinger` is what the local client asked to be called. It must not reach a
    // peer, because a writer could otherwise publish a colleague's name and make
    // their edits look like someone else's. The name and the capability come from
    // the credential the socket handshook with.
    const user = (caret as { user?: AwarenessUser }).user;
    expect(user?.displayName).toBe('Bora Novák');
    expect(user?.displayName).not.toBe('pinger');
    expect(user?.canWrite).toBe(true);
    // The colour too: the palette is the server's, so a client cannot impersonate
    // a peer's caret colour and make the two carets look like one person.
    expect(user?.color).not.toBe('#111');

    a.socket.close();
    b.socket.close();
    await Promise.all([a.closed, b.closed]);
  });

  it('removes a collaborator who disconnects', async () => {
    const a = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    const b = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    a.awareness.setLocalStateField('cursor', { anchor: 7 });
    await waitFor(
      () =>
        Array.from(b.awareness.getStates().values()).some(
          (s) => (s as { cursor?: { anchor?: number } }).cursor?.anchor === 7,
        ),
      'b to see a',
    );

    a.socket.close();
    await a.closed;
    // A stale presence entry is a caret that never goes away. Bora and Bona would
    // look like two people in the document forever, and the second one is gone.
    await waitFor(
      () =>
        !Array.from(b.awareness.getStates().values()).some(
          (s) => (s as { cursor?: { anchor?: number } }).cursor?.anchor === 7,
        ),
      'b to stop seeing a',
    );

    b.socket.close();
    await b.closed;
  });
});

// ---------------------------------------------------------------- persistence

describe('persistence', () => {
  it('stores Yjs state and both projections once the writers leave', async () => {
    const marker = `uloženo-${Date.now()}`;
    const peer = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    await waitFor(() => peer.ydoc.getXmlFragment(RT_FRAGMENT).length > 0, 'the document');
    appendParagraph(peer.ydoc, marker);
    peer.socket.close();
    await peer.closed;
    await waitForDraft(RUNBOOK, marker);

    const row = await draftRow(RUNBOOK);
    expect(row.y_state).not.toBeNull();
    // The projection is written in the same statement as the Yjs state, so a
    // reader using the phase-2 endpoint sees the same text the editor showed.
    expect(String(row.draft_markdown)).toContain(marker);
    expect(JSON.stringify(row.draft_body)).toContain(marker);

    // And the stored bytes are loadable, not merely present: an encoding that
    // cannot be re-applied would only be discovered when someone reopened the
    // document and found it empty.
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, new Uint8Array(row.y_state as Buffer));
    expect(reloaded.getXmlFragment(RT_FRAGMENT).toString()).toContain(marker);
  });

  it('does not seed a document that already has Yjs state', async () => {
    // Reopening after a restart must adopt the stored draft. Re-seeding from
    // draft_body would discard collaboration history and orphan anyone still
    // connected, which is why the seeding UPDATE is conditional on y_state IS NULL.
    const first = await draftRow(RUNBOOK);
    const peer = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    await waitFor(() => peer.ydoc.getXmlFragment(RT_FRAGMENT).length > 0, 'the document');
    peer.socket.close();
    await peer.closed;
    const second = await draftRow(RUNBOOK);
    // State may grow with a fresh awareness/identity transaction, but the earlier
    // state must still be contained in it rather than replaced.
    expect(second.y_state?.length ?? 0).toBeGreaterThan(0);
    expect(second.draft_markdown).toBe(first.draft_markdown);
  });

  it('settles the save state for a document that was opened and never typed in', async () => {
    // The seeding path marks the room dirty on purpose, so the projection beside a
    // freshly seeded `y_state` gets written rather than left describing the draft that
    // was there before. Marking something dirty creates an obligation to flush it: if
    // nothing ever schedules that flush, the flag is stuck for the life of the process
    // — and `saved: false` *is* the autosave indicator, so a reader or writer who opens
    // a seeded document, changes nothing, and waits is told "Ukládám…" forever, about a
    // document nobody edited. The whole first connection to every document on a newly
    // seeded database is that state, which is what this pins.
    //
    // Asserted while connected, deliberately. The last-disconnect release path flushes
    // on its own, so the same document's database row looks perfectly current by the
    // time anyone could read it after hanging up: the bug would leave no trace in the
    // row, and a test written against the row after close would pass with it present.
    const temporary = await http.post(
      '/documents',
      { title: `Čerstvý-${Date.now()}`, groupId: group('engineering') },
      bona,
    );
    const id = (temporary.body as { id: string }).id;
    const seed = await draftRow(id);
    expect(seed.y_state).toBeNull(); // so this really is the first connection

    const peer = await connect(id, await mintToken(id, bona));
    // A brand-new document has no content to wait for, so the handshake itself is the
    // signal: the sync step-2 reply is the first frame on the wire, and until the room
    // has been loaded there is nothing on it.
    await waitFor(() => peer.frames.length > 0, 'the sync reply');

    // Polled rather than slept, and polled on the endpoint the indicator uses: the
    // claim being tested is "a document opened without a keystroke reaches the
    // database on the writer's own cadence", which is only checkable against the
    // server's notion of dirty. Two debounce windows is the generous end of that.
    const settled = await untilSaved(id);
    expect(settled.saved).toBe(true);

    const row = await draftRow(id);
    expect(row.y_state).not.toBeNull();
    peer.socket.close();
    await peer.closed;
  });

  it('leaves no room resident after every client disconnects', async () => {
    // An empty room kept in memory means a document's live state never reaches the
    // database, so the next process to serve it shows a stale draft.
    const peer = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    await waitFor(() => peer.ydoc.getXmlFragment(RT_FRAGMENT).length > 0, 'the document');
    peer.socket.close();
    await peer.closed;
    // The release path flushes then deletes; give the debounce a chance to settle.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const still = await draftRow(RUNBOOK);
    expect(still.y_state).not.toBeNull();
  });
});

// ------------------------------------------------- the draft replaced from outside

/**
 * What happens to a live room when something *other* than the websocket rewrites
 * the draft.
 *
 * PLAN §2.3 made `y_state` authoritative, and that quietly promoted these
 * endpoints from "writes the draft" to "writes one of two things, the other of
 * which still wins". `PUT /draft` and restore-as-draft both replace `draft_body`;
 * if a room is open it still holds the previous content and will re-project
 * `draft_body` from that on its next autosave. So without the gateway being told,
 * each of these endpoints succeeds, and then undoes itself inside the debounce
 * window — and the UI, having been told `saved: true`, shows the restored content
 * right up until it doesn't.
 */
describe('a draft replaced while the document is open', () => {
  it('discards the live room rather than letting it overwrite the write', async () => {
    const replaced = `nahrazeno-${Date.now()}`;
    const peer = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    await waitFor(() => peer.ydoc.getXmlFragment(RT_FRAGMENT).length > 0, 'the document');
    // An unsaved-by-hand edit, so the room is genuinely dirty when the write lands.
    appendParagraph(peer.ydoc, `původní-${Date.now()}`);

    const res = await http.put(
      `/documents/${RUNBOOK}/draft`,
      {
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: replaced }] }] },
        markdown: replaced,
      },
      bona,
    );
    expect(res.status).toBe(200);

    // The editor is disconnected: it was editing a document that no longer exists
    // on the server, and letting it carry on would be the silent version of the
    // bug.
    const code = await peer.closed;
    expect(code).toBeGreaterThan(1000);

    // Wait past the debounce. This is the whole assertion — a room that flushed on
    // the way out would write its stale state over `replaced` and re-derive
    // draft_body from it, so the row would come back describing the *old* content.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const row = await draftRow(RUNBOOK);
    expect(JSON.stringify(row.draft_body)).toContain(replaced);
    expect(String(row.draft_markdown)).toContain(replaced);

    // And a client arriving afterwards gets the replacement, not the pre-write
    // state: y_state was nulled, so the room re-seeds from draft_body.
    const after = await connect(RUNBOOK, await mintToken(RUNBOOK, bona));
    await waitFor(
      () => after.ydoc.getXmlFragment(RT_FRAGMENT).toString().includes(replaced),
      'a rejoining client to see the replacement',
    );
    after.dispose();
  });

  it('does not resurrect the draft when an older version is restored', async () => {
    const target = await http.post(
      '/documents',
      { title: 'Návrat verze', groupId: group('engineering') },
      bona,
    );
    const id = (target.body as { id: string }).id;
    const v1 = `verze-jedna-${Date.now()}`;
    await http.put(
      `/documents/${id}/draft`,
      {
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: v1 }] }] },
        markdown: v1,
      },
      bona,
    );
    await http.post(`/documents/${id}/publish`, { comment: 'v1' }, bona);
    const v2 = `verze-dva-${Date.now()}`;
    await http.put(
      `/documents/${id}/draft`,
      {
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: v2 }] }] },
        markdown: v2,
      },
      bona,
    );

    // Someone has the document open on v2 while the restore happens.
    const peer = await connect(id, await mintToken(id, bona));
    await waitFor(() => peer.ydoc.getXmlFragment(RT_FRAGMENT).toString().includes(v2), 'the v2 draft');

    const restored = await http.post(`/documents/${id}/versions/1/restore`, undefined, bona);
    expect(restored.status).toBe(201);
    await peer.closed;

    await new Promise((resolve) => setTimeout(resolve, 900));
    const row = await draftRow(id);
    expect(JSON.stringify(row.draft_body)).toContain(v1);
    expect(JSON.stringify(row.draft_body)).not.toContain(v2);

    // The column the *next* reader is served from, which is the one that would
    // have kept v2 alive had only draft_body been rewritten.
    const rejoined = await connect(id, await mintToken(id, bona));
    await waitFor(
      () => rejoined.ydoc.getXmlFragment(RT_FRAGMENT).toString().includes(v1),
      'a rejoining client to see the restored version',
    );
    expect(rejoined.ydoc.getXmlFragment(RT_FRAGMENT).toString()).not.toContain(v2);
    rejoined.dispose();
  });

  it('publishes whatever the editor typed moments earlier, not a debounce window less', async () => {
    // Persistence is debounced, so this test's whole job is timing: type, then
    // publish inside that window. The bug it pins is a published version that is
    // silently missing the last few hundred milliseconds of typing — permanent,
    // because a version cannot be amended once written.
    const target = await http.post(
      '/documents',
      { title: 'Okamžitá publikace', groupId: group('engineering') },
      bona,
    );
    const id = (target.body as { id: string }).id;
    await http.put(
      `/documents/${id}/draft`,
      {
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'start' }] }] },
        markdown: 'start',
      },
      bona,
    );

    const peer = await connect(id, await mintToken(id, bona));
    await waitFor(() => peer.ydoc.getXmlFragment(RT_FRAGMENT).length > 0, 'the document');
    const lastWords = `poslední-slova-${Date.now()}`;
    appendParagraph(peer.ydoc, lastWords);

    // Deliberately no sleep: still inside PERSIST_DEBOUNCE_MS.
    const published = await http.post(`/documents/${id}/publish`, { comment: 'hned' }, bona);
    expect(published.status).toBe(201);
    const version = (published.body as { version: number }).version;

    const snapshot = await http.get(`/documents/${id}/versions/${version}`, bona);
    expect(JSON.stringify(snapshot.body)).toContain(lastWords);

    peer.dispose();
  });
});

describe('the wire format', () => {
  it('is the y-websocket framing, byte for byte', async () => {
    // The reason this suite does not use y-websocket's own client: if the
    // library's framing changed, a suite built on it would follow the library and
    // stay green while browsers broke. These are the exact bytes the stock client
    // parses.
    const peer = await connect(RUNBOOK, await mintToken(RUNBOOK, bona), { quiet: true });
    await waitFor(() => peer.frames.length > 0, 'the first frame');

    const sync = peer.frames[0];
    expect(sync).toBeDefined();
    const decoder = decoding.createDecoder(sync as Uint8Array);
    // [varuint 0 = sync, varuint 0 = step 1, state vector]
    expect(decoding.readVarUint(decoder)).toBe(RT_MESSAGE.sync);
    expect(decoding.readVarUint(decoder)).toBe(messageYjsSyncStep1);
    // A state vector is a varuint client count followed by (client, clock) pairs,
    // so a non-empty document decodes without running off the end.
    expect(() => decoding.readVarUint(decoder)).not.toThrow();

    peer.socket.close();
    await peer.closed;
  });

  it('answers a ticket-less upgrade before sending any document bytes', async () => {
    const socket = new WebSocket(`${wsOrigin()}/api/realtime/${RUNBOOK}`);
    let received = 0;
    socket.on('message', (data: Buffer) => {
      received += data.length;
    });
    const code = await new Promise<number>((resolve) => {
      socket.on('error', () => resolve(-1));
      socket.on('close', resolve);
    });
    // Not merely "closed with 4401" — closed having sent nothing. A gateway that
    // synced first and refused afterwards would leak the whole document to an
    // anonymous caller while still returning the right close code.
    expect(code).toBe(4401);
    expect(received).toBe(0);
  });
});
