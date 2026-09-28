import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {
  readSyncMessage,
  writeSyncStep1,
  messageYjsSyncStep1,
  messageYjsUpdate,
} from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { RT_MESSAGE, type AwarenessUser } from '@kachnadocs/shared';
import { query } from '../db';
import { encodeYDoc, loadYDoc, seedYDocFromPmJson } from './draft-document';
import type { RealtimeTickets } from './realtime-tickets';
import type { DraftProjector } from './draft-projector';

/**
 * The y-websocket server (SPEC.md §2 realtime, PLAN §1).
 *
 * A custom gateway around y-websocket's wire protocol rather than
 * `y-websocket/bin/server`, for one reason: authorisation. y-websocket's own
 * server takes a room name off the query string and admits anyone who asks, and
 * PLAN §3.2 names "Yjs websocket join" as a path that must filter in the database
 * while SPEC.md:93 says a user without READ must not obtain content over the
 * websocket either. y-websocket 2.x exposes `beforeHandleMessage` but no way to
 * say "this connection may receive updates but may never send them", which is
 * exactly the READ/WRITE split SPEC.md §2 asks for — and enforcing read-only by
 * pattern-matching binary message types would be a security boundary drawn by
 * someone guessing at framing.
 *
 * So: y-protocols for framing (the same library y-websocket uses, so the official
 * browser client connects unmodified), `ws` for the socket, and the ACL decided
 * here with the same SQL function every HTTP route uses. y-websocket 3.x deleted
 * its Node server entirely, so the protocol is implemented from y-protocols on
 * both sides and pinned by `realtime.e2e-spec.ts` speaking it with a raw `ws`
 * client — that pin matters, because a test that used the library on both sides
 * would keep passing if framing changed while real browsers broke.
 *
 * ## The credential
 *
 * A browser cannot set a header on a websocket, so the ticket arrives as a query
 * parameter. That is why it is a 60-second single-document single-capability
 * credential rather than the session JWT; see `realtime-tickets.ts`. It is
 * verified once at the handshake and the claims are pinned to the socket, and
 * every later message re-checks `claims.rt === room.documentId`, so a ticket
 * minted for document A cannot join room B by editing the URL — the socket is
 * closed rather than admitted to a room it was never issued for.
 *
 * ## One shared Y.Doc per document, outliving its connections
 *
 * The room map is keyed by document id and its entries survive every disconnect.
 * That is what "concurrent edits must not clobber each other" means
 * operationally: two clients editing the same document meet in the *same* Y.Doc on
 * the server, so updates merge by CRDT instead of last-writer-wins. Rebuilding a
 * room from the database per join, or sharing one doc between two documents, would
 * make clients diverge — and the divergence would present as a lost keystroke
 * rather than as a bug. A room is dropped only after its last socket closed AND
 * its state flushed, so nobody can join a half-written document.
 *
 * ## Presence
 *
 * Every connection in a room receives the room's full presence list, because
 * SPEC.md §2 asks readers to see other users' cursors and selections and a caret
 * cannot be drawn without it. What is *not* delegated to clients is identity: the
 * `user` field of every awareness record is overwritten from the verified
 * credential on the way out, so a writer cannot publish a colleague's name and
 * make their edits look like someone else's. Inbound awareness from a READ-only
 * connection is dropped, so a reader sees presence but publishes none.
 */

/** Caret colours, assigned per connection: two tabs of one person are two carets. */
const PALETTE = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

/**
 * How long to hold a dirty room before writing it. Long enough that a burst of
 * typing becomes one write; short enough that a closed laptop loses a word rather
 * than a paragraph. Not a tuned number — see `writeRoom` for why per-keystroke
 * persistence is the thing being avoided.
 */
const PERSIST_DEBOUNCE_MS = 400;

/** Close codes in the websocket private range, so clients can branch on them. */
const CLOSE = {
  badFrame: 4400,
  unauthorized: 4401,
  notFound: 4404,
  readOnly: 4403,
} as const;

interface Socket extends WebSocket {
  claims?: { sub: string; rt: string; perm: 'READ' | 'WRITE' };
  user?: AwarenessUser;
  /** The Yjs client id this socket publishes awareness under, once it has sent any. */
  clientId?: number;
  alive?: boolean;
}

interface Room {
  documentId: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  sockets: Set<Socket>;
  /** True when the stored draft is behind this room; drives the flush. */
  dirty: boolean;
  flush: ReturnType<typeof setTimeout> | null;
}

