# MongoDB Upload Document Model

Canonical specification for MongoDB upload documents stored in the database.

## Database & Collection Configuration

| Property | Environment Variable / Default | Description |
| :--- | :--- | :--- |
| **Collection Name** | `MDB_COLLECTION_UPLOADS` (default: `uploads`) | Main MongoDB collection for all uploads. |
| **Unique Index** | `{ id_pub: 1 }` (unique) | Enforces unique public ID constraints. |
| **Query Index** | `{ when: -1, id_pub: 1 }` | Powers fast feed queries and chronological sorting. |

## Document Architecture (Discriminated Union)

The upload document collection uses a discriminated union pattern on the `type` field:
- **Files / Album / Playlist Documents**: Contains embedded `files: FileItem[]` array.
- **Link Documents**: Contains embedded `link: { redir: string }` redirect object.

---

## Document Schemas

### 1. Files / Album / Playlist Document Model

```json
{
  "_id": "66c72e29f0a4a56c0b112233",
  "id_pub": "123XABCD",
  "type": "files",
  "public": true,
  "status": "ready",
  "meta": {
    "title": "Example Release",
    "desc": "Release description"
  },
  "stat": {
    "views": 10,
    "up": 0,
    "down": 3
  },
  "issuer": {
    "ip": "127.0.0.1",
    "ua": "Mozilla/5.0 ...",
    "uuid": "4f9d2a6e-..."
  },
  "files": [
    {
      "filename": "render.png",
      "size": 123456,
      "mime": "image/png",
      "hashkey256": "3a7d55b0...4e21",
      "stat_dl": 2
    },
    {
      "filename": "archive.zip",
      "size": 9876543,
      "mime": "application/zip",
      "hashkey256": "e3b0c442...b855",
      "stat_dl": 1
    }
  ],
  "when": "2026-08-22T12:00:00.000Z"
}
```

### 2. Link Document Model

```json
{
  "_id": "66c72e29f0a4a56c0b112234",
  "id_pub": "124XABCD",
  "type": "link",
  "public": true,
  "status": "ready",
  "meta": {
    "title": "Redirect Resource",
    "desc": "Link destination note"
  },
  "stat": {
    "views": 5,
    "up": 0,
    "down": 0
  },
  "issuer": {
    "ip": "127.0.0.1",
    "ua": "Mozilla/5.0 ...",
    "uuid": "4f9d2a6e-..."
  },
  "link": {
    "redir": "https://example.com/target"
  },
  "when": "2026-08-22T12:00:00.000Z"
}
```

---

## Field Specifications

### Common Document Fields

| Field | Type | Required | Default | Description |
| :--- | :--- | :---: | :--- | :--- |
| `_id` | `ObjectId` | Auto | Generated | MongoDB primary key. Excluded from client API responses. |
| `id_pub` | `string` | Yes | — | Unique 8–10 character alphanumeric public identifier (e.g. `123XABCD`). |
| `type` | `string` | Yes | — | Discriminated union key: `"files" \| "album" \| "playlist" \| "link" \| "note"`. |
| `public` | `boolean` | Yes | `false` | When `true`, visible on public feed. When `false`, unlisted. |
| `status` | `string` | Yes | `"processing"` | Upload lifecycle status: `"processing" \| "ready" \| "error" \| "removed"`. |
| `meta.title` | `string` | Yes | `""` | Upload title. Max `MAX_TITLE_LENGTH_PER_UPLOAD` characters. |
| `meta.desc` | `string` | Yes | `""` | Upload description. Max `MAX_DESC_LENGTH_PER_UPLOAD` characters. |
| `stat.views` | `number` | Yes | `0` | Total view count. |
| `stat.up` | `number` | Yes | `0` | Upvotes count (reserved). |
| `stat.down` | `number` | Yes | `0` | Downvotes or aggregate download count. |
| `issuer.ip` | `string` | Yes | — | Client IP address at time of upload (internal only). |
| `issuer.ua` | `string` | Yes | — | Client `User-Agent` header (internal only). |
| `issuer.uuid` | `string` | Yes | — | Client instance tracking UUID (internal only). |
| `when` | `string` | Yes | — | ISO 8601 creation timestamp. |

### File Item Fields (`files[]`)

| Field | Type | Description |
| :--- | :--- | :--- |
| `filename` | `string` | Sanitized original filename. |
| `size` | `number` | File payload size in bytes. |
| `mime` | `string` | Detected MIME type from WASM magic header analysis. |
| `hashkey256` | `string` | 64-char lowercase hex SHA-256 hash. Matches blob filename in `STORAGE_DIR`. |
| `stat_dl` | `number` | Download count specifically for this file. |

### Link Object Fields (`link`)

| Field | Type | Description |
| :--- | :--- | :--- |
| `link.redir` | `string` | Destination URL target. |

---

## Automatic Type Classification Matrix

Uploaded files are classified by the server based on detected MIME types:

```mermaid
graph TD
    Upload[Incoming Upload] --> CheckMIME{Check all file MIME types}
    CheckMIME -->|All image/* or video/*| Album[type = "album"]
    CheckMIME -->|All audio/*| Playlist[type = "playlist"]
    CheckMIME -->|Mixed or other MIME types| Files[type = "files"]
    UploadLink[Link Upload] --> Link[type = "link"]
```

| Evaluated MIME Types | Assigned `type` | Client Rendering Semantics |
| :--- | :--- | :--- |
| All files are `image/*` or `video/*` | `"album"` | Rendered in grid/gallery view with media preview cards. |
| All files are `audio/*` | `"playlist"` | Rendered as sequential audio tracks with playback controls. |
| Mixed MIME types or non-media (e.g. `application/*`, `text/*`) | `"files"` | Rendered as generic downloadable file list. |
| Direct URL redirect upload | `"link"` | Fast redirect or link preview card. |
| Plain-text note (`POST /api/v2/unote`) | `"note"` | Text stored inline as `note: { text }`, no files; see `frontend_note_upload.md`. |
