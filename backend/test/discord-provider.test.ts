import { describe, expect, it, beforeEach } from '@jest/globals';
import { DiscordIdentityProvider, type FetchLike } from '../src/auth/discord-identity.provider';

/**
 * The Discord provider is the one piece of phase 1 that must be testable with no
 * network and no credentials (ralph/PLAN.md §6). It takes its fetch as a
 * constructor argument for exactly this reason, so these tests assert the wire
 * contract — endpoints, form encoding, scope list, error propagation — without
 * Discord existing.
 */

interface Recorded {
  url: string;
  init?: RequestInit;
}

function mockFetch(respondTo: (url: string, init?: RequestInit) => unknown) {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = respondTo(String(url), init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

beforeEach(() => {
  // The provider reads config per call, so a test can enable Discord without a
  // .env file. These are not secrets — no request here reaches Discord.
  process.env.DISCORD_CLIENT_ID = 'test-client-id';
  process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
  process.env.DISCORD_REDIRECT_URI = 'http://localhost:3000/api/auth/discord/callback';
});

describe('DiscordIdentityProvider.buildAuthorizeUrl', () => {
  it('requests identify and guilds, and carries state through', () => {
    const provider = new DiscordIdentityProvider(fetch);
    const url = new URL(provider.buildAuthorizeUrl('xyz'));

    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('identify guilds');
    expect(url.searchParams.get('state')).toBe('xyz');
    // The redirect must be the one the portal has registered, /api prefix and all.
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/discord/callback');
  });
});

describe('DiscordIdentityProvider.resolveIdentity', () => {
  it('exchanges the code for a token, then reads /users/@me', async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.endsWith('/oauth2/token')) return { access_token: 'access-123' };
      if (url.endsWith('/users/@me')) {
        return { id: '9001', username: 'viktor', global_avatar_url: 'https://cdn/avatar.png' };
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const identity = await new DiscordIdentityProvider(fetchImpl).resolveIdentity('the-code');

    expect(identity).toEqual({
      externalId: '9001',
      displayName: 'viktor',
      avatarUrl: 'https://cdn/avatar.png',
    });

    const tokenCall = calls.find((c) => c.url.endsWith('/oauth2/token'));
    expect(tokenCall).toBeDefined();
    expect(tokenCall?.init?.method).toBe('POST');
    // Discord requires form encoding here, not JSON — the single most common way
    // this exchange is written wrong, and it fails only at runtime.
    const form = new URLSearchParams(String(tokenCall?.init?.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('client_id')).toBe('test-client-id');
    expect(form.get('client_secret')).toBe('test-client-secret');

    // The secret must never appear in a URL; only in the POST body.
    expect(calls.some((c) => c.url.includes('test-client-secret'))).toBe(false);

    const meCall = calls.find((c) => c.url.endsWith('/users/@me'));
    expect((meCall?.init?.headers as Record<string, string>).authorization).toBe('Bearer access-123');
  });

  it('fails loudly when the token exchange is rejected', async () => {
    const fetchImpl: FetchLike = async () => new Response('{"error":"invalid_grant"}', { status: 400 });

    await expect(new DiscordIdentityProvider(fetchImpl).resolveIdentity('stale')).rejects.toThrow(
      /token exchange failed: 400/,
    );
  });

  it('surfaces a failing authenticated call with its status', async () => {
    const { fetchImpl } = mockFetch((url) => {
      if (url.endsWith('/oauth2/token')) return { access_token: 'a' };
      // Real Discord returns a JSON error body we deliberately do not parse.
      return { message: 'bad token' };
    });
    const failing: FetchLike = async (url, init) =>
      String(url).endsWith('/users/@me') ? new Response('nope', { status: 401 }) : fetchImpl(url, init);

    await expect(new DiscordIdentityProvider(failing).resolveIdentity('c')).rejects.toThrow(
      /\/users\/@me failed: 401/,
    );
  });
});

describe('DiscordIdentityProvider.fetchRoleMembership', () => {
  it('collects roles per guild, skips @everyone, and de-duplicates', async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.endsWith('/users/@me/guilds')) {
        return [
          { id: 'guild-1', roles: [] },
          { id: 'guild-2', roles: [] },
        ];
      }
      if (url.endsWith('/guilds/guild-1/roles')) {
        return [
          { id: 'guild-1', name: '@everyone' },
          { id: 'role-hr', name: 'HR' },
          { id: 'role-eng', name: 'Engineering' },
        ];
      }
      if (url.endsWith('/guilds/guild-2/roles')) {
        // Same external id twice: must collapse to one row.
        return [
          { id: 'guild-2', name: '@everyone' },
          { id: 'role-eng', name: 'Engineering' },
          { id: 'role-eng', name: 'Engineering' },
        ];
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const roles = await new DiscordIdentityProvider(fetchImpl).fetchRoleMembership('access-123');

    expect(roles).toEqual([
      { externalId: 'role-hr', name: 'HR' },
      { externalId: 'role-eng', name: 'Engineering' },
    ]);
    // @everyone is every member of the guild; mapping it to a grant would hand
    // everyone on the server everything the role grants.
    expect(roles.some((r) => r.name === '@everyone')).toBe(false);
    expect(calls.filter((c) => c.url.includes('/roles'))).toHaveLength(2);
  });
});
