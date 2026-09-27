import { applyDecorators, CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthUser, Permission } from '@kachnadocs/shared';
import { PermissionService } from './permission.service';
import { notFound, unauthorized } from '../http-errors';

export const REQUIRED_PERMISSION = 'kachnadocs:required-permission';
export const PERMISSION_TARGET = 'kachnadocs:permission-target';
export const PUBLIC_ROUTE = 'kachnadocs:public';

export type TargetKind = 'document' | 'group';

/**
 * Mark a route reachable without any token. The guard's default is "must be
 * signed in", so this decorator — not the absence of one — is what makes a
 * route public. Only health probes, login, and the OAuth handshake qualify.
 */
export function Public(): MethodDecorator & ClassDecorator {
  return SetMetadata(PUBLIC_ROUTE, true);
}

/**
 * Require `permission` on the resource named by the route's `:id` param.
 *
 * applyDecorators rather than a hand-written composite: calling SetMetadata
 * ourselves and returning its result types the descriptor as
 * TypedPropertyDescriptor<unknown>, which TypeScript then refuses on any
 * concretely-typed handler.
 */
export function RequirePermission(
  permission: Permission,
  targetKind: TargetKind = 'document',
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(REQUIRED_PERMISSION, permission),
    SetMetadata(PERMISSION_TARGET, targetKind),
  );
}

/**
 * Enforces SPEC.md §3: the backend decides, always. Any handler that *has* the
 * guard cannot be bypassed by hiding UI elements — the API answers identically
 * for "no such resource" and "no permission" (see http-errors.ts).
 *
 * Default-deny by construction: a route is public only if it carries @Public(),
 * and requires a signed-in caller otherwise. Phase 1 returned `true` when no
 * decorator was present, which made "forgot the decorator" and "meant to be
 * public" indistinguishable — acceptable with eight routes, not with the dozens
 * phase 2's CRUD adds. Forgetting @RequirePermission now still fails open past
 * the auth check, but forgetting @Public() fails closed.
 */
@Injectable()
export class RequirePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    // Any decorated or undecorated protected route lands here: no token is 401.
    if (!user) throw unauthorized();

    const required = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // Signed in but no specific grant required (e.g. GET /auth/me, which only
    // ever returns the caller's own identity).
    if (!required) return true;

    const targetKind =
      this.reflector.getAllAndOverride<TargetKind | undefined>(PERMISSION_TARGET, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? 'document';
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const id = params['id'] ?? params[`${targetKind}Id`];
    if (!id) throw notFound();

    const allowed =
      targetKind === 'document'
        ? await this.permissions.canAccessDocument(user.id, id, required)
        : await this.permissions.canAccessGroup(user.id, id, required);

    // Denial is a 404 with the same body as a genuinely missing row.
    if (!allowed) throw notFound();
    return true;
  }
}
