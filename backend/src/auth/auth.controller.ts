import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { ApiErrorBody, AuthUser } from '@kachnadocs/shared';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { DevIdentityProvider } from './dev-identity.provider';
import { DiscordIdentityProvider } from './discord-identity.provider';
import { readEnv } from '../env';
import { notFound, unauthorized, validationFailed } from '../http-errors';
import { CurrentUser } from './current-user.decorator';
import { Public } from '../acl/require-permission.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Dev-mode login: POST {handle} → session token. Registered only when the
   * dev provider is active, so production cannot authenticate by handle.
   */
  @Public()
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

  /**
   * OAuth callback. Exchanges Discord's code for a session, then hands the token
   * to the SPA and redirects there — a JSON body would be a dead end, since
   * Discord sends the browser here, not `fetch`.
   *
   * The token travels in the URL **fragment**, which browsers never send to the
   * server and which browsers do not include in `Referer`, rather than in a query
   * string that would land in proxies and history. The SPA strips it from the URL
   * as soon as it reads it. This is still a bearer credential in the browser
   * address bar for one navigation; the alternative (an httpOnly cookie session)
   * is a real hardening step and is listed in ralph/DEFERRED.md rather than
   * quietly skipped.
   */
  @Public()
  @Get('discord/callback')
  async discordCallback(@Query('code') code: string | undefined, @Res() res: Response): Promise<void> {
    const env = readEnv();
    if (!env.discordEnabled) throw notFound();
    if (!code) {
      // Discord redirects here with `?error=access_denied` when consent is
      // refused; that is a normal outcome, not a 404, and the user should be
      // told rather than shown a blank page.
      res.redirect(`${env.frontendOrigin}/?auth_error=denied#`);
      return;
    }
    let session: { token: string };
    try {
      session = await this.auth.login(code);
    } catch {
      // A stale or replayed code is common (codes are single-use and last
      // ~10 minutes). Do not echo Discord's message: it can name the client.
      res.redirect(`${env.frontendOrigin}/?auth_error=invalid#`);
      return;
    }
    res.redirect(`${env.frontendOrigin}/#${new URLSearchParams({ token: session.token })}`);
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
