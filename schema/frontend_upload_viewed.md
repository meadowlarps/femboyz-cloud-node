# Upload View Protocol

Canonical protocol specification for recording an interactive upload view.

## Endpoint

| Property | Specification |
| :--- | :--- |
| **Method** | `POST` |
| **Path** | `/api/v2/viewed/:id` |
| **Authentication** | None |
| **Request Body** | None |
| **Successful Response** | `204 No Content` |

## Path Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `id` | `string` | Yes | Existing public upload identifier, such as `123XABCD`. |

## Server-Side Processing

1. Atomically increments the MongoDB upload field `stat.views` by one.
2. Reloads the upload from MongoDB into the in-memory public feed so feed responses expose the updated count.
3. Returns `204 No Content` after both operations succeed.

The endpoint counts each successful request. It does not identify users, deduplicate retries, or decide whether a request represents an interactive view; the caller is responsible for invoking it only after a real view.

## Client Invocation

The upload detail page starts a two-second timer after it renders in the browser. If the same upload is still open when the timer expires, the client sends this request and increments its displayed count after a successful response. Leaving the page or navigating to another upload before the timer expires cancels the request.

Background metadata fetches for main-page upload cards never invoke this endpoint. Link uploads redirect before the detail page renders and therefore do not reach the two-second threshold.

## Responses

| Status | Body | Cause |
| :--- | :--- | :--- |
| `204 No Content` | None | The view was counted and the feed was refreshed. |
| `404 Not Found` | `{"error":"Not found"}` | No upload exists with the supplied ID. |
| `500 Internal Server Error` | `{"error":"Internal server error"}` | MongoDB update or feed refresh failed. |
