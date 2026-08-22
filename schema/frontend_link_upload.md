# Link Upload Protocol

Canonical protocol specification for creating URL redirect uploads.

## Endpoint

| Property | Specification |
| :--- | :--- |
| **Method** | `POST` |
| **Path** | `/api/v2/ulink` |
| **Authentication** | None |
| **Content-Type** | `application/json` |

## Request Body (`application/json`)

```json
{
  "type": "link",
  "link": "https://example.com/target-resource"
}
```

## Request Schema & Field Validation

| Field | Type | Required | Constraints / Validation |
| :--- | :--- | :---: | :--- |
| `type` | `"link"` | Yes | Must be literal string `"link"`. |
| `link` | `string` | Yes | Valid URI matching pattern `^(https?://\|www\.)`. Target resource must be reachable. |

## Server-Side Processing Pipeline

1. **Schema Validation**: Validates JSON body against Fastify request schema (`type === "link"`, URI format).
2. **Ping Verification**: Server issues an HTTP `HEAD` probe request to the provided link to verify destination reachability; rejects with `400` if ping fails.
3. **Identifier Generation**: Generates a collision-checked safe public ID (`genSafeID`: e.g. `123XABCD`).
4. **Database Storage**: Persists document to MongoDB collection with `type: "link"`, `link: { redir: link }`, `public: true`, `files: []`.
5. **Feed Sync**: Automatically registers in the in-memory public feed if marked public.

## Successful Response (`HTTP 200`)

```json
{
  "message": "Ulink successful",
  "id": "123XABCD"
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `message` | `string` | Success message (`"Ulink successful"`). |
| `id` | `string` | Generated public alphanumeric identifier. |

## Error Responses

| Status | Error Body | Cause |
| :--- | :--- | :--- |
| `400 Bad Request` | `{"error": "Bad request"}` | Invalid JSON schema, malformed URL, or target link failed server `HEAD` verification. |
| `500 Internal Server Error` | `{"error": "Internal server error"}` | Database insertion failure. |
