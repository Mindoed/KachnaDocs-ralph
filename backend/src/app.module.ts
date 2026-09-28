import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthService, buildJwtOptions } from './auth/auth.service';
import { UsersService } from './users/users.service';
import { PermissionService } from './acl/permission.service';
import { RequirePermissionGuard } from './acl/require-permission.guard';
import { AuthContextMiddleware } from './auth/auth-context.middleware';
import { PermissionsController } from './acl/permissions.controller';
import { DocumentsController } from './cms/documents.controller';
import { GroupsController } from './cms/groups.controller';
import { CategoriesController } from './cms/categories.controller';
import { VersionsController } from './cms/versions.controller';
import { RealtimeModule } from './rt/realtime.module';
import { HealthController } from './health.controller';

@Module({
  imports: [JwtModule.register(buildJwtOptions()), RealtimeModule],
  // HealthController is unauthenticated by design: a probe that needs a token
  // cannot answer "why is the API down".
  controllers: [
    HealthController,
    AuthController,
    PermissionsController,
    DocumentsController,
    GroupsController,
    CategoriesController,
    VersionsController,
  ],
  providers: [
    AuthService,
    UsersService,
    PermissionService,
    // Guard runs for every route and defaults to deny: only @Public() routes
    // are reachable anonymously, so a route becomes public by declaration
    // rather than by someone forgetting a decorator.
    { provide: APP_GUARD, useClass: RequirePermissionGuard },
    AuthContextMiddleware,
  ],
  exports: [AuthService, UsersService, PermissionService],
})
export class AppModule implements NestModule {
  /** Attaches request.user from the bearer token for the guards. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthContextMiddleware).forRoutes('*');
  }
}
