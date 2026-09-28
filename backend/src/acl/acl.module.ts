import { Module } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { PermissionsController } from './permissions.controller';

/**
 * The ACL on its own, so more than one module can depend on it.
 *
 * It existed implicitly inside AppModule until phase 3, which was fine while
 * AppModule was the only consumer. The realtime ticket endpoint needs
 * `canAccessDocument` to decide READ-vs-WRITE, and reaching it through AppModule
 * would mean RealtimeModule importing AppModule while AppModule imports
 * RealtimeModule — a cycle Nest refuses to build. Extracting the shared provider
 * is the honest version of that dependency rather than papering over it with
 * forwardRef.
 *
 * The APP_GUARD registration deliberately stays in AppModule: the guard is
 * global behaviour of the HTTP application, and putting it here would make it
 * apply twice when both modules are loaded.
 */
@Module({
  controllers: [PermissionsController],
  providers: [PermissionService],
  exports: [PermissionService],
})
export class AclModule {}
