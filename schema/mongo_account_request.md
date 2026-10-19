# MongoDB `account_requests`

Zod: `AccountRequestSchemaDB` in `src/schema.ts`. Collection `MDB_COLLECTION_ACCOUNT_REQUESTS`, default `account_requests`.

Indexes: `{ id: 1 }` unique, `{ status: 1, created: -1 }`, `{ email_key: 1, status: 1 }`.

```json
{
  "id": "Xq3kP0aB",
  "email": "Friend@example.org",
  "email_key": "friend@example.org",
  "note": "who I am",
  "issuer": { "ip": "203.0.113.7", "ua": "Mozilla/5.0 …" },
  "created": "2026-10-19T11:24:54.650Z",
  "status": "approved",
  "decided": "2026-10-19T11:25:17.000Z",
  "invite_id": "pJ3x0aZq"
}
```

| Field | Notes |
| :--- | :--- |
| `id` | 8 chars base64url, used in admin routes and the notification link. |
| `email` | Normalised (domain lowercased). `email_key` is fully lowercased and finds an earlier pending request. |
| `note` | ≤ 1000 chars. |
| `issuer` | Who sent it, as in token logs. |
| `status` | `pending` → `approved` or `rejected`, decided once. |
| `decided` | When the admin decided; `null` while pending. |
| `invite_id` | The invite an approval created. |
