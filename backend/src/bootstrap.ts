import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AuthService, bindIdentityProvider } from './auth/auth.service';
import { pickIdentityProvider } from './auth/auth.controller';
import { readEnv } from './env';

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

  const auth = app.get(AuthService);
  bindIdentityProvider(auth, pickIdentityProvider());

  return { app, env };
}

export async function bootstrap(): Promise<void> {
  const { app, env } = await createApp();
  await app.listen(env.port);
  const provider = pickIdentityProvider();
  // eslint-disable-next-line no-console
  console.log(`KachnaDocs API on http://localhost:${env.port}/api (identity: ${provider.name})`);
}
