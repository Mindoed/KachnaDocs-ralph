import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { buildJwtOptions } from '../auth/auth.service';
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
 */
@Module({
  imports: [JwtModule.register(buildJwtOptions())],
  controllers: [RealtimeTokensController],
  providers: [RealtimeTickets, DraftProjector, RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
