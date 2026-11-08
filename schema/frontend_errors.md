# Error responses

Every non-2xx response from the upload/feed/comment/admin API is JSON:

```json
{ "error": "Token expired." }
```

- `error` is a **readable sentence** meant to be shown to people as-is. Don't match on it; use the status.
- The status code is kept: any 4xx is sent as raised (`400`, `401`, `403`, `404`, `409`, `413`, `415`, `422`, `429`, …); 5xx is narrowed to `500`, `502`, `503` or `507`.
- 5xx messages never carry internals (paths, hashes, DB errors); those stay in the server log and `/api/v2/admin/logs`.
- `429` responses send `Retry-After: <seconds>`; the client appends the wait to the sentence.

Server side, throw `httpError(status, publicMessage, detail?)` from `src/httpError.ts`. `publicMessage` goes to the client, `detail` only to the logs. Errors Fastify raises itself (schema validation, bad JSON, body too large, wrong content type) are translated in `publicErrorMessage`.

Client side, `client/src/lib/apiError.ts` turns a failed `Response`/XHR into an `ApiError` (`status`, readable `message`, `retryAfterS`). It falls back to a sentence for the status when the body has none (proxy errors, HTML), and turns network failures into `status: 0` with a "Couldn't reach the server" message.

Account routes (`/api/v2/account/*`, admin account routes) instead send a machine **code**: `{ "error": "username_taken" }`, see `frontend_account_*.md`. Generic codes (`bad_request`, `server_error`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`) come with a readable `message` too. `client/src/lib/account/api.ts` maps codes to text.
