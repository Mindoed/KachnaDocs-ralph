import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '@kachnadocs/shared';
import { AuthService } from './auth.service';

declare module 'express' {
  interface Request {
    user?: AuthUser;
  }
}

/**
 * Resolves the bearer token into request.user. Deliberately does not reject:
 * a missing or bad token leaves `user` unset, and the guard decides whether
 * that is acceptable for the route. Keeps public routes (health, login) from
 * needing special cases.
 */
@Injectable()
export class AuthContextMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const user = await this.auth.verify(header.slice('Bearer '.length).trim());
      if (user) req.user = user;
    }
    next();
  }
}
