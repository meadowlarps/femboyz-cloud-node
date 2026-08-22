# Max File Upload Size Pre-Request Protocol

Canonical protocol specification for fetching dynamic upload limits and validation constraints before sending files.

## Endpoint

| Property | Specification |
| :--- | :--- |
| **Method** | `GET` |
| **Path** | `/api/v2/maxfsize` |
| **Authentication** | None |
| **Request Body** | None |
| **Content-Type** | `application/json` |

## Purpose & Lifecycle

Clients call this endpoint during page initialization or before initiating an upload flow to:
1. Determine the maximum acceptable combined payload size given current remaining server disk capacity.
2. Configure client-side form validation bounds (max files count, title length, description length).
3. Disable upload interactions when the server is near full disk capacity.

## Server Limit Calculation

The maximum combined upload size (`maxsize`) is computed dynamically:
$$\text{maxsize} = \min(\text{MAX\_FILE\_SIZE} \times \text{MAX\_FILE\_COUNT\_PER\_UPLOAD},\; \text{STORAGE\_LIMIT\_BYTES} - \text{storageUsage})$$

## Response Schema (`HTTP 200`)

```json
{
  "maxsize": 104857600,
  "maxsizeperfile": 52428800,
  "maxcount": 6,
  "max_title_length": 255,
  "max_desc_length": 1024
}
```

## Response Fields

| Field | Type | Unit / Range | Server Source Env | Description |
| :--- | :--- | :--- | :--- | :--- |
| `maxsize` | `number` | Bytes | Dynamic | Maximum total upload payload bytes currently acceptable by the server. |
| `maxsizeperfile` | `number` | Bytes | `MAX_FILE_SIZE` | Hard cap on the size of any single file. |
| `maxcount` | `number` | Integer | `MAX_FILE_COUNT_PER_UPLOAD` | Maximum number of files permitted in a single upload (default: 6). |
| `max_title_length` | `number` | Characters | `MAX_TITLE_LENGTH_PER_UPLOAD` | Maximum character length for upload title (default: 255). |
| `max_desc_length` | `number` | Characters | `MAX_DESC_LENGTH_PER_UPLOAD` | Maximum character length for upload description (default: 1024). |

## Error Responses

This endpoint takes no parameters and has no authentication requirements. Errors indicate server-side configuration issues:

| Status | Error Response Body | Description |
| :--- | :--- | :--- |
| `500 Internal Server Error` | `{"error": "Internal server error"}` | Unexpected server failure. |
