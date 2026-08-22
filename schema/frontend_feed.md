# Public Upload Feed Protocol

Canonical protocol specification for fetching the paginated public upload feed.

## Endpoint

| Property | Specification |
| :--- | :--- |
| **Method** | `GET` |
| **Path** | `/api/v2/feed` |
| **Authentication** | None |
| **Request Body** | None |
| **Content-Type** | `application/json` |

## Query Parameters

Query range is **start-inclusive** and **end-exclusive** (`[start, end)`).

| Parameter | Type | Required | Default | Constraints / Validation |
| :--- | :--- | :---: | :--- | :--- |
| `s` | Integer | No | `0` | Non-negative integer (`>= 0`). Start index in the sorted feed. |
| `e` | Integer | No | `s + 20` | Positive integer (`> s`). End index in the sorted feed. Must satisfy `e - s <= 100`. |

### Query Examples

```http
GET /api/v2/feed             # Returns items at indices 0 through 19 (first 20 items)
GET /api/v2/feed?s=20        # Returns items at indices 20 through 39 (next 20 items)
GET /api/v2/feed?s=20&e=40   # Returns items at indices 20 through 39 (explicit range)
```

## Sorting & Invariant Rules

- **Visibility**: Only uploads with `public: true` are served in the feed.
- **Sort Order**: Sorted primarily by `when` descending (newest first).
- **Tie Breaker**: Equal timestamps are tie-broken by `id_pub` ascending.
- **In-Memory Feed**: Synchronized in-memory array loaded during boot and updated on create/delete events.
- **Range Overflow**: Requesting a start index `s >= total` returns an empty `items: []` array with `has_more: false`.

## Response Schema (`HTTP 200`)

```json
{
  "items": [
    {
      "id": "123XABCD",
      "type": "files",
      "meta": {
        "title": "Example files upload",
        "desc": "Optional description text"
      },
      "views": 0,
      "when": "2026-08-22T12:00:00.000Z",
      "files": [
        {
          "index": 0,
          "filename": "screenshot.png",
          "size": 123456,
          "mime": "image/png",
          "url": "https://femboyz.cloud/123XABCD/0",
          "stat_dl": 0
        }
      ]
    },
    {
      "id": "124XABCD",
      "type": "link",
      "meta": {
        "title": "Example link upload",
        "desc": "Link destination note"
      },
      "views": 0,
      "when": "2026-08-21T12:00:00.000Z",
      "files": [],
      "link": "https://example.com"
    }
  ],
  "start": 0,
  "end": 20,
  "total": 37,
  "has_more": true
}
```

### Top-Level Fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `items` | `FeedItem[]` | Slice of public feed uploads within requested range `[start, end)`. |
| `start` | `number` | Echoed starting index of the query window. |
| `end` | `number` | Echoed ending index of the query window. |
| `total` | `number` | Total number of currently available public uploads. |
| `has_more` | `boolean` | `true` if additional public uploads exist at or beyond index `end`. |

### Feed Item Fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Public upload identifier (8–10 alphanumeric chars). |
| `type` | `"files" \| "album" \| "playlist" \| "link"` | Classified upload type. |
| `meta.title` | `string` | Title of the upload (defaults to empty string). |
| `meta.desc` | `string` | Description text (defaults to empty string). |
| `views` | `number` | Total view count. |
| `when` | `string` | Upload creation timestamp in ISO 8601 format. |
| `files` | `FeedFileItem[]` | Array of file descriptors (always empty `[]` for `link` uploads). |
| `link` | `string` | Redirect destination URL (**present only when `type === "link"`**). |

### Feed File Item Fields (`FeedFileItem`)

| Field | Type | Description |
| :--- | :--- | :--- |
| `index` | `number` | 0-based file index within the upload (`0`, `1`, ...). |
| `filename` | `string` | Original sanitized filename. |
| `size` | `number` | File payload size in bytes. |
| `mime` | `string` | Detected MIME type (via WASM magic inspection). |
| `url` | `string` | Fully qualified URL to access/download raw file (`${BASE_URL}/${id}/${index}`). |
| `stat_dl` | `number` | Total complete download count for this file. |

## Excluded Fields (Security & Privacy Invariants)

The public feed explicitly omits internal storage and client privacy fields:
- `issuer.ip`, `issuer.ua`, `issuer.uuid` (Client identifying metadata)
- `files[].hashkey256` (Underlying filesystem blob SHA-256 hash)
- `status` (Internal state, only `"ready"` public items appear in feed)

## Error Responses

| Status | Error Response Body | Trigger Condition |
| :--- | :--- | :--- |
| `400 Bad Request` | `{"error": "Bad request"}` | `s < 0`, `e <= s`, `e - s > 100`, or non-integer query values. |
