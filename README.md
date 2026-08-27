# femboyz.cloud

Self-hosted file hosting service - upload files or links, share them via short IDs, browse a public feed. TypeScript rewrite of [femboyz-cloud-server](https://github.com/misikovich/femboyz-cloud-server).

- **Uploads**: raw file streams (multi-file, SHA-256 verified) and links
- **Serving**: short IDs like `123XABCD` → link redirect or HTML/JSON/text preview, files by index
- **Feed**: public, newest-first, paginated
- **Storage**: flat filesystem named by content hash, deduplicated, usage-tracked with a hard size cap
- **Frontend**: SvelteKit 2 + Svelte 5 client in `client/`

## Stack

- Fastify v5
- MongoDB
- Zod
- Pino
- SvelteKit

## Running

```bash
npm run dev          # tsx, NODE_ENV=dev, debug logs
npm run build        # tsc → dist/
npm start            # NODE_ENV=prod node dist/index.js
npm test             # vitest
```

Env is read from `.env.${NODE_ENV}` (see `.env.*` for variables: MongoDB connection, ports, storage limits, `AUTH_ADMIN_KEY`, `BASE_URL`, etc.). Requires a running MongoDB instance.

## API


| Method | Path                        | Description                                               |
| ------ | --------------------------- | --------------------------------------------------------- |
| GET    | `/ping`                     | Health check                                              |
| GET    | `/api/v2/feed`              | Public uploads, newest-first, paginated (`s`, `e`)        |
| POST   | `/api/v2/viewed/:id`        | Record a view                                             |
| GET    | `/:id`                      | Fetch upload by ID (link→302, files→HTML/JSON/text)     |
| GET    | `/:id/:fid`                 | Serve raw file by index                                   |
| GET    | `/api/v2/maxfsize`          | Max accepted upload size right now                        |
| POST   | `/api/v2/udstream`          | File stream upload (`X-Meta` header + concatenated bytes) |
| POST   | `/api/v2/ulink`             | Link upload (JSON body)                                   |
| GET    | `/api/v2/admin/uploads`     | (auth) Paginated/searchable upload inventory              |
| DELETE | `/api/v2/admin/uploads/:id` | (auth) Permanent deletion                                 |
| GET    | `/api/v2/admin/logs`        | (auth) Error log viewer                                   |

Wire formats are documented in `AGENTS.md` and `schema/frontend_*.md`.
