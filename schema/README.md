# Schema & Protocol Documentation

Specifications for frontend API protocols, binary streaming interfaces, and internal database models.

## Document Index

| Document | Protocol / Scope | Method & Path | Description |
| :--- | :--- | :--- | :--- |
| **[frontend_feed.md](./frontend_feed.md)** | Public Feed | `GET /api/v2/feed` | Paginated public upload feed with range slicing, sorting, and privacy invariants. |
| **[frontend_file_prerequest_askMaxFileUploadSize.md](./frontend_file_prerequest_askMaxFileUploadSize.md)** | Upload Limits | `GET /api/v2/maxfsize` | Dynamic server capacity check and form constraint boundaries. |
| **[frontend_file_upload.md](./frontend_file_upload.md)** | Binary File Stream | `POST /api/v2/udstream` | Single-request streaming upload with Base64 `X-Meta` header and binary chunk validation. |
| **[frontend_link_upload.md](./frontend_link_upload.md)** | Link Upload | `POST /api/v2/ulink` | URL redirect creation with ping verification. |
| **[frontend_note_upload.md](./frontend_note_upload.md)** | Note Upload | `POST /api/v2/unote` | Plain-text note sharing (up to 100k chars), stored inline in MongoDB. |
| **[frontend_upload_receiveByID.md](./frontend_upload_receiveByID.md)** | Content Delivery | `GET /:id`, `GET /:id/:fid` | Landing page rendering, text unfurling, JSON metadata, and byte-range binary streaming. |
| **[frontend_uploads_batch.md](./frontend_uploads_batch.md)** | Upload Batch | `GET /api/v2/uploads?ids=` | Several upload JSON descriptors in one request (home page history grid). |
| **[frontend_upload_viewed.md](./frontend_upload_viewed.md)** | Upload Views | `POST /api/v2/viewed/:id` | Atomic interactive view counting with in-memory public feed refresh. |
| **[frontend_upload_token.md](./frontend_upload_token.md)** | Upload Tokens | `X-Upload-Token`, `/api/v2/admin/tokens` | Admin-issued tokens with custom per-upload limits, single-use-per-entry flow, and audit log. |
| **[frontend_account_login.md](./frontend_account_login.md)** | Accounts: Login | `/oidc/*`, `/oidc/interaction/:uid/*`, `/api/v2/account/session/*` | OIDC provider, Stalwart access token, login interaction and the site session. |
| **[frontend_account_signup.md](./frontend_account_signup.md)** | Accounts: Signup | `/api/v2/account/request`, `/invite/:code`, `/available`, `/signup*` | Access requests, invite checks, username rules and signup with an optional verified external email. |
| **[frontend_account_settings.md](./frontend_account_settings.md)** | Accounts: Settings | `/api/v2/account/me*` | External email with 4-digit codes, forwarding (Sieve), quota. |
| **[frontend_account_admin.md](./frontend_account_admin.md)** | Accounts: Admin | `/api/v2/admin/account/*`, `/api/v2/account/stalwart/webhook` | Requests, invites, users, and the bounce webhook. |
| **[mongo_user.md](./mongo_user.md)** | Database Schema | MongoDB `users`, `email_codes`, `web_sessions`, `oidc` | Accounts, verification codes, site sessions and OIDC provider storage. |
| **[mongo_account_request.md](./mongo_account_request.md)** | Database Schema | MongoDB `account_requests` | Access requests. |
| **[mongo_invite.md](./mongo_invite.md)** | Database Schema | MongoDB `invites` | Invites, stored as code hashes. |
| **[mongo_token.md](./mongo_token.md)** | Database Schema | MongoDB `tokens`, `token_uses` | Token documents and usage audit entries. |
| **[mongo_upload.md](./mongo_upload.md)** | Database Schema | MongoDB `uploads` | Discriminated union document model, indexing, and MIME classification rules. |

---

## Architectural Highlights

- **Single-Stream Multiplexing**: Multi-file uploads (`/api/v2/udstream`) transfer all files in a single continuous HTTP stream without multi-part boundary overhead.
- **Content Negotiation**: `/:id` serves HTML landing pages to browsers, JSON descriptors to API clients, plain-text unfurl snippets to bots, and 302 redirects for links.
- **Filesystem Deduplication**: Disk storage identifies blobs by lowercase SHA-256 hash. Duplicate uploads reuse existing storage blocks.
- **Privacy & Sanitization**: Public feeds and unauthenticated endpoints omit issuer telemetry (`ip`, `ua`, `uuid`) and internal disk hashes (`hashkey256`).