@Injectable()
export class RealtimeGateway implements OnModuleDestroy {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly rooms = new Map<string, Room>();
  private attached = false;
  private colourCursor = 0;

  constructor(
    private readonly tickets: RealtimeTickets,
    private readonly projector: DraftProjector,
  ) {}

  /**
   * Share the API's port.
   *
   * `noServer` plus a filtered upgrade handler rather than a second listening
   * port: the gate boots one process and Playwright reaches one origin, and a
   * second port would need its own lifecycle in `scripts/serve-e2e.mjs` plus its
   * own leftover-process hazard — the failure mode that already bit this project
   * once with a stale server holding :3100. Only `/api/realtime/:id` upgrades are
   * claimed, so an unrelated upgrade is left for someone else rather than being
   * answered here.
   */
  attach(server: Server): void {
    if (this.attached) return;
    this.attached = true;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? '';
      if (!url.startsWith('/api/realtime/')) return;
      const documentId = decodeURIComponent(pathAfter(url, '/api/realtime/'));
      this.wss.handleUpgrade(req, socket, head, (conn) => {
        void this.onConnection(conn as Socket, documentId, req);
      });
    });

    // Dead-connection detection. Without this, a client that vanishes (lid closed,
    // phone locked) never fires `close`, so its presence entry survives and — the
    // part that costs data — its room stays resident and dirty forever.
    const heartbeat = setInterval(() => {
      for (const room of this.rooms.values()) {
        for (const ws of room.sockets) {
          if (ws.alive === false) {
            ws.terminate();
            continue;
          }
          ws.alive = false;
          ws.ping();
        }
      }
    }, 15_000);
    heartbeat.unref?.();
  }

  /** Rooms held in memory. For the e2e suite's "no leaked rooms" assertion. */
  roomCount(): number {
    return this.rooms.size;
  }

  /** Connected users for a document — the presence list SPEC.md §2 asks for. */
  presenceFor(documentId: string): AwarenessUser[] {
    const room = this.rooms.get(documentId);
    if (!room) return [];
    const users: AwarenessUser[] = [];
    for (const ws of room.sockets) {
      if (ws.user) users.push(ws.user);
    }
    return users;
  }

  async onModuleDestroy(): Promise<void> {
    // Flush before the pool closes. Closing jest's server with a debounce pending
    // would drop the session's last edits, and the pool may already be gone by the
    // time the timer fires.
    for (const room of this.rooms.values()) {
      if (room.flush) clearTimeout(room.flush);
      room.flush = null;
      await this.writeRoom(room).catch(() => undefined);
    }
    for (const room of this.rooms.values()) this.destroyRoom(room);
    this.rooms.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  // ---------------------------------------------------------------- connections

  private async onConnection(conn: Socket, documentId: string, req: IncomingMessage): Promise<void> {
    const ticket = readTicket(req);
    const claim = ticket ? await this.tickets.verify(ticket) : null;
    // Missing, expired, a session token passed instead, or minted for another
    // document: all closed identically, before a byte of content leaves. The close
    // code says "re-authenticate", not which of those it was — "does this document
    // exist" is exactly what PLAN §3.3 refuses to answer.
    if (!claim || claim.rt !== documentId) {
      conn.close(CLOSE.unauthorized, 'unauthorized');
      return;
    }

    const room = await this.loadRoom(documentId);
    // The room is gone (deleted mid-flight) or its row is not readable. Same
    // close as the ticket failures, for the same reason.
    if (!room) {
      conn.close(CLOSE.notFound, 'not found');
      return;
    }

    const names = await query<{ display_name: string }>(
      'SELECT display_name FROM users WHERE id = $1',
      [claim.sub],
    );
    const displayName = names[0]?.display_name;
    if (!displayName) {
      conn.close(CLOSE.unauthorized, 'unauthorized');
      return;
    }

    conn.claims = claim;
    conn.user = {
      id: claim.sub,
      displayName,
      color: PALETTE[this.colourCursor % PALETTE.length] as string,
      canWrite: claim.perm === 'WRITE',
    };
    this.colourCursor += 1;
    conn.alive = true;

    room.sockets.add(conn);
    conn.on('pong', () => {
      conn.alive = true;
    });
    conn.on('message', (data: RawData) => {
      this.onMessage(room, conn, toBuffer(data));
    });
    conn.on('close', () => {
      room.sockets.delete(conn);
      // Only remove presence the socket actually published. A socket that never
      // sent an awareness frame never claimed a client id, and removing an
      // arbitrary id would delete somebody else's entry.
      if (conn.clientId !== undefined) {
        removeAwarenessStates(room.awareness, [conn.clientId], null);
      }
      this.broadcastAwareness(room);
      void this.releaseRoom(room);
    });
    conn.on('error', () => conn.close());

    // Sync step 1 first, then awareness. A client that learns about peers before it
    // has the document draws carets at offsets into an empty fragment, which is the
    // "remote cursor jumps to the top every reconnect" symptom.
    this.send(conn, (enc) => {
      encoding.writeVarUint(enc, RT_MESSAGE.sync);
      writeSyncStep1(enc, room.ydoc);
    });
    this.sendAwarenessTo(conn, room);
  }

  // --------------------------------------------------------------------- rooms

  /**
   * Load or create the shared document, seeding from `draft_body` at most once.
   *
   * The ACL question was answered when the ticket was minted, which is why no
   * actor appears in this query — see `documents.controller.ts` for the minting
   * path. What this query guards instead is that the row exists and is not
   * archived-out-from-under-us, and it is the *seeding* that needs care:
   *
   * `WHERE y_state IS NULL` is the concurrency argument. Two browsers opening a
   * never-edited document simultaneously both need a Y.Doc, and the one whose
   * conditional UPDATE wins is the seed that survives. Re-seeding a document that
   * already has state would discard live collaboration history and orphan every
   * connected client, so the write stays conditional rather than becoming an
   * upsert, and the loser re-reads and adopts the winner's bytes.
   */
  private async loadRoom(documentId: string): Promise<Room | null> {
    const existing = this.rooms.get(documentId);
    if (existing) return existing;

    const rows = await query<{ id: string; y_state: Buffer | null; draft_body: unknown }>(
      'SELECT id, y_state, draft_body FROM documents WHERE id = $1 LIMIT 1',
      [documentId],
    );
    const row = rows[0];
    if (!row) return null;

    let ydoc: Y.Doc;
    let dirty = false;
    if (row.y_state) {
      ydoc = loadYDoc(new Uint8Array(row.y_state));
    } else {
      ydoc = seedYDocFromPmJson(row.draft_body ?? { type: 'doc', content: [] });
      const claimed = await query<{ id: string }>(
        'UPDATE documents SET y_state = $2 WHERE id = $1 AND y_state IS NULL RETURNING id',
        [documentId, encodeYDoc(ydoc)],
      );
      if (claimed.length === 0) {
        const theirs = await query<{ y_state: Buffer | null }>(
          'SELECT y_state FROM documents WHERE id = $1',
          [documentId],
        );
        const stored = theirs[0]?.y_state;
        ydoc = loadYDoc(stored ? new Uint8Array(stored) : null);
      } else {
        // The seed is stored, so the projection beside it is stale until first
        // flush. Marking it dirty here is what makes a document that is opened and
        // closed without a single keystroke still get a draft_markdown that matches
        // its draft_body.
        dirty = true;
      }
    }

    const awareness = new Awareness(ydoc);
    const room: Room = { documentId, ydoc, awareness, sockets: new Set(), dirty, flush: null };
    this.rooms.set(documentId, room);

    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      // The origin is the socket that caused the update, so it never receives its
      // own change back. Yjs is idempotent, so echoing would not corrupt anything —
      // it would make every remote cursor recompute against a transaction it
      // already had, and make typing feel like network lag.
      for (const ws of room.sockets) {
        if (ws === origin) continue;
        this.send(ws, (enc) => {
          encoding.writeVarUint(enc, RT_MESSAGE.sync);
          encoding.writeVarUint(enc, messageYjsUpdate);
          encoding.writeVarUint8Array(enc, update);
        });
      }
      room.dirty = true;
      this.schedulePersist(room);
    });

    awareness.on('update', () => this.broadcastAwareness(room));

    return room;
  }

  private schedulePersist(room: Room): void {
    if (room.flush) clearTimeout(room.flush);
    room.flush = setTimeout(() => {
      room.flush = null;
      void this.writeRoom(room).catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
    room.flush.unref?.();
  }

  /**
   * Persist the Yjs state plus its projections.
   *
   * `y_state` is the authoritative draft (PLAN §2.3) and `draft_body` /
   * `draft_markdown` are the projection phase 2's publish and diff already read,
   * written in the same statement so the three can never disagree — a projection
   * written on a different tick would let publish snapshot text nobody typed.
   *
   * This is a full `encodeStateAsUpdate` plus a fresh render, which is why it is
   * debounced rather than per-update: the encode grows with history and the render
   * walks the whole tree, so once per keystroke would make the server's cost
   * proportional to typing speed for no benefit, since only the final state of a
   * burst is ever read.
   */
  private async writeRoom(room: Room): Promise<void> {
    if (!room.dirty) return;
    const update = encodeYDoc(room.ydoc);
    const projected = this.projector.project(room.ydoc);
    await query(
      `UPDATE documents
          SET y_state = $2, draft_body = $3, draft_markdown = $4, draft_updated_at = now()
        WHERE id = $1`,
      [room.documentId, update, JSON.stringify(projected.body), projected.markdown],
    );
    room.dirty = false;
  }

  /**
   * Drop an empty room after flushing it.
   *
   * The flush-then-delete order is load-bearing both ways: deleting first would
   * lose the current debounce window, and never deleting would mean a document's
   * live state never leaves memory, so a process restart would show a reader a
   * stale draft nobody was still editing. `sockets.size === 0` is re-checked after
   * the await because a client can rejoin during the write — if one did, the room
   * stays and its state is already correct.
   */
  private async releaseRoom(room: Room): Promise<void> {
    if (room.sockets.size > 0) return;
    if (room.flush) {
      clearTimeout(room.flush);
      room.flush = null;
    }
    try {
      await this.writeRoom(room);
    } catch {
      // The room goes anyway. Holding an unwritable room open forever is worse
      // than losing one debounce window: the last persisted draft and every
      // published version are still there.
    }
    if (room.sockets.size === 0) {
      this.rooms.delete(room.documentId);
      this.destroyRoom(room);
    }
  }

  private destroyRoom(room: Room): void {
    removeAwarenessStates(room.awareness, Array.from(room.awareness.getStates().keys()), null);
    room.awareness.destroy();
    room.ydoc.destroy();
  }

  // ------------------------------------------------------------------ framing

  /**
   * One client frame.
   *
   * The WRITE check is per-message and per-subtype, which is what "assert the
   * server, not the disabled toolbar" means concretely: a READ connection may
   * carry sync step 1/2 (it needs the document) and may receive awareness (it
   * needs to draw carets), but an incoming *update* — the only frame that mutates
   * state — closes the connection. Closed, not ignored: a client whose writes are
   * silently dropped believes it is editing, which is worse for a reader who typed
   * and saw nothing happen than an honest disconnect.
   */
  private onMessage(room: Room, conn: Socket, data: Buffer): void {
    if (data.length === 0) return;
    const decoder = decoding.createDecoder(new Uint8Array(data));
    let type: number;
    try {
      type = decoding.readVarUint(decoder);
    } catch {
      conn.close(CLOSE.badFrame, 'bad frame');
      return;
    }

    switch (type) {
      case RT_MESSAGE.sync: {
        let subtype: number;
        try {
          subtype = decoding.peekVarUint(decoder);
        } catch {
          conn.close(CLOSE.badFrame, 'bad frame');
          return;
        }
        if (subtype === messageYjsUpdate && conn.claims?.perm !== 'WRITE') {
          conn.close(CLOSE.readOnly, 'read-only');
          return;
        }
        // The sync message id goes into the encoder first, then readSyncMessage
        // appends its own subtype and payload. For step 1 that produces exactly
        // [sync, step2, diff] — the reply the client is waiting for. For step 2 and
        // update there is nothing to reply with, because applying the update fires
        // the doc's update handler, which has already fanned out to peers.
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, RT_MESSAGE.sync);
        let applied: 0 | 1 | 2;
        try {
          applied = readSyncMessage(decoder, encoder, room.ydoc, conn);
        } catch {
          conn.close(CLOSE.badFrame, 'bad frame');
          return;
        }
        if (applied === messageYjsSyncStep1) {
          this.sendRaw(conn, encoding.toUint8Array(encoder));
        }
        return;
      }

      case RT_MESSAGE.queryAwareness: {
        this.sendAwarenessTo(conn, room);
        return;
      }

      case RT_MESSAGE.awareness: {
        if (conn.claims?.perm !== 'WRITE') return;
        let update: Uint8Array;
        try {
          update = decoding.readVarUint8Array(decoder);
        } catch {
          return;
        }
        // Recorded before applying, and decoded from the frame itself: y-protocols
        // stores a client's state under the id the client chose, so this is the
        // only reliable place to learn which awareness entry belongs to this
        // socket. Without it, a socket could not be blamed for its own presence on
        // close, and removal would have to be guessed.
        for (const client of awarenessClients(update)) conn.clientId = client;
        try {
          applyAwarenessUpdate(room.awareness, update, conn);
        } catch {
          return;
        }
        return;
      }

      default:
        // Unknown type: ignore rather than close. A newer client may legitimately
        // send a type this server predates, and dropping its connection over that
        // would make a client upgrade unshippable.
        return;
    }
  }

  /**
   * Full presence state to one socket, with every `user` field replaced by what
   * the server verified for that connection. Clients do not get to name each other.
   */
  private sendAwarenessTo(to: Socket, room: Room): void {
    const clients = Array.from(room.awareness.getStates().keys());
    if (clients.length === 0) return;
    const update = encodeAwarenessUpdate(room.awareness, clients, this.serverStates(room) as never);
    this.send(to, (enc) => {
      encoding.writeVarUint(enc, RT_MESSAGE.awareness);
      encoding.writeVarUint8Array(enc, update);
    });
  }

  private broadcastAwareness(room: Room): void {
    const clients = Array.from(room.awareness.getStates().keys());
    if (clients.length === 0) return;
    const update = encodeAwarenessUpdate(room.awareness, clients, this.serverStates(room) as never);
    for (const ws of room.sockets) {
      this.send(ws, (enc) => {
        encoding.writeVarUint(enc, RT_MESSAGE.awareness);
        encoding.writeVarUint8Array(enc, update);
      });
    }
  }

  /** Presence states with `user` forced from the owning socket's verified claims. */
  private serverStates(room: Room): Map<number, Record<string, unknown>> {
    const out = new Map<number, Record<string, unknown>>();
    for (const [client, state] of room.awareness.getStates()) {
      const owner = this.socketByClient(room, client)?.user;
      out.set(client, owner ? { ...state, user: owner } : state);
    }
    return out;
  }

  private socketByClient(room: Room, client: number): Socket | null {
    for (const ws of room.sockets) {
      if (ws.clientId === client) return ws;
    }
    return null;
  }

  private send(to: Socket, fn: (enc: encoding.Encoder) => void): void {
    const enc = encoding.createEncoder();
    fn(enc);
    this.sendRaw(to, encoding.toUint8Array(enc));
  }

  private sendRaw(to: Socket, payload: Uint8Array): void {
    if (to.readyState !== WebSocket.OPEN) return;
    to.send(payload, { binary: true });
  }
}

