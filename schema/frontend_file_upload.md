# Binary Stream File Upload Protocol

Canonical protocol specification for uploading single or multi-file payloads via a single streaming HTTP request.

## Endpoint

| Property | Specification |
| :--- | :--- |
| **Method** | `POST` |
| **Path** | `/api/v2/udstream` |
| **Authentication** | None (optional `X-Upload-Token` raises limits, see [frontend_upload_token.md](./frontend_upload_token.md)) |
| **Content-Type** | `application/octet-stream` |

## Architecture & Request Format

File uploads are completed in a **single streaming HTTP request**:
1. Metadata is serialized to JSON, Base64-encoded, and sent via the `X-Meta` HTTP header.
2. The binary data of all files is concatenated into a continuous byte stream and sent as the HTTP request body without delimiters.
3. The server uses the `bytes` field from the metadata entries to sequentially slice chunks from the binary stream.

```http
POST /api/v2/udstream HTTP/1.1
Host: femboyz.cloud
Content-Type: application/octet-stream
Content-Length: 108161272
X-Meta: eyJ0eXBlIjoiZmlsZXMiLCJpc19wdWJsaWMiOnRydWUsIm1ldGEiOnsidGl0bGUiOiJNeSBVcGxvYWQiLCJkZXNjIjoiRXhhbXBsZSBmaWxlcyJ9LCJmaWxlcyI6W3siZmlsZW5hbWUiOiJleGFtcGxlLnBuZyIsInNoYTI1NiI6IjNhN2Q...IiwiYnl0ZXMiOjEyMzQ1Nn1dfQ==

<binary stream: file1_bytes + file2_bytes + ...>
```

## Required HTTP Headers

| Header | Type | Required | Constraints / Description |
| :--- | :--- | :---: | :--- |
| `Content-Type` | String | Yes | Must be literal `application/octet-stream`. |
| `Content-Length` | Integer | Yes | Total byte count of the concatenated request body. Must be `>= MIN_FILE_SIZE` and within remaining storage headroom. |
| `X-Meta` | String | Yes | Base64-encoded UTF-8 string of the `XMetaFiles` JSON payload. |
| `X-Upload-Token` | String | No | Admin-issued upload token. Uses one of its uses and replaces the default count/size limits for this upload. |

## `X-Meta` Payload Specification

### Decoded JSON Structure

```json
{
  "type": "files",
  "is_public": true,
  "meta": {
    "title": "Album Title",
    "desc": "Detailed upload description"
  },
  "files": [
    {
      "filename": "render.png",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "bytes": 123456
    },
    {
      "filename": "track.mp3",
      "sha256": "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
      "bytes": 8923751
    }
  ]
}
```

### `X-Meta` Field Rules

| Field | Type | Required | Default | Validation & Constraints |
| :--- | :--- | :---: | :--- | :--- |
| `type` | `"files"` | Yes | — | Must be literal `"files"`. Server re-classifies post-upload. |
| `is_public` | `boolean` | Yes | — | `true` to display in public feed `/api/v2/feed`; `false` for unlisted direct-link access. |
| `meta.title` | `string` | Yes | — | Max length: `MAX_TITLE_LENGTH_PER_UPLOAD` (default: 255). |
| `meta.desc` | `string` | Yes | — | Max length: `MAX_DESC_LENGTH_PER_UPLOAD` (default: 1024). |
| `files` | `Array` | Yes | — | 1 or more file objects. The count is checked against the effective limits: `MAX_FILE_COUNT_PER_UPLOAD` (default 6), or the token's `max_files`. |
| `files[].filename` | `string` | Yes | — | Max length: 255 characters, non-empty. |
| `files[].sha256` | `string` | Yes | — | Exactly 64-character lowercase hex SHA-256 digest of that file's bytes. |
| `files[].bytes` | `number` | Yes | — | Non-negative integer `>= MIN_FILE_SIZE`. Exact byte length of this file chunk in the body stream. |

## Client Encoding & Sending

```typescript
// 1. Compute SHA-256 hash and byte size for each file
// 2. Build metadata object and Base64 encode it
const xmeta = {
  type: "files",
  is_public: isPublic,
  meta: { title, desc },
  files: fileEntries // [{ filename, sha256, bytes }]
}
const xmetaBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(xmeta))))

// 3. Concatenate binary file blobs and POST
const bodyBlob = new Blob(files)
await fetch("/api/v2/udstream", {
  method: "POST",
  headers: {
    "Content-Type": "application/octet-stream",
    "Content-Length": bodyBlob.size.toString(),
    "X-Meta": xmetaBase64
  },
  body: bodyBlob
})
```

## Server Processing Pipeline

1. **Storage Capacity Pre-Check**: Checks `Content-Length` against remaining disk headroom; rejects with `507` if insufficient.
2. **Header Parse & Validation**: Base64 decodes `X-Meta` and validates against `XMetaFilesSchema` (Zod); rejects with `400` on failure.
2a. **Token Reservation** (only with `X-Upload-Token`): atomically spends one token use; rejects with `403 {"error": "Token <reason>"}` if unknown/revoked/expired/exhausted.
2b. **Limit Check**: file count, each file's `bytes`, and the total are checked against the effective limits (env defaults or the token's limits, capped by free storage); rejects with `400`. If a token was reserved it is released.
3. **Stream Chunking**: Iterates the incoming binary stream, slicing exact `bytes` count for each entry in `files`.
4. **Integrity Hash Verification**: Computes SHA-256 incrementally on each chunk; rejects with `400` if calculated hash does not match `sha256`.
5. **MIME Type Detection**: Inspects initial chunk bytes via `WASMagic` to reliably detect true MIME type.
6. **Automatic Classification**:
   - All `image/*` or `video/*` $\to$ `"album"`
   - All `audio/*` $\to$ `"playlist"`
   - Mixed or other $\to$ `"files"`
7. **Storage Deduplication**: Writes unique blob named by SHA-256 hash into storage directory. If blob exists, reuses existing blob on disk.
8. **DB Persistence**: Generates unique `id_pub` and creates document in MongoDB (`issuer.token` = `id_token` if a token was used).
9. **Token Audit**: With a token, every outcome (`ok` / `failed` / `rejected`) is written to `token_uses`; a failed upload gives its use back.

## Successful Response (`HTTP 200`)

```json
{
  "id": "123XABCD",
  "type": "files"
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Generated public alphanumeric ID (e.g. `123XABCD`). |
| `type` | `"files" \| "album" \| "playlist"` | Resulting classified upload category. |

## Error Responses

| Status | Error Body | Cause |
| :--- | :--- | :--- |
| `400 Bad Request` | `{"error": "Bad request"}` | Malformed `X-Meta` JSON, failed Zod validation, SHA-256 digest mismatch, stream truncated or byte length mismatch. |
| `507 Insufficient Storage` | `{"error": "Storage limit exceeded"}` | Upload payload exceeds current available server storage capacity. |
| `500 Internal Server Error` | `{"error": "Internal server error"}` | Filesystem or database failure during persistence. |
