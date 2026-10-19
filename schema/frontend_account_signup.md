# Access requests, invites and signup

Code: `src/accounts.ts`, `src/accountApi.ts`. Pages: `client/src/routes/login/` (request form), `client/src/routes/signup/`.

Accounts are invite-only. Errors are `{ "error": "<code>" }`, optionally with `retry_after_s`; `client/src/lib/account/api.ts` has the user-facing text for each code.

## Request access

`POST /api/v2/account/request`

```json
{ "email": "friend@example.org", "note": "who I am", "website": "" }
```

| Field | Rules |
| :--- | :--- |
| `email` | Valid address, not at `MAIL_DOMAIN`. |
| `note` | ≤ 1000 chars, optional. |
| `website` | Honeypot, hidden in the form. Anything in it → `202` and the request is dropped. |

`202 { "ok": true }`. A second request from an address that already has one pending is accepted and ignored. Limits: 5 per IP per hour (`429 rate_limited`), at most `ACCOUNT_REQUESTS_MAX_PENDING` pending (`429 requests_full`). The admin gets a notification at `ADMIN_NOTIFY_EMAIL`. Rejected requests get no email.

## Check an invite

`GET /api/v2/account/invite/:code` → `200 { "valid": true, "email": "friend@example.org" | null, "expires": "<iso>" }` or `404 invite_invalid`. `email` is the address the invite was sent to; signup treats it as verified.

Invite lookups (here, in `available`, `signup/email-code` and `signup`) share a guessing limit: 20 unknown codes per IP per 15 minutes.

## Username availability

`GET /api/v2/account/available?name=alice&invite=<code>` → `{ "username": "alice", "available": true }` or `{ "available": false, "reason": "invalid" | "reserved" | "taken" }`. Needs a valid invite; 60 checks per IP per minute.

Usernames: `^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$`, no `..`, not reserved. The reserved list (`RESERVED_USERNAMES`, `RESERVED_PREFIXES`) covers every internal Stalwart account and alias. Stalwart creates an account on the first OIDC login it sees, so these names must never be issued.

## External email code (step 2)

`POST /api/v2/account/signup/email-code`

```json
{ "invite": "<code>", "address": "other@example.org" }
```

| Answer | Meaning |
| :--- | :--- |
| `200 { "verified": true }` | The address is the invite's own; no code needed. |
| `200 { "sent": true, "cooldown_s": 60 }` | A 4-digit code was emailed. |
| `409 email_taken` | Another account has this address. |
| `400 own_domain` / `invalid_email` | |
| `429 code_cooldown` / `code_limit` | See `schema/mongo_user.md`, `email_codes`, for the limits. |

## Sign up

`POST /api/v2/account/signup`

```json
{
  "invite": "<code>",
  "username": "alice",
  "password": "at least 12 characters",
  "external_email": { "address": "other@example.org", "code": "0427" }
}
```

`external_email` is optional; `code` is required unless `address` is the invite's own.

`201 { "username": "alice", "email": "alice@femboyz.cloud" }`. The client then sends the user to `session/start` to sign in.

Order: validate username and password → check and consume the code → reserve the invite atomically for 2 minutes → insert a disabled user → create the Stalwart mailbox (quota from the invite) → recheck revocation and mark the invite used → activate the user. Failures remove any created mailbox before releasing the username and invite (`502 mailbox_failed`). If mailbox cleanup fails, the disabled reservation is kept for admin repair. A consumed verification code must be resent after a failed signup.

| Error | |
| :--- | :--- |
| `400 username_invalid`, `username_reserved` | |
| `409 username_taken` | |
| `400 password_too_short`, `password_too_long`, `password_common`, `password_contains_username` | ≥ 12 chars, not one of the 10,000 most common passwords of that length, not containing the username. |
| `400 code_invalid`, `code_expired`, `code_burned` | |
| `404 invite_invalid` | Unknown, expired, revoked or used. |
| `409 invite_busy` | Another signup holds the invite right now. |
| `502 mailbox_failed` | Stalwart didn't answer; nothing was kept. |
