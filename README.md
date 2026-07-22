Rewrite of femboyz.cloud in TypeScript.

## Admin

Set `AUTH_ADMIN_KEY` in `.env.${NODE_ENV}` and open `/admin`. Generate a strong
key with `openssl rand -hex 32`.

The admin page uses the protected `GET /api/v2/admin/uploads` and
`DELETE /api/v2/admin/uploads/:id` endpoints. The former public
`GET /api/v2/ids` endpoint has been removed; `GET /api/v2/feed` is reserved and
currently returns `501`.
