import { type NextRequest, NextResponse } from 'next/server';

import { enforceAccess } from '@/server/accessGate';

/**
 * Request proxy (Next.js 16's successor to middleware). Applies the opt-in access
 * gate to the whole application, so a browser prompts for credentials once and
 * then sends them with every same-origin request, including run requests. With
 * the gate disabled (the default) every request passes through untouched.
 *
 * The route handlers that incur cost enforce the gate again (see
 * `server/accessGate`), so this matcher is not the only line of defense.
 */
export function proxy(request: NextRequest): Response {
  return enforceAccess(request) ?? NextResponse.next();
}

export const config = {
  // Build assets carry no data; gating them would only break the login prompt page.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
