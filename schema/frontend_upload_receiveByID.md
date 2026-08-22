# Upload Retrieval & File Delivery Protocol

Canonical protocol specification for fetching upload metadata, rendering landing pages, unfurling previews, handling link redirects, and streaming individual files.

## Route Map

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/:id` | Main upload entrypoint: 302 redirect, HTML landing page, text preview, or JSON metadata. |
| `GET` | `/:id/:fid` | Direct raw file delivery by 0-based file index (`fid`). |
| `HEAD` | `/:id/:fid` | File headers only (Content-Type, Content-Length, Content-Disposition, byte ranges). |

---

## 1. Main Entrypoint: `GET /:id`

Behavior varies depending on upload `type` and the incoming `Accept` header.

### A. Link Uploads (`type: "link"`)

- **Default / Browser Request**: Returns `HTTP 302 Found` redirect to the destination URL:
  ```http
  HTTP/1.1 302 Found
  Location: https://example.com/target-resource
  ```
- **JSON Request (`Accept: application/json`)**: Returns link metadata payload:
  ```json
  {
    "id": "123XABCD",
    "type": "link",
    "public": true,
    "meta": {
      "title": "Example Link",
      "desc": "Description"
    },
    "files": [],
    "link": "https://example.com/target-resource",
    "when": "2026-08-22T12:00:00.000Z"
  }
  ```

### B. File Uploads (`type: "files" | "album" | "playlist"`)

#### 1. JSON Metadata (`Accept: application/json`)

Returns full upload metadata and descriptors for each contained file:

```json
{
  "id": "123XABCD",
  "type": "files",
  "public": true,
  "meta": {
    "title": "Project Archive",
    "desc": "Source code and binaries"
  },
  "views": 42,
  "files": [
    {
      "index": 0,
      "filename": "bundle.zip",
      "size": 1048576,
      "mime": "application/zip",
      "url": "https://femboyz.cloud/123XABCD/0",
      "stat_dl": 7
    },
    {
      "index": 1,
      "filename": "notes.txt",
      "size": 2048,
      "mime": "text/plain",
      "url": "https://femboyz.cloud/123XABCD/1",
      "stat_dl": 2
    }
  ],
  "when": "2026-08-22T12:00:00.000Z"
}
```

#### 2. Plain Text Preview (`Accept: text/plain` without `text/html`)

Used by bots and chat crawlers (e.g. Discord, Telegram) for link unfurling and previews:

| Upload Type | Text Format Preview |
| :--- | :--- |
| `album` (all images) | `${title}\n${count} image(s) via ${siteName}` |
| `album` (all videos) | `${title}\n${count} video(s) via ${siteName}` |
| `album` (mixed media) | `${title}\n${count} media item(s) via ${siteName}` |
| `playlist` | `${title}\nPlaylist via ${baseUrl} (${count} audio(s))` |
| `files` | `${title}\n${count} file(s) via ${siteName}` |

#### 3. HTML Page (`Accept: text/html` or default browser navigation)

Renders an HTML landing page including OpenGraph `<meta>` tags (`og:title`, `og:url`, `og:type`, `og:image`, `og:video`, `og:description`) and links to all contained files (`/:id/:fid`).

---

## 2. Raw File Retrieval: `GET /:id/:fid`

Serves the raw binary file stream for a specific file index (`fid` = `0`, `1`, ...).

### URL Parameters & Query Options

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `:id` | String | Yes | Public upload identifier (e.g. `123XABCD`). |
| `:fid` | Integer | Yes | 0-based index of the target file in the upload (`0`, `1`, ...). |
| `?dl=1` | Query String | No | Force browser download attachment (`Content-Disposition: attachment`). Omitted defaults to `inline`. |

### Security & Delivery Headers

Every file response sets strict browser sandbox and content headers:

| Header | Value / Behavior |
| :--- | :--- |
| `Content-Type` | Detected file MIME type (e.g. `image/png`, `video/mp4`, `application/zip`). |
| `Content-Disposition` | `inline; filename="foo.png"` (default) or `attachment; filename="foo.png"` (when `?dl=1`). |
| `Content-Security-Policy` | `sandbox` (prevents execution of untrusted scripts or active content). |
| `X-Content-Type-Options` | `nosniff` (prevents MIME sniffing). |
| `Accept-Ranges` | `bytes` (advertises byte-range support for media streaming and resumed transfers). |
| `Content-Length` | Exact byte length of the returned payload (or ranged slice). |

### HTTP Byte-Range Streaming (`Range: bytes=start-end`)

The server supports HTTP byte-range requests for audio/video seeking and download resumption:

- **Full File Request**: Returns `HTTP 200 OK` with whole file payload.
- **Ranged Request**: Returns `HTTP 206 Partial Content` with `Content-Range: bytes start-end/total`.
- **Invalid Range**: Returns `HTTP 416 Range Not Satisfiable` with `Content-Range: bytes */total`.

### Download Metric Accounting

- Increments `files[fid].stat_dl` and `stat.down` **only** when a full-file download is triggered (`?dl=1` without `Range` header).
- Partial ranged requests (e.g. audio/video seeking) do not inflate download statistics.

---

## Error Responses

| Status | Error Body | Cause |
| :--- | :--- | :--- |
| `400 Bad Request` | `{"error": "Bad request"}` | Invalid `:fid` format (non-integer or negative). |
| `404 Not Found` | `{"error": "Not found"}` | Upload `:id` does not exist, `:fid` out of range, or attempting to fetch `:fid` on a `link` upload. |
| `416 Range Not Satisfiable` | *(Empty)* | Requested HTTP `Range` is out of bounds for the target file. |
