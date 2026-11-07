/**
 * Opt-in HTTP Basic access gate (ADR 0009).
 *
 * Disabled unless both `NEXUS_AUTH_USER` and `NEXUS_AUTH_PASSWORD` are set, so
 * local development is unaffected. Setting only one of them is treated as a
 * misconfiguration and denies every request: a half-configured gate must fail
 * closed rather than silently leave the application open.
 *
 * Enforced twice by design: by the request proxy (`src/proxy.ts`), which covers
 * the page so the browser prompts once, and by each route handler that can incur
 * cost, so a matcher change can never silently expose it.
 *
 * Server-only (`node:crypto`). Credentials are compared in constant time over
 * fixed-length digests, so response timing reveals neither their content nor
 * their length.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { type BasicCredentials, parseBasicAuthorization } from '@/utils/basicAuth';

export interface AccessGateConfig {
  readonly user: string | undefined;
  readonly password: string | undefined;
}

export type AccessDecision = 'open' | 'granted' | 'denied' | 'misconfigured';

const REALM = 'Nexus AI Orchestrator';

/** Reads the gate configuration from the server environment; empty values count as unset. */
export const readAccessGateConfig = (): AccessGateConfig => {
  const user = process.env['NEXUS_AUTH_USER'];
  const password = process.env['NEXUS_AUTH_PASSWORD'];
  return {
    user: user !== undefined && user.length > 0 ? user : undefined,
    password: password !== undefined && password.length > 0 ? password : undefined,
  };
};

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

const matches = (supplied: BasicCredentials, user: string, password: string): boolean => {
  // Both comparisons always run (no short-circuit) so timing does not reveal
  // which field was wrong.
  const userMatches = timingSafeEqual(digest(supplied.username), digest(user));
  const passwordMatches = timingSafeEqual(digest(supplied.password), digest(password));
  return userMatches && passwordMatches;
};

/** Decides whether a request carrying `authorization` may proceed under `config`. */
export const evaluateAccess = (
  authorization: string | null,
  config: AccessGateConfig,
): AccessDecision => {
  const { user, password } = config;
  if (user === undefined && password === undefined) return 'open';
  if (user === undefined || password === undefined) return 'misconfigured';
  const supplied = parseBasicAuthorization(authorization);
  return supplied !== null && matches(supplied, user, password) ? 'granted' : 'denied';
};

/** The response for a refused decision; `null` when the request may proceed. */
export const refusalFor = (decision: AccessDecision): Response | null => {
  switch (decision) {
    case 'open':
    case 'granted':
      return null;
    case 'denied':
      return new Response('Authentication required.', {
        status: 401,
        headers: { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"` },
      });
    case 'misconfigured':
      return new Response(
        'Access gate misconfigured: set both NEXUS_AUTH_USER and NEXUS_AUTH_PASSWORD, or neither.',
        { status: 500 },
      );
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
};

/** Gate check for a route handler: the refusal to return, or `null` to proceed. */
export const enforceAccess = (request: Request): Response | null =>
  refusalFor(evaluateAccess(request.headers.get('authorization'), readAccessGateConfig()));
