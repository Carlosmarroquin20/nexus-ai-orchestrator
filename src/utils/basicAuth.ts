/**
 * Parser for the HTTP `Authorization: Basic` scheme (RFC 7617). Pure and
 * runtime-agnostic (`atob` + `TextDecoder`), so it is shared by the request proxy
 * and the route handlers and unit-tested without a server.
 */

export interface BasicCredentials {
  readonly username: string;
  readonly password: string;
}

const BASIC_SCHEME = /^basic\s+(.+)$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Extracts the credentials from an `Authorization` header value, or returns
 * `null` when the header is absent, uses another scheme, or is malformed.
 *
 * The payload is decoded as UTF-8 (the `charset="UTF-8"` the server advertises).
 * Only the first colon separates the fields: RFC 7617 forbids it in the user id,
 * but allows it in the password.
 */
export const parseBasicAuthorization = (header: string | null): BasicCredentials | null => {
  if (header === null) return null;
  const match = BASIC_SCHEME.exec(header.trim());
  const token = match?.[1]?.trim();
  if (token === undefined || !BASE64.test(token)) return null;

  let decoded: string;
  try {
    const binary = atob(token);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
};
