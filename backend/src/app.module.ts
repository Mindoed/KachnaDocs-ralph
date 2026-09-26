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

@Module({
  imports: [JwtModule.register(buildJwtOptions())],
  controllers: [AuthController, PermissionsController],
  providers: [
    AuthService,
    UsersService,
    PermissionService,
    // Guard runs for every route; routes without @RequirePermission are
    // public by decision, and that decision is visible at the handler.
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
