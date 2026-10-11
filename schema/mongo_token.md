# MongoDB Token Schemas

Zod: `UploadTokenSchemaDB`, `TokenUseSchemaDB` in `src/schema.ts`.

## `tokens` (`MDB_COLLECTION_TOKENS`, default `tokens`)

Indexes: `{ id_token: 1 }` unique, `{ token: 1 }` unique.

```json
{
  "id_token": "9F3A01BC",
  "token": "q2V0c2VjcmV0dG9rZW5fZXhhbXBsZTEy",
  "label": "friend",
  "limits": { "max_files": null, "max_bytes": 10737418240 },
  "uses_max": 3,
  "uses_count": 1,
  "expires_at": "2026-12-31T23:00:00.000Z",
  "revoked": false,
  "when": "2026-09-24T12:00:00.000Z"
}
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `id_token` | `string` | 8 uppercase hex chars. Public id used in admin routes, logs and `uploads.issuer.token`. |
| `token` | `string` | Secret stored in **plaintext** (visible to the admin): random 32-char base64url, or a custom value of 8–64 chars from `[A-Za-z0-9_-]` (`UPLOAD_TOKEN_REGEX`). |
| `label` | `string` | ≤ 100 chars. |
| `limits.max_files` | `int \| null` | `null` = unlimited (capped at 100). |
| `limits.max_bytes` | `int \| null` | Total bytes per upload. `null` = unlimited (capped by free storage). |
| `uses_max` | `int \| null` | `null` = unlimited uses. |
| `uses_count` | `int` | Uses spent so far, including in-flight reservations. |
| `expires_at` | `iso \| null` | Always stored via `toISOString()` so string comparison in filters is correct. |
| `revoked` | `boolean` | |
| `when` | `iso` | Creation time. |

## `token_uses` (`MDB_COLLECTION_TOKEN_USES`, default `token_uses`)

Index: `{ id_token: 1, when: -1 }`. Append-only audit log. Entries are kept when a token is deleted.

```json
{
  "id_token": "9F3A01BC",
  "outcome": "ok",
  "id_upload_pub": "123XABCD",
  "files": 4,
  "bytes": 5368709120,
  "issuer": { "ip": "1.2.3.4", "ua": "Mozilla/5.0 ...", "uuid": "not-implemented" },
  "when": "2026-09-24T12:05:00.000Z"
}
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `id_token` | `string` | `"unknown"` when the supplied token matched nothing. |
| `outcome` | `"ok" \| "failed" \| "rejected"` | `rejected` = refused before streaming (invalid token or limits), `failed` = stream/DB error after it was accepted. |
| `reason` | `string?` | Reject reason or error message. Prerequest rejections are prefixed with `prerequest:`. |
| `id_upload_pub` | `string?` | Only on `ok`. |
| `files`, `bytes` | `int` | Declared by X-Meta (actual bytes on `ok`). |
| `issuer` | `object` | Same shape as the upload issuer. |
