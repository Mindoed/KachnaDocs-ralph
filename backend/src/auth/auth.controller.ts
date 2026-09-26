import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { ApiErrorBody, AuthUser } from '@kachnadocs/shared';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { DevIdentityProvider } from './dev-identity.provider';
import { DiscordIdentityProvider } from './discord-identity.provider';
import { readEnv } from '../env';
import { notFound, unauthorized, validationFailed } from '../http-errors';
import { CurrentUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Dev-mode login: POST {handle} → session token. Registered only when the
   * dev provider is active, so production cannot authenticate by handle.
   */
  @Post('dev-login')
  async devLogin(@Body() body: { handle?: string }): Promise<{ token: string; user: AuthUser }> {
    const env = readEnv();
    if (env.discordEnabled) throw notFound();
    const handle = body?.handle;
    if (typeof handle !== 'string' || handle.length === 0) {
      throw validationFailed({ handle: 'required' });
    }
    try {
      return await this.auth.login(handle);
    } catch {
      throw unauthorized();
    }
  }

  /** Where to send the browser for Discord consent (real mode only). */
  @Get('discord/authorize-url')
  async authorizeUrl(@Query('state') state?: string): Promise<{ url: string }> {
    const env = readEnv();
    if (!env.discordEnabled) throw notFound();
    const provider = this.auth.provider();
    if (!(provider instanceof DiscordIdentityProvider)) throw notFound();
    return { url: provider.buildAuthorizeUrl(state ?? 'state') };
  }

  /** OAuth callback: exchange the code, return the session. */
  @Get('discord/callback')
  async discordCallback(@Query('code') code?: string): Promise<{ token: string; user: AuthUser }> {
    const env = readEnv();
    if (!env.discordEnabled || !code) throw notFound();
    return this.auth.login(code);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser): Promise<AuthUser> {
    return user;
  }
}

/**
 * Factory used at bootstrap: the provider is chosen from the environment, and
 * nothing else in the app branches on it.
 */
export function pickIdentityProvider(): DevIdentityProvider | DiscordIdentityProvider {
  const env = readEnv();
  return env.discordEnabled ? new DiscordIdentityProvider(fetch) : new DevIdentityProvider();
}

export type { ApiErrorBody, Request };
