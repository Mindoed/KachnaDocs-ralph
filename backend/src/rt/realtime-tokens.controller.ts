import { Controller, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser, RealtimeTicketDto } from '@kachnadocs/shared';
import { PermissionService } from '../acl/permission.service';
import { RequirePermission } from '../acl/require-permission.guard';
import { CurrentUser } from '../auth/current-user.decorator';
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
  ) {}

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
