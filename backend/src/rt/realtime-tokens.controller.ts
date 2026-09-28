import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser, RealtimeStatusDto, RealtimeTicketDto } from '@kachnadocs/shared';
import { query } from '../db';
import { PermissionService } from '../acl/permission.service';
import { RequirePermission } from '../acl/require-permission.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeTickets } from './realtime-tickets';

/**
 * Minting the websocket credential (SPEC.md §2's READ/WRITE split, decided here).
 *
 * This is the one place the realtime permission question is answered, and it is
 * answered with the same `can_access_document` SQL every HTTP route uses — the
 * gateway never decides anything, it only obeys what this issued. Keeping the
 * decision in an HTTP route rather than inside the handshake buys three things:
 * the guard chain and its 404-vs-404 shape apply for free, the client learns its
 * capability before it opens a socket (so it can render read-only instead of
 * connecting and being surprised), and the ACL call happens once per connection
 * rather than once per frame.
 *
 * `@RequirePermission('READ', 'document')` means a caller without READ gets the
 * same 404 they get from `GET /documents/:id` — no ticket, and no information
 * about whether the document exists (PLAN §3.3). It is deliberately READ rather
 * than WRITE: readers open documents too, and the READ/WRITE split is what the
 * ticket's `perm` claim carries, not who may ask for a ticket.
 */
@ApiTags('documents')
@Controller('documents')
export class RealtimeTokensController {
  constructor(
    private readonly permissions: PermissionService,
    private readonly tickets: RealtimeTickets,
    // A value import, not `import type`: emitDecoratorMetadata needs the runtime
    // binding in design:paramtypes or Nest cannot resolve it.
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Server-side truth behind the editor's `Ukládání… / Uloženo` indicator.
   *
   * A tiny read, deliberately not folded into the ticket response: the editor
   * polls it while it is open, whereas a ticket is minted once a minute, and an
   * indicator that updates once a minute is a decoration. It is also a separate
   * request so that polling it cannot rotate a credential nobody asked to rotate.
   *
   * READ rather than WRITE because a reader sees the same indicator state as a
   * writer (they simply never see "Ukládání…", having nothing to save), and the
   * body discloses nothing beyond the fact that they may read the document:
   * `saved` is a boolean about a row they can already see, and `peers` is a count,
   * not a list — the presence *names* come over the websocket, which has its own
   * admission check.
   */
  /**
   * …and the newest published version, which is how a client learns that a publish
   * happened while it was open.
   *
   * SPEC.md §1's "Publikování … informuje ostatní klienty o změně" is phase 2's
   * deferral to this phase's transport, and it is answered here rather than by a
   * pushed frame on purpose. A reader's view is a snapshot of a version; when that
   * version changes, the only correct client action is to *replace* the document, and
   * merging is the wrong action so obviously that a push frame would invite it. A
   * changed number cannot be misread as an update to merge — and the editor already
   * polls this endpoint for the save indicator, so this costs no new request.
   *
   * It cannot be fixed server-side instead: a reader's client Y.Doc keeps the previous
   * version's items forever (reusing one doc across reconnects is deliberate), so any
   * newer version's items merge in beside them and the reader sees both versions of
   * every paragraph. Replacement has to happen where the Y.Doc lives.
   */
  @Get(':id/realtime-status')
  @RequirePermission('READ', 'document')
  async status(@Param('id') id: string): Promise<RealtimeStatusDto> {
    const [row] = await query<{ number: number | null }>(
      'SELECT max(number)::int AS number FROM document_versions WHERE document_id = $1',
      [id],
    );
    return {
      documentId: id,
      publishedVersion: row?.number ?? null,
      ...this.realtime.persistence(id),
    };
  }

  @Post(':id/realtime-token')
  @RequirePermission('READ', 'document')
  async mint(@CurrentUser() me: AuthUser, @Param('id') id: string): Promise<RealtimeTicketDto> {
    const canWrite = await this.permissions.canAccessDocument(me.id, id, 'WRITE');
    const permission = canWrite ? 'WRITE' : 'READ';
    const ticket = await this.tickets.issue(me.id, id, permission);
    return {
      ticket,
      // Relative and same-origin: the page and the API are served from one process
      // in every environment the gate runs, and a client that built an absolute URL
      // here would have to know the port the e2e server happened to pick.
      url: `/api/realtime/${id}`,
      documentId: id,
      permission,
      expiresInSeconds: this.tickets.ttlSeconds(),
    };
  }
}
