import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorBody } from '@kachnadocs/shared';

/**
 * Uniform error bodies (PLAN.md §3).
 *
 * `notFound()` is what a missing resource AND a missing permission both turn
 * into. If "no READ" answered 403 while "does not exist" answered 404, a
 * client could enumerate document ids to discover private content — which is
 * exactly the leak SPEC.md §5 forbids for the AI chatbot too. Keep the two
 * indistinguishable: same status, same code, same message.
 */
export function notFound(): HttpException {
  const body: ApiErrorBody = {
    error: { code: 'not_found', message: 'Zdroj neexistuje nebo k něj nemáte přístup.' },
  };
  return new HttpException(body, HttpStatus.NOT_FOUND);
}

export function unauthorized(): HttpException {
  const body: ApiErrorBody = { error: { code: 'unauthorized', message: 'Vyžadováno přihlášení.' } };
  return new HttpException(body, HttpStatus.UNAUTHORIZED);
}

export function validationFailed(details: unknown): HttpException {
  const body: ApiErrorBody = {
    error: { code: 'validation_failed', message: 'Neplatný požadavek.', details },
  };
  return new HttpException(body, HttpStatus.BAD_REQUEST);
}

/**
 * For actions on a resource the actor can see but may not perform — publishing
 * without MANAGE, say. Note this is NOT used for reads: reads go through
 * notFound() so existence stays hidden. Only operations whose target the actor
 * already knows about (because they listed it) may reveal a distinction.
 */
export function forbidden(message: string): HttpException {
  const body: ApiErrorBody = { error: { code: 'forbidden', message } };
  return new HttpException(body, HttpStatus.FORBIDDEN);
}