/** Client ids carried in an awareness update, without applying it. */
function awarenessClients(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const clients: number[] = [];
  try {
    const len = decoding.readVarUint(decoder);
    for (let i = 0; i < len; i += 1) {
      const client = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder); // clock
      decoding.readVarString(decoder); // JSON state
      clients.push(client);
    }
  } catch {
    // A truncated frame yields whatever ids were readable before it broke. The
    // subsequent applyAwarenessUpdate will fail on the same frame and be ignored;
    // this only affects which id we would blame on close.
  }
  return clients;
}

/**
 * The ticket, from the query string or a `Sec-WebSocket-Protocol` value.
 *
 * Both are accepted so moving to header-only transport is a client change. The
 * header is the only place a browser can put a value the handshake will see, and
 * it is awkward because the server must echo one offered value back or Chrome
 * fails the upgrade — which is why the `tickets.` prefix exists: it lets the
 * gateway identify and echo its own protocol rather than an arbitrary one.
 */
function readTicket(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://placeholder.invalid');
  const fromQuery = url.searchParams.get('ticket');
  if (fromQuery) return fromQuery;
  const header = req.headers['sec-websocket-protocol'];
  const offered = typeof header === 'string' ? [header] : Array.isArray(header) ? header : [];
  for (const value of offered.join(',').split(',')) {
    const trimmed = value.trim();
    if (trimmed.startsWith('tickets.')) return trimmed.slice('tickets.'.length);
  }
  return null;
}

function pathAfter(url: string, prefix: string): string {
  const rest = url.slice(prefix.length).split('?')[0] ?? '';
  return rest;
}

function toBuffer(data: RawData): Buffer {
  // ws hands over a Buffer, a chunk list, or an ArrayBuffer depending on how the
  // frame arrived; permessage-deflate in particular yields the list form.
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(new Uint8Array(data));
}
