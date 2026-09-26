import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '@kachnadocs/shared';
import { unauthorized } from '../http-errors';

/** Injects the authenticated user, or throws the uniform 401. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  const user = request.user;
  if (!user) throw unauthorized();
  return user;
});
