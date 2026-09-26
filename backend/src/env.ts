import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

// Load .env from the repo root (cwd when scripts run through npm workspaces is
// the workspace dir, so walk up). TEST_DATABASE_URL takes precedence when
// NODE_ENV=test so suites can never touch the dev database by accident.
for (const dir of [process.cwd(), resolve(__dirname, '../..')]) {
  const p = resolve(dir, '.env');
  if (existsSync(p)) loadDotenv({ path: p });
}

export interface AppEnv {
  databaseUrl: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  port: number;
  frontendOrigin: string;
  discord: {
    clientId: string | null;
    clientSecret: string | null;
    redirectUri: string;
  };
  /** True when real Discord OAuth is configured; otherwise dev identities are used. */
  discordEnabled: boolean;
}

export function readEnv(overrides: Partial<Record<string, string>> = {}): AppEnv {
  const get = (key: string, fallback?: string): string => {
    const v = overrides[key] ?? process.env[key];
    if (v === undefined || v === '') {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing required env var ${key}`);
    }
    return v;
  };

  const clientId = get('DISCORD_CLIENT_ID', '');
  const clientSecret = get('DISCORD_CLIENT_SECRET', '');
  const discordEnabled = clientId !== '' && clientSecret !== '';

  const databaseUrl =
    process.env.NODE_ENV === 'test'
      ? get('TEST_DATABASE_URL', 'postgres://kachna:kachna@localhost:5432/kachnadocs_test')
      : get('DATABASE_URL', 'postgres://kachna:kachna@localhost:5432/kachnadocs');

  return {
    databaseUrl,
    jwtSecret: get('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
    jwtTtlSeconds: Number(get('JWT_TTL_SECONDS', '43200')),
    port: Number(get('PORT', '3000')),
    frontendOrigin: get('FRONTEND_ORIGIN', 'http://localhost:5173'),
    discord: {
      clientId: discordEnabled ? clientId : null,
      clientSecret: discordEnabled ? clientSecret : null,
      redirectUri: get('DISCORD_REDIRECT_URI', 'http://localhost:3000/auth/discord/callback'),
    },
    discordEnabled,
  };
}
