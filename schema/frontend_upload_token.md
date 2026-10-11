# Upload Token Protocol

Admin-issued tokens that replace the default upload limits (`MAX_FILE_COUNT_PER_UPLOAD`, `MAX_FILE_SIZE`) for one upload at a time.

## Flow

1. User holds the **Upload!** button (600ms) → token field opens.
2. Client sends `GET /api/v2/maxfsize` with `X-Upload-Token` (debounced) once the token is at least 8 characters long → shows e.g. `Unlimited files / 10.0 GB · 2 uses left`.
3. Client sends `POST /api/v2/udstream` with the same header. The server atomically spends one use, checks the limits, and stores the upload with `issuer.token = id_token`.
4. After a successful upload the client forgets the token. To upload again it has to be entered again.

## Header

| Header | Value |
| :--- | :--- |
| `X-Upload-Token` | Token string as shown in the admin panel: a random 32-char base64url one, or a custom value of 8–64 chars from `[A-Za-z0-9_-]` |

Only `/api/v2/maxfsize` and `/api/v2/udstream` read it. Link uploads ignore it.

## Effective Limits

| Token field | `null` means | Effective value |
| :--- | :--- | :--- |
| `limits.max_files` | Unlimited | `max_files ?? 100` (hard cap: the X-Meta header size limit) |
| `limits.max_bytes` | Unlimited | per-file **and** total cap = `min(max_bytes ?? ∞, free storage)` |

## Rejections

`403 {"error": "Token <reason>"}` where reason is one of:

| Reason | Cause |
| :--- | :--- |
| `unknown` | No token with this value |
| `revoked` | Admin revoked it |
| `expired` | `expires_at` is in the past |
| `exhausted` | `uses_count >= uses_max` |

## Guess Blocking

Every `unknown` token (on the prerequest or the upload) counts as a failed guess for the caller's IP. After `UPLOAD_TOKEN_MAX_FAILS` (default 20) guesses within `UPLOAD_TOKEN_BLOCK_MINUTES` (default 15), the IP is blocked for that long:

`429 {"error": "Too many wrong tokens"}` + `Retry-After: <seconds>`

- The check runs **before** any token lookup, so while blocked even a valid token is refused.
- Requests **without** a token are unaffected.
- `revoked` / `expired` / `exhausted` don't count, since those tokens were real.
- A successful token use does **not** reset the counter, so one valid token can't be used to reset it between guesses.
- The block event is logged to `logs/errors.log`. The tracker is separate from the admin-login limiter and lives in memory in the process (`src/authlimit.ts`).
- The client waits 700ms after typing stops before checking, so typing a custom token isn't a burst of wrong guesses.

A token that is valid but whose limits are exceeded gets `400`, and the reserved use is given back. Every rejection is written to `token_uses` and `logs/errors.log`.

## Usage Accounting

| Stage | Effect |
| :--- | :--- |
| `udstream` preHandler | `uses_count += 1` (atomic, filtered on validity, so parallel uploads can't overspend) |
| Limit check fails / stream fails / DB fails | `uses_count -= 1`, `token_uses` entry `rejected` or `failed` |
| Upload stored | `token_uses` entry `ok` with `id_upload_pub` |

## Admin Endpoints

All require `Authorization: Bearer <AUTH_ADMIN_KEY>`.

| Method | Path | Body / Query | Response |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v2/admin/tokens` | — | `{ items: Token[] }` newest first, each with derived `status` |
| `POST` | `/api/v2/admin/tokens` | `{ token?, label?, limits: { max_files, max_bytes }, uses_max?, expires_at? }`. `token` = custom value (8–64 `[A-Za-z0-9_-]`, trimmed); random when omitted | `201` created `Token`, `409 {"error": "Token value already exists"}` for a taken custom value |
| `PATCH` | `/api/v2/admin/tokens/:id` | any of `label`, `limits`, `uses_max`, `expires_at`, `revoked` | updated `Token`, `404` if missing |
| `DELETE` | `/api/v2/admin/tokens/:id` | — | `{ deleted: true, id }`. The usage log is kept. |
| `GET` | `/api/v2/admin/tokens/:id/uses` | `page` (1), `limit` (20, max 100) | `{ items: TokenUse[], page, pageSize, total, totalPages }` newest first |

`status` is `active`, `revoked`, `expired` or `exhausted`. Document shapes: [mongo_token.md](./mongo_token.md).
