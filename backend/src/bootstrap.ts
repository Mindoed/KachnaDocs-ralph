import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AuthService, bindIdentityProvider } from './auth/auth.service';
import { pickIdentityProvider } from './auth/auth.controller';
import { RealtimeGateway } from './rt/realtime.gateway';
import { readEnv } from './env';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Single place where the identity provider is chosen. Everything downstream
 * asks AuthService for an IdentityProvider and never inspects the environment,
 * which is what keeps `AUTH DONE` independent of Discord credentials: the app
 * boots and the whole ACL is exercisable with DevIdentityProvider.
 */
export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  const env = readEnv();

  app.setGlobalPrefix('api');
  app.enableCors({ origin: env.frontendOrigin, credentials: true });

  mountSwagger(app);
  serveFrontendIfBuilt(app);

  const auth = app.get(AuthService);
  bindIdentityProvider(auth, pickIdentityProvider());

  // The websocket gateway rides the same port as the API, so it is wired here
  // rather than in `bootstrap()`: `helpers.ts` calls createApp() and listens on
  // port 0 itself, and a gateway attached in bootstrap() would silently not exist
  // for the entire jest e2e suite — every realtime test would fail against a
  // server that has no realtime, which reads as a broken gateway rather than a
  // missing line of wiring.
  //
  // Safe before listen() because Nest creates the http.Server once, during
  // create() (express-adapter's initHttpServer), and listen() calls .listen on
  // that same instance — so a listener registered now still sees upgrades later.
  app.get(RealtimeGateway).attach(app.getHttpServer());

  return { app, env };
}

function mountSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('KachnaDocs API')
    .setDescription(
      'Identity + fine-grained ACL. Every denial of an existing resource answers with the same body as ' +
        '"it does not exist", so enumeration through this document is not a shortcut.',
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config), {
    swaggerOptions: { persistAuthorization: true },
  });
}

/**
 * When the frontend has been built, one process serves both API and app — which
 * is what Playwright needs: otherwise the gate needs two long-lived dev servers,
 * and Vite's proxy points at a fixed :3000 that may or may not be listening.
 *
 * Everything is registered as middleware, which runs before Nest's routes, and
 * each handler calls next() for `/api/*` so the API keeps its own routing and its
 * 404 shape; only non-API paths are answered from the bundle.
 */
function serveFrontendIfBuilt(app: INestApplication): void {
  const dist = resolve(__dirname, '../../frontend/dist');
  if (!existsSync(resolve(dist, 'index.html'))) return;
  const indexPath = resolve(dist, 'index.html');
  app.use(express.static(dist, { index: false }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    // A cached shell would reference hashed assets that a later build deleted,
    // and the symptom is a blank page behind a 200.
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexPath);
    return undefined;
  });
}

export async function bootstrap(): Promise<void> {
  const { app, env } = await createApp();
  await app.listen(env.port);
  const provider = pickIdentityProvider();
  // eslint-disable-next-line no-console
  console.log(`KachnaDocs API on http://localhost:${env.port}/api (identity: ${provider.name})`);
}
