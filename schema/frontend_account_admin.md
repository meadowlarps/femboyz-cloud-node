# Account administration and the Stalwart webhook

Code: `src/accounts.ts`, `src/accountApi.ts`. Page: `client/src/routes/admin/` (tabs Requests, Invites, Users).

Admin routes need `Authorization: Bearer <AUTH_ADMIN_KEY>` (same limiter as the other admin routes) and, being state-changing, a same-site `Origin`. Errors are `{ "error": "<code>" }`.

## Requests

| Route | |
| :--- | :--- |
| `GET /api/v2/admin/account/requests?status=pending\|approved\|rejected\|all` | `{ "items": AccountRequest[] }`, pending first, then newest. Default `all`. See `mongo_account_request.md`. |
| `POST /api/v2/admin/account/requests/:id/approve` | Creates an invite tied to the request's address and emails the link: `{ "request", "invite", "link", "mailed" }`. If `mailed` is false the admin sends `link` by hand. `409 already_decided`, `404 not_found`. |
| `POST /api/v2/admin/account/requests/:id/reject` | Silent; no email. Answers the request. |

The notification email links to `/admin?tab=requests&id=<id>`.

## Invites

| Route | |
| :--- | :--- |
| `GET /api/v2/admin/account/invites` | `{ "items": Invite[] }`, newest first, each with `status`: `active`, `used`, `expired`, `revoked`. Never includes the code. |
| `POST /api/v2/admin/account/invites` | `{ "label"?, "email"?, "quota_bytes"?, "ttl_days"? (1–90), "send"? }` → `201 { "invite", "link", "mailed" }`. The link holds the only copy of the code. `email`, if given, is pre-verified at signup. With `"send": true` the link is emailed to `email` (required, else `400 invalid_body`); if `mailed` is false the admin sends `link` by hand. Without it nothing is emailed and `mailed` is false. |
| `DELETE /api/v2/admin/account/invites/:id` | Revokes an unused invite: `{ "revoked": true, "id" }`. |

## Users

| Route | |
| :--- | :--- |
| `GET /api/v2/admin/account/users?search=` | `{ "items": User[] }` (≤ 500, newest first). `search` matches username or external email. No password hashes. `new_sender_until` is when the stricter new-sender throttles end (ISO), or `null` once they have (DEPLOYMENT.md 16.1). |
| `PATCH /api/v2/admin/account/users/:id` | `{ "status"?: "active" \| "disabled", "quota_bytes"? }`. Disabling withdraws Stalwart's `authenticate` permission, which refuses every login and token at once, and deletes the user's site and OIDC sessions. |
| `DELETE /api/v2/admin/account/users/:id` | Immediately disables authentication, ends sessions and hides the user. After 11 minutes, destroys the mailbox and user. The delay prevents a valid old JWT from recreating the mailbox through Stalwart's automatic provisioning. Deletions survive API restarts and are retried once a minute. |

`:id` is `id_user`.

## Stalwart webhook

`POST /api/v2/account/stalwart/webhook`, from Stalwart only. Nginx allows it from the mail bridge `172.30.25.0/24` alone.

- `X-Signature` is base64 HMAC-SHA256 of the raw body with `STALWART_WEBHOOK_SECRET`. Mismatch → `401`.
- Body: `{ "events": [ { "id", "createdAt", "type", "data": { … } } ] }`.
- The API acts on `delivery.dsn-perm-fail` where `data.from` is `<username>@MAIL_DOMAIN` (forwarded mail keeps the mailbox as envelope sender) and `data.to` is that user's external address. Each one counts a bounce; at `MAIL_REDIRECT_MAX_BOUNCES` forwarding turns off.
- `204` on success. Configured in DEPLOYMENT.md 14.5.

Example event:

```json
{
  "id": "1792408652087",
  "createdAt": "2026-10-19T11:17:32Z",
  "type": "delivery.dsn-perm-fail",
  "data": {
    "from": "alice@femboyz.cloud",
    "to": "alice@example.org",
    "hostname": "example.org",
    "details": "DNS lookup failed: Domain does not accept messages (null MX)",
    "queueId": 335814122736189952,
    "queueName": "remote",
    "size": 1904
  }
}
```
