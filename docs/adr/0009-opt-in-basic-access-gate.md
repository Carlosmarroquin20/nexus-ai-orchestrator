# 9. Opt-in HTTP Basic access gate

- Status: Accepted
- Date: 2026-11-06

## Context

ADR 0005 recorded that the execution endpoint is unauthenticated and that a gate is a
prerequisite before public deployment, since each run can incur real model cost. ADR
0008 closed the cross-site vector (a third-party page can no longer start a run), but
any client that can reach the server directly can still run pipelines on the
operator's API key.

The application is a single-operator debugging tool. It has no user model, and the
browser client cannot hold a secret: anything shipped to it is public.

## Decision

An **opt-in HTTP Basic gate**, configured by two server-side variables,
`NEXUS_AUTH_USER` and `NEXUS_AUTH_PASSWORD`.

- Both unset (the default): the gate is disabled and local development is unchanged.
- Both set: every page and API request must carry matching Basic credentials;
  otherwise the response is `401` with a `WWW-Authenticate: Basic` challenge. The
  browser prompts once and then attaches the credentials to every same-origin request,
  including the `fetch` that starts a run, so the client needs no changes.
- Exactly one set: every request is refused with `500` naming both variables. A
  half-configured gate fails closed instead of silently leaving the app open.

The check lives in `server/accessGate` and is enforced twice: by the Next.js request
proxy (`src/proxy.ts`), which covers the page, and again inside the run route handler,
so a future matcher change cannot expose the endpoint that incurs cost. Credentials are
compared in constant time over SHA-256 digests, so timing reveals neither their content
nor their length.

## Consequences

- A public deployment can be protected with two environment variables and no code or
  client changes.
- Basic credentials are only base64-encoded on the wire. The gate is only meaningful
  over HTTPS, which the deployment must provide.
- There is a single shared credential: no per-user identity, audit trail, rotation
  workflow, or rate limiting. Those require a real identity layer and are out of scope
  for a single-operator tool.

## Alternatives considered

- **A bearer token for the API only** — the browser client would have to embed it,
  which makes it public; it protects nothing.
- **Session-based login (an auth library or an identity provider)** — the right answer
  for multiple users, but it adds a login UI, session storage, and secrets management
  to an application that has no user model.
- **Gating at the reverse proxy or platform only** — valid, and compatible with this
  gate, but it leaves the application unprotected wherever it is run without one.
