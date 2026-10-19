# MongoDB `invites`

Zod: `InviteSchemaDB` in `src/schema.ts`. Collection `MDB_COLLECTION_INVITES`, default `invites`.

Indexes: `{ id: 1 }` unique, `{ code_hash: 1 }` unique.

```json
{
  "id": "pJ3x0aZq",
  "code_hash": "9b1c…",
  "label": "request Xq3kP0aB",
  "email": "Friend@example.org",
  "request_id": "Xq3kP0aB",
  "quota_bytes": 1073741824,
  "created": "2026-10-19T11:25:17.000Z",
  "expires": "2026-10-26T11:25:17.000Z",
  "reserved_until": null,
  "used": true,
  "used_by": "cd028969-1f1e-4008-b847-f68f97652dbc",
  "used_at": "2026-10-19T12:01:00.000Z",
  "revoked": false
}
```

| Field | Notes |
| :--- | :--- |
| `id` | Public id for admin routes. |
| `code_hash` | SHA-256 hex of the code in the link (24 random bytes, base64url). The code itself exists only in the link. |
| `label` | Admin's note; approvals use `request <id>`. |
| `email` | Address the invite was sent to; signup treats it as verified. `null` for a hand-made invite without one. |
| `request_id` | The request it came from, or `null`. |
| `quota_bytes` | Mailbox quota for the account; default `MAIL_DEFAULT_QUOTA_BYTES` (1 GiB). |
| `expires` | `created` + `INVITE_TTL_DAYS` (7), or the admin's `ttl_days`. |
| `reserved_until` | Held by a signup in progress (2 minutes), so two parallel signups can't both use it. |
| `used`, `used_by`, `used_at` | Set once the mailbox exists. |
| `revoked` | Set by the admin; only unused invites can be revoked. |

Status as the API reports it: `used` › `revoked` › `expired` › `active`.
