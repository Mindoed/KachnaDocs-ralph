import { Injectable } from '@nestjs/common';
import type { ExternalIdentity, ExternalRole, IdentityProvider } from './identity-provider';
import { readEnv } from '../env';

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Real Discord OAuth (SPEC.md §3, PLAN.md §2.2). Activated only when
 * DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are set — see
 * docs/discord-oauth.md for how to enable it.
 *
 * This is the ONLY module allowed to know the Discord HTTP API exists. The
 * fetch implementation is injectable so the exchange can be unit-tested
 * without network access (the loop must never depend on Discord being up).
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

@Injectable()
export class DiscordIdentityProvider implements IdentityProvider {
  readonly name = 'discord' as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  /** Authorization URL the browser is redirected to. */
  buildAuthorizeUrl(state: string): string {
    const { discord } = readEnv();
    const params = new URLSearchParams({
      client_id: discord.clientId ?? '',
      response_type: 'code',
      redirect_uri: discord.redirectUri,
      // `identify` gives id/username/avatar; `guilds` lets us map roles.
      scope: 'identify guilds',
      state,
      prompt: 'consent',
    });
    // Authorize lives on the site host, not under /api.
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  /** Exchange the OAuth code for a bearer token, then read /users/@me. */
  async resolveIdentity(code: string): Promise<ExternalIdentity> {
    const { discord } = readEnv();
    const tokenRes = await this.fetchImpl(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: discord.clientId ?? '',
        client_secret: discord.clientSecret ?? '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: discord.redirectUri,
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error(`Discord token exchange failed: ${tokenRes.status}`);
    const token = (await tokenRes.json()) as { access_token: string };

    const me = await this.authedGet<{ id: string; username: string; global_avatar_url?: string | null }>(
      token.access_token,
      '/users/@me',
    );
    return {
      externalId: me.id,
      displayName: me.username,
      avatarUrl: me.global_avatar_url ?? null,
    };
  }

  /**
   * Roles for the user. `guilds` scope yields guild membership; role objects
   * require the bot token and a server member lookup, so with user-only scopes
   * this returns the user's roles across guilds the bot can see. Kept narrow:
   * the ACL stores role ids, not the mechanism that produced them.
   */
  async fetchRoleMembership(accessToken: string): Promise<ExternalRole[]> {
    const guilds = await this.authedGet<Array<{ id: string; roles?: unknown }>>(
      accessToken,
      '/users/@me/guilds',
    );
    const roles: ExternalRole[] = [];
    for (const guild of guilds) {
      const raw = await this.authedGet<Array<{ id: string; name: string }>>(
        accessToken,
        `/guilds/${guild.id}/roles`,
      );
      for (const role of raw) {
        if (role.id === guild.id) continue; // @everyone
        roles.push({ externalId: role.id, name: role.name });
      }
    }
    // Same user can share role ids only within a guild; de-duplicate by id.
    return [...new Map(roles.map((r) => [r.externalId, r])).values()];
  }

  private async authedGet<T>(accessToken: string, path: string): Promise<T> {
    const res = await this.fetchImpl(`${DISCORD_API}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Discord ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }
}
