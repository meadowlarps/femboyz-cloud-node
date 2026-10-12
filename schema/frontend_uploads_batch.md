# Upload Batch Protocol

Canonical protocol specification for fetching several uploads' JSON descriptors in one request. Used by the home page's "your uploads" grid instead of one `GET /:id` per card.

## Endpoint

| Property | Specification |
| :--- | :--- |
| **Method** | `GET` |
| **Path** | `/api/v2/uploads` |
| **Authentication** | None |
| **Request Body** | None |
| **Content-Type** | `application/json` |

## Query Parameters

| Parameter | Type | Required | Constraints / Validation |
| :--- | :--- | :---: | :--- |
| `ids` | Comma-separated strings | Yes | 1–100 upload IDs after trimming and de-duplication; each at most 32 characters. |

```http
GET /api/v2/uploads?ids=123XABCD,456YEFGH
```

## Server-Side Processing

1. Resolves all IDs with a single MongoDB `{ id_pub: { $in: ids } }` query (served by the unique `id_pub` index).
2. Returns found uploads in the requested order; IDs with no document are listed in `missing`.

Like `GET /:id`, any upload whose ID is known can be fetched — `public` only controls feed visibility. The endpoint never counts views or downloads.

## Response Schema (`HTTP 200`)

Each item is identical to the `GET /:id` JSON descriptor (`Accept: application/json`), see [frontend_upload_receiveByID.md](./frontend_upload_receiveByID.md). Link uploads carry `files: []` and `link`.

```json
{
  "items": [
    {
      "id": "123XABCD",
      "type": "album",
      "public": false,
      "meta": { "title": "Example", "desc": "" },
      "views": 3,
      "when": "2026-08-22T12:00:00.000Z",
      "files": [
        {
          "index": 0,
          "filename": "photo.png",
          "size": 123456,
          "mime": "image/png",
          "url": "https://femboyz.cloud/123XABCD/0",
          "stat_dl": 0
        }
      ]
    }
  ],
  "missing": ["456YEFGH"]
}
```

## Responses

| Status | Body | Cause |
| :--- | :--- | :--- |
| `200 OK` | See above | Lookup succeeded (even if every ID is missing). |
| `400 Bad Request` | `{"error":"..."}` | `ids` absent, empty, over 100 IDs, or an ID longer than 32 characters. |
| `500 Internal Server Error` | `{"error":"..."}` | MongoDB query failed or a document is corrupt. |
