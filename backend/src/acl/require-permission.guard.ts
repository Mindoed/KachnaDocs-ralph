import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthUser, Permission } from '@kachnadocs/shared';
import { PermissionService } from './permission.service';
import { notFound, unauthorized } from '../http-errors';

export const REQUIRED_PERMISSION = 'kachnadocs:required-permission';
export const PERMISSION_TARGET = 'kachnadocs:permission-target';

export type TargetKind = 'document' | 'group';

/** Require `permission` on the resource identified by the route param. */
export const RequirePermission = (permission: Permission, target: TargetKind = 'document') => {
  const deco = SetMetadata(REQUIRED_PERMISSION, permission);
  const deco2 = SetMetadata(PERMISSION_TARGET, target);
  return (target2: unknown, key?: string, desc?: PropertyDescriptor) => {
    deco(target2 as never, key as never, desc as never);
    return deco2(target2 as never, key as never, desc as never);
  };
};

/**
 * Enforces SPEC.md §3: the backend decides, always. A handler that forgot the
 * guard is a bug we catch in review, but any handler that *has* the guard
 * cannot be bypassed by hiding UI elements — the API answers identically for
 * "no such resource" and "no permission" (see http-errors.ts).
 */
@Injectable()
export class RequirePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // Handlers without the decorator are public by explicit choice (health,
    // login) — never by omission of a check on a protected route.
    if (!required) return true;

    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;
    if (!user) throw unauthorized();

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
