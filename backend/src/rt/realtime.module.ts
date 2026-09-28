import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { buildJwtOptions } from '../auth/auth.service';
import { AclModule } from '../acl/acl.module';
import { DraftProjector } from './draft-projector';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeTickets } from './realtime-tickets';
import { RealtimeTokensController } from './realtime-tokens.controller';

/**
 * Realtime collaboration. Its own module for one structural reason: the gateway
 * has to be reachable from `bootstrap.ts` to attach to the HTTP server, and
 * reaching it means resolving it out of the Nest container after the app exists.
 * Exporting it here is what makes that possible without the CMS module learning
 * that websockets exist.
 *
 * JwtModule is registered again rather than pulled from AppModule: the tickets
 * service signs with the same secret and algorithm as sessions, but the *claims*
 * are different (see RealtimeClaims), and importing AppModule would create a
 * cycle because AppModule already exports AuthService for everything else.
 *
 * AclModule is imported rather than AclService listed in `providers` here: the
 * guard, the CMS controllers and the ticket endpoint must consult the *same*
 * object. PLAN §3.1 makes PermissionService the only thing that decides access,
 * and a second instance of it would be a second place to get that wrong — the
 * class is stateless today, so a duplicate would pass every test while quietly
 * making the invariant unenforceable.
 */
@Module({
  imports: [JwtModule.register(buildJwtOptions()), AclModule],
  controllers: [RealtimeTokensController],
  providers: [RealtimeTickets, DraftProjector, RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
