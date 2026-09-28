import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Permission } from '@kachnadocs/shared';

/**
 * A short, single-purpose credential for one websocket connection.
 *
 * Why not just pass the session JWT in the query string: a session token is
 * bearer-of-the-token-gets-everything, valid for twelve hours, and a URL is the
 * one place a credential reliably leaks — it lands in access logs, in proxy
 * logs, and in the browser history. The websocket could read it from a subprotocol
 * header instead, and phase 5 might switch to that, but either way minting a
 * separate credential means the thing on the wire authorises exactly one
 * document for exactly one capability for sixty seconds. Stealing one gets an
 * attacker nothing they could not already get, and it expires almost immediately.
 *
 * The `scope` claim is what keeps the two token kinds from standing in for each
 * other. Without it, `verifyAsync` on a session token and on a ticket are the same
 * call, so a session token would be accepted by the websocket handshake and — the
 * worse direction — a 60-second ticket would be accepted by every HTTP route.
 * Both are rejected below by requiring the claim, not by hoping nobody passes one.
 *
 * The permission is fixed into the credential at mint time, which is a real
 * trade-off rather than a free win: it is what lets the gateway decide read-only
 * vs read-write without a query per frame, and it is also why a grant revoked
 * mid-session still works until the connection is re-made. Re-checking on every
 * update would mean a database round trip per keystroke burst. What the gateway
 * DOES re-check is that the ticket belongs to this document, on every message, so
 * a ticket cannot be pointed at a different room by changing the query string.
 */
export interface RealtimeClaims {
  /** The user, so awareness can name them without trusting client state. */
  sub: string;
  /** Which document this ticket opens. The gateway will not honour another. */
  rt: string;
  /** READ joins read-only; WRITE may send updates. Decided server-side. */
  perm: Extract<Permission, 'READ' | 'WRITE'>;
  scope: 'realtime';
}

const TTL_SECONDS = 60;

@Injectable()
export class RealtimeTickets {
  private readonly jwt: JwtService;
  private readonly ttl = TTL_SECONDS;

  constructor(jwt: JwtService) {
    this.jwt = jwt;
  }

  async issue(userId: string, documentId: string, permission: 'READ' | 'WRITE'): Promise<string> {
    const claims: RealtimeClaims = { sub: userId, rt: documentId, perm: permission, scope: 'realtime' };
    return this.jwt.signAsync(claims, { expiresIn: this.ttl });
  }

  /** Null for anything that is not a live realtime ticket, including a session token. */
  async verify(token: string): Promise<RealtimeClaims | null> {
    let claims: RealtimeClaims | null = null;
    try {
      const payload = await this.jwt.verifyAsync<RealtimeClaims>(token);
      if (payload.scope === 'realtime' && typeof payload.sub === 'string' && typeof payload.rt === 'string') {
        claims = payload;
      }
    } catch {
      // Expired or forged: indistinguishable from absent, on purpose. The gateway
      // closes the socket either way, and a client that could tell "expired" from
      // "never valid" learns nothing it is entitled to.
      claims = null;
    }
    return claims;
  }

  /** How long a minted ticket stays valid, so the API can tell the client to renew. */
  ttlSeconds(): number {
    return this.ttl;
  }
}
