import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser } from '@kachnadocs/shared';
import { readEnv } from '../env';
import { UsersService } from '../users/users.service';
import type { IdentityProvider } from './identity-provider';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  provider(): IdentityProvider {
    // Resolved per call so tests can bind a different provider without
    // re-creating the whole application.
    return IDENTITY_PROVIDER_REGISTRY.get(this)!;
  }

  /**
   * Turn a provider credential (OAuth code, or a dev handle) into a session
   * token. Role membership is synced on every login so a role change in
   * Discord takes effect at the next sign-in (SPEC.md:86).
   */
  async login(credential: string): Promise<{ token: string; user: AuthUser }> {
    const provider = this.provider();
    const identity = await provider.resolveIdentity(credential);
    const { id } = await this.users.upsertFromIdentity(identity);
    await this.users.syncRoles(id, await provider.fetchRoleMembership(identity.externalId));
    const user = await this.users.findById(id);
    if (!user) throw new UnauthorizedException('identity could not be persisted');
    const token = await this.jwt.signAsync({ sub: user.id });
    return { token, user };
  }

  async verify(token: string): Promise<AuthUser | null> {
    let sub: string | undefined;
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token);
      sub = payload.sub;
    } catch {
      return null;
    }
    if (!sub) return null;
    return this.users.findById(sub);
  }
}

/**
 * Provider registry. Kept as a WeakMap rather than constructor injection
 * because the provider is chosen from the environment at bootstrap, and we
 * want the Nest DI graph to stay identical between dev and Discord mode.
 */
const IDENTITY_PROVIDER_REGISTRY = new WeakMap<AuthService, IdentityProvider>();

export function bindIdentityProvider(auth: AuthService, provider: IdentityProvider): void {
  IDENTITY_PROVIDER_REGISTRY.set(auth, provider);
}

export function buildJwtOptions(): { secret: string; expiresIn: number } {
  const env = readEnv();
  return { secret: env.jwtSecret, expiresIn: env.jwtTtlSeconds };
}
