# Account login: OIDC provider and the site session

Code: `src/oidc.ts`, `src/accountApi.ts` (interaction routes). Page: `client/src/routes/login/`.

femboyz-cloud-node is an OpenID Connect provider ([oidc-provider](https://github.com/panva/node-oidc-provider)) mounted at `OIDC_ISSUER`, e.g. `https://femboyz.cloud/oidc`. Every client is first-party, so nobody is ever asked for consent.

## Clients

| `client_id` | Who | Grants | Access token |
| :--- | :--- | :--- | :--- |
| `femboyz-web` | the site itself (`/account`) | `authorization_code` | opaque, unused |
| `bulwark` | webmail (phase 3) | `authorization_code`, `refresh_token` | JWT for Stalwart |

Both use `client_secret_basic` and PKCE (S256, required).

## Provider endpoints

Standard, under the issuer: `/.well-known/openid-configuration`, `/auth`, `/token`, `/me` (userinfo), `/jwks`, `/token/revocation`, `/session/end`. Scopes: `openid email profile offline_access`.

Claims for a user:

| Claim | Value |
| :--- | :--- |
| `sub` | `id_user` (UUID, never changes) |
| `preferred_username`, `name` | username |
| `email` | `username@MAIL_DOMAIN` |
| `email_verified` | `true` |

### The Stalwart access token (bulwark)

Requests by `bulwark` resolve to the resource `STALWART_RESOURCE` without a `resource` parameter. The access token is an RS256 JWT, valid 10 minutes:

```json
{
  "iss": "https://femboyz.cloud/oidc",
  "aud": "stalwart",
  "sub": "1f0c…",
  "client_id": "bulwark",
  "scope": "openid email profile offline_access",
  "preferred_username": "alice",
  "name": "alice",
  "email": "alice@femboyz.cloud",
  "email_verified": true,
  "iat": 1792408103,
  "exp": 1792408703
}
```

Stalwart's OIDC directory validates it against `/jwks` and requires `aud=stalwart` and the scopes `openid` and `email`. The username claims are in the token, so Stalwart never calls userinfo. Refresh tokens are issued to `bulwark` without `prompt=consent`; they end with the provider session (30 days).

## Login interaction

1. The provider redirects the browser to `GET /oidc/interaction/:uid`, which sets nothing and redirects to `/login?uid=:uid`. The provider's `_interaction` cookie is scoped to `/oidc/interaction/:uid`.
2. The login page posts the credentials:

   `POST /oidc/interaction/:uid/login`

   ```json
   { "username": "alice", "password": "…" }
   ```

   `username` may include `@femboyz.cloud`; it is case-insensitive.

   | Status | Body | Meaning |
   | :--- | :--- | :--- |
   | 200 | `{ "redirect": "https://femboyz.cloud/oidc/auth/:uid" }` | Navigate there; the provider finishes the flow. |
   | 400 | `{ "error": "interaction_expired" }` | Cookie missing or `uid` stale. Start again. |
   | 401 | `{ "error": "credentials_invalid" }` | Wrong username or password, or the account is disabled. |
   | 403 | `{ "error": "bad_origin" }` | `Origin` isn't the site. |
   | 429 | `{ "error": "rate_limited", "retry_after_s": 840 }` | Too many failures from this IP (`ACCOUNT_LOGIN_MAX_FAILS` per `ACCOUNT_LOGIN_BLOCK_MINUTES`) or for this username (3× that). |

3. `POST /oidc/interaction/:uid/abort` → `{ "redirect" }` ends the flow with `access_denied`.

## Site session (`femboyz-web`)

The site is an ordinary client of its own provider.

| Route | What it does |
| :--- | :--- |
| `GET /api/v2/account/session/start?return=/account` | Sets a signed, 10-minute `fbz_auth` cookie (state, nonce, PKCE verifier) and redirects to `/oidc/auth`. `return` must be a same-site path. |
| `GET /api/v2/account/session/callback` | Checks `state`, exchanges the code over loopback, creates the session, sets `fbz_session` and redirects to `return`. Failure → `/login?error=session`. |
| `POST /api/v2/account/session/logout` | Deletes the session, clears the cookie, answers `{ "redirect": "<issuer>/session/end?…" }` so the client also ends the provider session. |

`fbz_session` is 32 random bytes, `HttpOnly; SameSite=Lax; Secure`, 14 days. The database stores only its SHA-256 (`schema/mongo_user.md`).

## CSRF

Every non-GET account route requires `Origin` to equal the site origin (`403 bad_origin` otherwise). All cookies are `SameSite=Lax`. The Stalwart webhook is exempt and authenticated by HMAC instead.
