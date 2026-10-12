# Note Upload Protocol

Canonical protocol specification for sharing plain-text notes.

## Endpoint

| Property | Specification |
| :--- | :--- |
| **Method** | `POST` |
| **Path** | `/api/v2/unote` |
| **Authentication** | None |
| **Content-Type** | `application/json` |
| **Body limit** | 2 MiB (fits a worst-case 100k-char note after JSON escaping) |

## Request Body (`application/json`)

```json
{
  "type": "note",
  "is_public": false,
  "meta": { "title": "Shopping list" },
  "text": "- milk\n- eggs"
}
```

## Request Schema & Field Validation (`NoteUploadSchema`)

| Field | Type | Required | Constraints / Validation |
| :--- | :--- | :---: | :--- |
| `type` | `"note"` | Yes | Must be literal string `"note"`. |
| `text` | `string` | Yes | At most `MAX_NOTE_LENGTH` UTF-16 code units (default `100000`), must not be blank. Stored verbatim — whitespace is preserved. |
| `is_public` | `boolean` | No | Default `false`. Public notes appear in `/api/v2/feed`. |
| `meta.title` | `string` | No | Trimmed, at most `MAX_TITLE_LENGTH_PER_UPLOAD`. Default `""`. |

The client reads the limit from `max_note_length` in `GET /api/v2/maxfsize`.

## Successful Response (`HTTP 200`)

```json
{ "message": "Unote successful", "id": "123XABCD" }
```

## Reading a note

| Request | Response |
| :--- | :--- |
| `GET /:id` + `Accept: application/json` | Upload JSON with `files: []`, `note` (full text), `note_preview`, `note_length` |
| `GET /:id` + `Accept: text/plain` | Raw note text, `text/plain; charset=utf-8` |
| `GET /:id` (HTML) | Minimal HTML page with OG tags; the SvelteKit app renders the real page |
| `GET /:id/:fid` | `404` — notes have no files |

Lists (`GET /api/v2/feed`, `GET /api/v2/uploads`, admin uploads) never carry the full text: they include `note_preview` (first 280 chars, never splitting a surrogate pair) and `note_length` only.

## Error Responses

| Status | Error Body | Cause |
| :--- | :--- | :--- |
| `400 Bad Request` | `{"error": "Bad request"}` | Invalid JSON, blank text, text or title over the limit. |
| `500 Internal Server Error` | `{"error": "Internal server error"}` | Database insertion failure. |
