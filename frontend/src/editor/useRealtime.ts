import { WebsocketProvider } from 'y-websocket';
import * as awarenessProtocol from 'y-protocols/awareness';
import { computed, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import * as Y from 'yjs';
import type { AwarenessUser, RealtimeTicketDto } from '@kachnadocs/shared';
import { api } from '../api';

/**
 * The browser half of the realtime channel: one websocket per open document.
 *
 * ## The ticket, and why it is rotated rather than renewed in place
 *
 * `POST /documents/:id/realtime-token` answers with a 60-second, single-document,
 * single-capability credential (see `backend/src/rt/realtime-tickets.ts` for why
 * not the session JWT). The y-websocket protocol carries it as a URL parameter,
 * so a live connection has already committed to the one it connected with —
 * rotation means `provider.params.ticket = fresh` plus a reconnect, and the
 * provider reads `params` when it opens a socket, so nothing else needs to change.
 *
 * The obvious place for that is the Collaboration extension's `tokenRefresh`
 * option, and it does not work here: this version of
 * `@tiptap/extension-collaboration` declares `tokenRefresh` but never calls it —
 * the call site was in the y-prosemirror era code and did not survive the port to
 * `@tiptap/y-tiptap`. So the timer lives here, where it can be seen, and the
 * option is not passed rather than passed and quietly ignored. A feature that is
 * configured and dead is worse than a feature that is absent: the next reader
 * would trust it.
 *
 * ## Reconnecting, and the two codes that must not
 *
 * The default `shouldReconnect` treats every close code in 4400-4499 as permanent.
 * That is wrong for exactly one of this server's codes: 4401 (the ticket was
 * missing, forged or expired) is *routine* — it is what happens 60 seconds after
 * a laptop sleeps through a rotation, and a reader who reopens the tab and gets a
 * dead editor has lost their session to a timer. So 4401 reconnects, by which
 * point `renew()` has minted a new ticket and the handshake succeeds.
 *
 * 4403 (read-only) must stay permanent. It is the server saying "you may not send
 * updates to this document", and a client that reconnects on it is retrying a
 * refusal it was given explicitly — which for a revoked writer means hammering an
 * endpoint that has already said no, and for a test asserting "the *server*
 * rejected the join" means the rejection does not stick.
 *
 * ## `disableBc`
 *
 * Cross-tab sync through `BroadcastChannel` is switched off. It is a real
 * optimisation and it would make the phase-3 acceptance test — "user A types, user
 * B sees it without reloading" — pass against a server that is not running at
 * all, because two tabs of one browser would trade updates locally and never
 * notice the wire was dead. Two Playwright contexts would not have helped there
 * either (they are isolated), so the test's value depends on this line: every
 * update a user sees must have come from the gateway.
 */

/** Re-mint this long before the ticket expires, so a slow reconnect still has a live one. */
const RENEW_MARGIN_MS = 15_000;
const MIN_RENEW_MS = 5_000;

/** The server's close codes; see `backend/src/rt/realtime.gateway.ts`. */
const CLOSE = { badFrame: 4400, unauthorized: 4401, readOnly: 4403, notFound: 4404 } as const;

/** What the panel shows in the save indicator and the reconnect affordance. */
export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'read-only' | 'error';

export interface EditorIdentity {
  id: string;
  displayName: string;
}

export interface Realtime {
  /** The shared doc. Stable for the lifetime of `documentId`. */
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  provider: Ref<WebsocketProvider | null>;
  status: Ref<ConnectionStatus>;
  /** False until the first sync round completes; the editor stays uneditable before it. */
  synced: Ref<boolean>;
  permission: Ref<'READ' | 'WRITE' | null>;
  /** Presence, ours first: the panel renders avatars in this order. */
  peers: ComputedRef<AwarenessUser[]>;
  /** Names a reconnect that picks up the current ticket. */
  reconnect: () => void;
}

/**
 * The gateway's base, on the page's own origin.
 *
 * The document id is *not* in here: `WebsocketProvider` builds its URL as
 * `serverUrl + '/' + roomname + '?' + params`, so the id goes in as the room name
 * and this stays the constant prefix. Passing the id in both places would ask for
 * `/api/realtime/<id>/<id>`, which the upgrade filter claims (it only checks the
 * prefix) and the gateway then reads as a document named `<id>/<id>` — a 4404 that
 * looks like an ACL refusal.
 *
 * Relative URLs are not a thing a WebSocket may be constructed with, so the origin
 * is derived rather than configured: the gateway rides the API port in every
 * environment (see `backend/src/bootstrap.ts`), and in dev the Vite proxy forwards
 * `/api` — which leaves the port to the page itself, exactly as `api.ts` does for
 * fetch. Hard-coding `:3000` here would break the moment the e2e server picks a
 * random port, which is precisely how it is configured to behave.
 */
const SOCKET_BASE = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/realtime`;

/**
 * Presence for one window.
 *
 * The local record is written by `yCursorPlugin`, which puts `{anchor, head}` under
 * `cursor` — and by the Collaboration extension's awareness, which puts `{name,
 * color}`. Neither writes `user`, which is the deliberate gap this fills: the
 * server overwrites `user` on the way out from the verified credential, so a peer
 * sees a name it did not type. Ours has to come from the session, or the local
 * avatar would be the one blank face on the screen.
 */
function publishSelf(awareness: awarenessProtocol.Awareness, me: EditorIdentity, canWrite: boolean): void {
  awareness.setLocalStateField('user', {
    id: me.id,
    displayName: me.displayName,
    color: localColor(),
    canWrite,
  } satisfies AwarenessUser);
}

const LOCAL_COLOR = '#111827';

function localColor(): string {
  return LOCAL_COLOR;
}

/**
 * The identity to publish locally.
 *
 * Written for readers too, and that is a deliberate reversal of an earlier version of
 * this line, which skipped `READ` connections on the theory that publishing presence
 * the server will drop is noise. It is not noise, it is the local record: the peers
 * list reads from `awareness` and nothing else, so suppressing it made the reader's
 * own name vanish from their own presence list — the one entry that can never be
 * wrong, since we know who we are. Inbound awareness from a reader is still dropped
 * server-side, which is the part that was ever a policy question; what nobody may be
 * denied is seeing themselves in the room they are standing in.
 */
function peerOf(state: Record<string, unknown> | null): AwarenessUser | null {
  const user = state?.['user'];
  if (typeof user !== 'object' || user === null) return null;
  const u = user as Partial<AwarenessUser>;
  if (typeof u.id !== 'string' || typeof u.displayName !== 'string') return null;
  return {
    id: u.id,
    displayName: u.displayName,
    color: typeof u.color === 'string' ? u.color : LOCAL_COLOR,
    canWrite: u.canWrite === true,
  };
}

export function useRealtime(documentId: Ref<string | null>, me: Ref<EditorIdentity | null>): Realtime {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const provider = shallowRef<WebsocketProvider | null>(null);
  const status = ref<ConnectionStatus>('offline');
  const synced = ref(false);
  const permission = ref<'READ' | 'WRITE' | null>(null);

  let ticket: string | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Generation counter: a response to a stale document's ticket mint is discarded. */
  let generation = 0;

  /**
   * Bumped by every awareness change so `peers` below is actually reactive.
   *
   * An `Awareness` is a plain ObservableV2, not a reactive source, so a computed
   * that reads `getStates()` would be cached forever and the presence list would
   * freeze at whatever it was on first render — including the common case of
   * having rendered before anybody connected. One counter is cheaper than making
   * the whole awareness map reactive, and it is honest: presence changes as a set.
   */
  const presenceTick = ref(0);
  awareness.on('update', () => {
    presenceTick.value += 1;
  });

  const peers = computed(() => {
    void presenceTick.value;
    const mine = peerOf(awareness.getLocalState() as Record<string, unknown> | null);
    const others: AwarenessUser[] = [];
    // Keyed by *connection*, not by person: awareness entries are per client id, and
    // two windows of one user are two entries. Deduping by `user.id` — which is what
    // this did — made the second window invisible in the first one's list, so the
    // phase-3 acceptance test "shows the other collaborator" failed for the only
    // fixture pairing that two browser contexts can easily log in as: the same person
    // twice. A list of connections is also the truthful label, since a caret is per
    // connection too; "two Bonas" is not a duplicate to hide, it is two tabs.
    awareness.getStates().forEach((state, client) => {
      if (client === ydoc.clientID) return;
      const peer = peerOf(state as Record<string, unknown>);
      if (peer) others.push(peer);
    });
    // Ours first is not decoration: the panel labels the list "kdo je tady" and a
    // reader who cannot find themselves in it assumes the connection failed.
    return mine ? [mine, ...others] : others;
  });

  function clearRenewal(): void {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
  }

  function scheduleRenewal(seconds: number): void {
    clearRenewal();
    const ms = Math.max(MIN_RENEW_MS, seconds * 1000 - RENEW_MARGIN_MS);
    renewTimer = setTimeout(() => void renew(), ms);
  }

  /**
   * Open (or re-open) the channel for the current document.
   *
   * One provider per connection, but the Y.Doc and Awareness are never replaced:
   * rotation and reconnects reuse them, because a doc rebuilt per connection is how
   * a document starts losing paragraphs — the server's room holds state the fresh
   * client doc does not have, and the merge resolves that by whichever side wrote
   * last rather than by CRDT history.
   */
  function open(): void {
    const id = documentId.value;
    const identity = me.value;
    if (!id || !ticket || !identity) return;

    provider.value?.destroy();

    const pv = new WebsocketProvider(SOCKET_BASE, id, ydoc, {
      awareness,
      params: { ticket },
      disableBc: true,
      connect: true,
      shouldReconnect: (event) => {
        // 4404: the document is gone. 4403: see the header comment.
        if (event.code === CLOSE.notFound || event.code === CLOSE.readOnly) return false;
        return event.code < 4400 || event.code >= 4500 || event.code === CLOSE.unauthorized;
      },
    });
    provider.value = pv;

    pv.on('status', (event: { status: string }) => {
      if (event.status === 'connecting') status.value = 'connecting';
      else if (event.status === 'connected')
        status.value = permission.value === 'READ' ? 'read-only' : 'online';
      else status.value = 'offline';
    });

    // The server overwrites `user` from the verified credential on every outbound
    // awareness frame, including this first one; publishing locally first only
    // avoids a window where the peers list is empty for somebody already connected.
    // Published before `connection-error` can matter and before the provider's
    // `onopen` checks `getLocalState() !== null` — if it is still null there, no
    // presence frame is sent at all and the peers list stays empty on both ends.
    publishSelf(awareness, identity, permission.value === 'WRITE');

    // `sync` is the provider's own "step 2 applied" signal, set inside
    // readMessage rather than guessed from a doc event. Listening for the first
    // `update` instead would leave a never-edited document loading forever — an
    // empty sync step 2 applies no update and emits nothing — and an editor stuck
    // on "načítám…" reads as a dead server, not as an empty document.
    pv.on('sync', (state: boolean) => {
      synced.value = state;
    });
    // Spelled with the dash, which is what `ObservableV2.emit` looks up: it reads
    // `_observers.get(name)` with no name mangling, so a camelCase listener would
    // register successfully and never be called. A silent no-op in an error path is
    // the worst kind — the status would simply never say "error" to anyone.
    pv.on('connection-error', () => {
      status.value = 'error';
    });
    pv.on('closed', (event: { code: number }) => {
      if (event.code === CLOSE.readOnly) status.value = 'read-only';
      else if (event.code === CLOSE.notFound) status.value = 'error';
    });
  }

  /** Ask for a ticket, then connect. Also the rotation path. */
  async function renew(): Promise<void> {
    const id = documentId.value;
    if (!id) return;
    const gen = generation;
    try {
      const minted = await api<RealtimeTicketDto>(`/documents/${id}/realtime-token`, { method: 'POST' });
      if (gen !== generation || documentId.value !== id) return;
      ticket = minted.ticket;
      permission.value = minted.permission === 'WRITE' ? 'WRITE' : 'READ';
      const existing = provider.value;
      if (existing && existing.wsconnected) {
        // Hand the new credential to the provider and cycle the socket. Closing
        // with 1000 is a local close: `shouldReconnect` is not consulted (that
        // predicate is only for *server*-initiated closes), so the provider
        // reconnects on its own backoff with the new params.
        existing.params.ticket = minted.ticket;
        existing.disconnect();
        void existing.connect();
      } else {
        open();
      }
      scheduleRenewal(minted.expiresInSeconds);
    } catch {
      if (gen !== generation) return;
      // No ticket means no channel. The panel says so rather than showing an
      // editor whose keystrokes go nowhere.
      status.value = 'error';
      permission.value = null;
    }
  }

  function reconnect(): void {
    void renew();
  }

  function teardown(): void {
    generation += 1;
    clearRenewal();
    provider.value?.destroy();
    provider.value = null;
    permission.value = null;
    synced.value = false;
    ticket = null;
  }

  // The whole channel is scoped to the selected document. Switching documents must
  // not leave the old socket connected: it would keep publishing presence into a
  // room nobody is looking at, and its updates would land in the same Y.Doc the new
  // document is now using.
  watch(
    [documentId, me],
    ([id]) => {
      teardown();
      status.value = id ? 'connecting' : 'offline';
      if (id) void renew();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    teardown();
    awareness.destroy();
    ydoc.destroy();
  });

  return { ydoc, awareness, provider, status, synced, permission, peers, reconnect };
}
