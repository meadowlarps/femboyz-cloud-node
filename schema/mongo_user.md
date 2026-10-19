# MongoDB account schemas: users, codes, sessions

Zod: `UserSchemaDB` in `src/schema.ts`. Indexes: `account_indexes_ensure` in `src/database.ts`, created at boot when accounts are on.

## `users` (`MDB_COLLECTION_USERS`, default `users`)

Indexes: `{ id_user: 1 }` unique, `{ username: 1 }` unique, `{ "external_email.key": 1 }` unique where it is a string.

```json
{
  "id_user": "cd028969-1f1e-4008-b847-f68f97652dbc",
  "username": "alice",
  "password_hash": "$argon2id$v=19$m=19456,t=2,p=1$…",
  "external_email": { "address": "Alice@example.org", "key": "alice@example.org", "verified_at": "2026-10-19T11:15:52.818Z" },
  "status": "active",
  "created": "2026-10-19T11:08:23.735Z",
  "invite_id": "pJ3x0aZq",
  "services": {
    "mail": {
      "enabled": true,
      "stalwart_id": "e",
      "quota_bytes": 1073741824,
      "redirect": { "enabled": true, "keep_copy": true, "bounces": 0 }
    }
  }
}
```

| Field | Notes |
| :--- | :--- |
| `id_user` | UUID; the OIDC `sub`. Never changes. |
| `username` | Lowercase, immutable, also the mail local part. |
| `password_hash` | argon2id (`@node-rs/argon2` defaults: 19 MiB, t=2, p=1). |
| `external_email` | Only verified addresses are stored; pending ones live in `email_codes`. `address` keeps the local part's case and lowercases the domain; `key` is fully lowercased and is what uniqueness uses. `null` = none. |
| `status` | `active`, `disabled`, or `deleting`. New signups stay disabled until provisioning finishes. Deleting users are hidden from inventory and cannot log in or be re-enabled. |
| `delete_after` | Optional ISO timestamp. Deletions keep the disabled mailbox and username reserved for 11 minutes, until issued mail JWTs expire; a worker then destroys the mailbox and user. Survives restarts. |
| `services.mail.stalwart_id` | Stalwart account id (also its JMAP `accountId`). `null` only during signup. |
| `services.mail.redirect.bounces` | Hard bounces since forwarding was last turned on. |

## `email_codes` (`MDB_COLLECTION_EMAIL_CODES`)

Indexes: `{ subject: 1, created: -1 }`, `{ address_key: 1, created: -1 }`, TTL on `purge_at`.

| Field | Notes |
| :--- | :--- |
| `subject` | `user:<id_user>` (account settings) or `invite:<id>` (signup). |
| `address`, `address_key` | Destination; the key is lowercased. |
| `code_hmac` | `HMAC-SHA256(EMAIL_CODE_SECRET, code \n address_key \n subject)`, hex. The code itself is never stored. |
| `attempts` | Attempts reserved atomically before comparison. At `EMAIL_CODE_MAX_ATTEMPTS` (5) a wrong guess burns the code. A matching code is consumed atomically before the guarded mutation. |
| `created`, `expires` | `expires` = created + `EMAIL_CODE_TTL_MINUTES` (10). |
| `purge_at` | `expires` + 1 day, so the per-day limits can still count the code. |
| `used` | Set when consumed, burned, or replaced by a newer code for the same subject. |

Limits enforced in `code_send`: 60 s between codes per subject, 5 per subject per hour, 10 per subject per day, 5 per destination address per day. Plus 10 sends per IP per hour in the routes.

Send operations take subject and destination locks, and account mutations share a per-user lock and reload state. These locks are per process, like `authlimit`; move them to a shared store before running multiple API processes.

## `web_sessions` (`MDB_COLLECTION_WEB_SESSIONS`)

The femboyz.cloud site session. Indexes: `{ token_hash: 1 }` unique, `{ id_user: 1 }`, TTL on `expires`.

```json
{ "token_hash": "<sha256 hex of the fbz_session cookie>", "id_user": "…", "sid": "<provider session id>", "created": "<Date>", "expires": "<Date, +14 days>" }
```

## `oidc` (`MDB_COLLECTION_OIDC`)

oidc-provider's storage, one collection for all models (Session, Interaction, AuthorizationCode, AccessToken, RefreshToken, Grant, …).

```json
{ "_id": "Session:<id>", "model": "Session", "payload": { … }, "expiresAt": "<Date>", "uid": "…", "grantId": "…" }
```

Indexes: `{ model: 1, uid: 1 }`, `{ model: 1, userCode: 1 }`, `{ grantId: 1 }`, TTL on `expiresAt`. Disabling or deleting a user deletes every document whose `payload.accountId` is theirs.
