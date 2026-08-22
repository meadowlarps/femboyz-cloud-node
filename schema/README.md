# Schema & Protocol Documentation

Specifications for frontend API protocols, binary streaming interfaces, and internal database models.

## Document Index

| Document | Protocol / Scope | Method & Path | Description |
| :--- | :--- | :--- | :--- |
| **[frontend_feed.md](./frontend_feed.md)** | Public Feed | `GET /api/v2/feed` | Paginated public upload feed with range slicing, sorting, and privacy invariants. |
| **[frontend_file_prerequest_askMaxFileUploadSize.md](./frontend_file_prerequest_askMaxFileUploadSize.md)** | Upload Limits | `GET /api/v2/maxfsize` | Dynamic server capacity check and form constraint boundaries. |
| **[frontend_file_upload.md](./frontend_file_upload.md)** | Binary File Stream | `POST /api/v2/udstream` | Single-request streaming upload with Base64 `X-Meta` header and binary chunk validation. |
| **[frontend_link_upload.md](./frontend_link_upload.md)** | Link Upload | `POST /api/v2/ulink` | URL redirect creation with ping verification. |
| **[frontend_upload_receiveByID.md](./frontend_upload_receiveByID.md)** | Content Delivery | `GET /:id`, `GET /:id/:fid` | Landing page rendering, text unfurling, JSON metadata, and byte-range binary streaming. |
| **[frontend_upload_viewed.md](./frontend_upload_viewed.md)** | Upload Views | `POST /api/v2/viewed/:id` | Atomic interactive view counting with in-memory public feed refresh. |
| **[mongo_upload.md](./mongo_upload.md)** | Database Schema | MongoDB `uploads` | Discriminated union document model, indexing, and MIME classification rules. |

---

## Architectural Highlights

- **Single-Stream Multiplexing**: Multi-file uploads (`/api/v2/udstream`) transfer all files in a single continuous HTTP stream without multi-part boundary overhead.
- **Content Negotiation**: `/:id` serves HTML landing pages to browsers, JSON descriptors to API clients, plain-text unfurl snippets to bots, and 302 redirects for links.
- **Filesystem Deduplication**: Disk storage identifies blobs by lowercase SHA-256 hash. Duplicate uploads reuse existing storage blocks.
- **Privacy & Sanitization**: Public feeds and unauthenticated endpoints omit issuer telemetry (`ip`, `ua`, `uuid`) and internal disk hashes (`hashkey256`).
