# Account settings (`/account`)

Code: `src/accounts.ts` (`me_*`), `src/accountApi.ts`. Page: `client/src/routes/account/`.

Every route needs the `fbz_session` cookie (`schema/frontend_account_login.md`); without it: `401 not_signed_in`. Responses are `Cache-Control: no-store`.

`/account?embed=1` renders without the site header for the webmail settings frame. `/account` and `/login` send `Content-Security-Policy: frame-ancestors 'self' <ACCOUNT_FRAME_ANCESTORS>`, default `https://mail.femboyz.cloud` (SvelteKit `hooks.server.ts`).

## The account

`GET /api/v2/account/me`

```json
{
  "username": "alice",
  "email": "alice@femboyz.cloud",
  "created": "2026-10-19T11:08:23.735Z",
  "external_email": { "address": "alice@example.org", "verified_at": "2026-10-19T11:15:52.818Z" },
  "redirect": { "enabled": true, "keep_copy": true },
  "quota": { "used_bytes": 2466, "limit_bytes": 1073741824 }
}
```

`external_email` is `null` when none is set. `quota.used_bytes` is `null` if Stalwart didn't answer. Every route below answers with this same object after a change.

## External email

| Route | Body | Notes |
| :--- | :--- | :--- |
| `POST /api/v2/account/me/email` | `{ "address" }` | Sends a code: `{ "sent": true, "cooldown_s": 60 }`. Errors: `email_unchanged`, `email_taken`, `own_domain`, `invalid_email`, `code_cooldown`, `code_limit`. The current address stays until the new one is verified. |
| `POST /api/v2/account/me/email/verify` | `{ "address", "code" }` | Makes it the external email. A replaced address is told by email. If forwarding is on, it moves to the new address. Errors: `code_invalid`, `code_expired`, `code_burned`, `email_taken`. |
| `DELETE /api/v2/account/me/email` | `{ "password" }` | Removes it and turns forwarding off; the old address is told. `403 password_wrong` counts toward the login rate limit. |

## Forwarding

`PATCH /api/v2/account/me/redirect` with `{ "enabled": true, "keep_copy": true }`. Needs a verified external email (`409 no_external_email`).

The API installs a Sieve script named `femboyz-redirect` on the user's Stalwart account (`sieve_redirect_script` in `src/stalwart.ts`):

```sieve
require ["copy"];
if header :matches "X-Spam-Score" "spam*" {
    stop;
}
redirect :copy "alice@example.org";
```

Without `keep_copy` it is `redirect "…";` and no `require`. Mail the spam filter flags is never forwarded. Turning forwarding off removes the script. After `MAIL_REDIRECT_MAX_BOUNCES` (3) hard bounces, reported by Stalwart's webhook (`schema/frontend_account_admin.md`), the API turns it off and tells the user in their femboyz mailbox. Turning it back on resets the count.
