# AGENTS / CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other agents when working with code in this repository.

## Commands

```bash
npm run dev          # run with tsx, NODE_ENV=dev, LOGLEVEL=debug (no compile step)
npm run dev:watch    # same + file watching
npm run build        # tsc compile → dist/
npm start            # NODE_ENV=prod node dist/index.js
npm test             # vitest
```

Env loaded from `.env.${NODE_ENV}` via dotenv.

## Architecture

TypeScript Node.js server (v2) — rewrite of [femboyz-cloud-server](https://github.com/misikovich/femboyz-cloud-server).

- `src/` → source, `dist/` → compiled output
- Entry point: `src/index.ts` — init order: `runDB()` → `feed_init()` → `initStorage()` → `startServer()`

### Module map


| File              | Role                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `src/index.ts`    | Boot: DB → public feed → storage → HTTP server                                        |
| `src/api.ts`      | Fastify server, all route handlers                                                      |
| `src/admin.ts`    | Admin auth, query pipeline, blob cleanup, and storage mutation lock                     |
| `src/config.ts`   | Reads`.env.*`, exports `envs` object                                                    |
| `src/database.ts` | MongoDB connect/disconnect,`getDB()`                                                    |
| `src/storage.ts`  | Filesystem storage: write/read/delete files, usage tracking                             |
| `src/feed.ts`     | Newest-first in-memory public feed, range validation, startup load, add/delete/update sync |
| `src/authlimit.ts` | Per-IP failure counter + temporary block factory (admin login, upload tokens)  |
| `src/tokens.ts`   | Upload tokens: effective limits, atomic use reservation/release, usage audit log, admin CRUD |
| `src/uploads.ts`  | Business logic: receive file streams, receive links, ID generation, view/download counters, MIME classification |
| `src/schema.ts`   | Zod schemas:`XMetaFilesSchema`, `StorageDBUploadInstanceSchema`                         |
| `src/logger.ts`   | Pino logger,`scope(name)` factory, `errorFileLogger` → `./logs/errors.log`             |
| `src/utils.ts`    | `shutdownUnexpectedly()` (process.exit(1))                                              |

## API routes


| Method | Path               | Handler                       | Description                                                      |
| ------ | ------------------ | ----------------------------- | ---------------------------------------------------------------- |
| GET    | `/ping`            | `pongHandler`                 | Health check                                                     |
| GET    | `/`                | `rootHandler`                 | Root                                                             |
| GET    | `/api/v2/feed`     | `feed_handle`                  | Public uploads, newest-first, paginated with `s`/`e`              |
| GET    | `/api/v2/admin/uploads` | `adminUploadsHandler`     | Authorized paginated/searchable upload inventory                 |
| DELETE | `/api/v2/admin/uploads/:id` | `adminDeleteUploadHandler` | Authorized permanent upload deletion                          |
| GET    | `/api/v2/admin/logs` | `adminLogsHandler`    | Authorized error log viewer and filtering                       |
| GET/POST | `/api/v2/admin/tokens` | `admin_tokens_list_handle` / `admin_tokens_create_handle` | Authorized upload token list / create |
| PATCH/DELETE | `/api/v2/admin/tokens/:id` | `admin_tokens_update_handle` / `admin_tokens_delete_handle` | Authorized token edit/revoke / delete |
| GET    | `/api/v2/admin/tokens/:id/uses` | `admin_tokens_uses_handle` | Authorized token usage audit log                          |
| GET    | `/:id`             | `getUploadHandler`            | Fetch upload by ID — link→302, files→HTML/JSON/text by Accept |
| GET    | `/:id/:fid`        | `getUploadHandler`            | Serve raw file by index (Content-Type + Content-Disposition)     |
| GET    | `/api/v2/maxfsize` | `askMaxFileUploadSizeHandler` | Upload limits given current storage (or of the `X-Upload-Token`) |
| POST   | `/api/v2/ulink`    | `ulinkHandler`                | Receive link upload (JSON body)                                  |
| POST   | `/api/v2/udstream` | `udstreamHandler`             | Receive file stream upload                                       |
| POST   | `/api/v2/viewed/:id` | `viewedUploadHandler` | Record an interactive view and refresh the in-memory public feed |

## Frontend protocols

### Public feed — `GET /api/v2/feed`

No authentication or request body. The in-memory feed contains MongoDB uploads with `public: true`; it loads during startup and stays synchronized when uploads are created or deleted.

Ranges are start-inclusive and end-exclusive:

```http
GET /api/v2/feed             # defaults to s=0&e=20
GET /api/v2/feed?s=20        # e defaults to 40
GET /api/v2/feed?s=20&e=40   # returns items 20–39
```

`s` must be a non-negative integer, `e` must be greater than `s`, and the range may contain at most 100 items. Invalid ranges return 400. Responses contain `items`, `start`, `end`, `total`, and `has_more`; feed items omit issuer data and internal file hashes. Full protocol schema: `schema/frontend_feed.md`.

### File upload — `POST /api/v2/udstream`

```
Content-Type: application/octet-stream
Content-Length: <total bytes>
X-Meta: <base64(JSON.stringify(xmeta))>

Body: filebytes1 + filebytes2 + ... (concatenated, no separator)
```

X-Meta schema (before base64):

```json
{
  "type": "files",
  "is_public": false,
  "meta": { "title": "...", "desc": "..." },
  "files": [
    { "filename": "foo.zip", "sha256": "<64-char hex>", "bytes": 987654321 }
  ]
}
```

Server splits stream using `bytes` fields, verifies each chunk with SHA-256.

### Upload tokens — `X-Upload-Token`

Admin-issued tokens (created in `/admin` → Tokens) replace the default count/size limits for one upload. The user holds **Upload!** to open the token field. `GET /api/v2/maxfsize` with the header returns the token's limits, and `POST /api/v2/udstream` with it spends one use atomically (given back if the upload fails). Every use and rejection is logged to `token_uses`. Too many unknown tokens from one IP → `429` block. Full protocol: `schema/frontend_upload_token.md`.

### Link upload — `POST /api/v2/ulink`

```json
{ "type": "link", "link": "https://example.com" }
```

Server pings the URL (HEAD) before saving.

### View tracking — `POST /api/v2/viewed/:id`

No body required. The client triggers this request after an upload detail page has remained open for 2 seconds (cancelled if the user leaves earlier). Returns `204 No Content`, atomically increments MongoDB `stat.views`, and synchronizes the in-memory public feed. Full protocol schema: `schema/frontend_upload_viewed.md`.

## Storage

- Files stored flat in `STORAGE_DIR` (default `./storage`), named by SHA-256 hash
- Uploads stream to `STORAGE_DIR/.incoming/<uuid>.part` while hashing (only a 64 KiB head is kept in RAM for MIME detection), then `commitFile` renames them into place; `.incoming` is wiped on startup
- In-flight uploads reserve their `Content-Length` (`storage_reserve`/`storage_release`) so concurrent uploads can't overbook the limit
- Deduplication: skip write if file already exists
- In-memory usage counter (`storageUsage`) updated on write/delete, recalculated from disk on init
- Hard limit: `STORAGE_LIMIT_BYTES`; warning threshold: `STORAGE_USAGE_WARNING_PERCENTAGE`%
- Pre-check in `/api/v2/udstream` preHandler (507 if not enough space)

## MongoDB

- Collection: `MDB_COLLECTION_UPLOADS`
- Unique index on `id_pub`
- Document union type: `StorageDBUploadInstance` (files/album/playlist | link)

### ID format

`genSafeID()` → `idGen()`: 3 digits + 1 uppercase alphanumeric + 4 uppercase letters (e.g. `123XABCD`). Collision-checked against DB.

### Upload type classification (`typeClassify`)

All images or video → `"album"`, all audio → `"playlist"`, mixed or other → `"files"`

## Key env vars


| Var                                 | Purpose                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `MDB_URI` / `MDB_PORT` / `MDB_NAME` | MongoDB connection                                                             |
| `MDB_COLLECTION_UPLOADS`            | Collection name                                                                |
| `MDB_COLLECTION_TOKENS`             | Upload token collection (default `tokens`)                                     |
| `MDB_COLLECTION_TOKEN_USES`         | Token usage audit collection (default `token_uses`)                            |
| `WEBSRV_PORT`                       | HTTP port                                                                      |
| `MAX_FILE_SIZE`                     | Max bytes per single file                                                      |
| `MIN_FILE_SIZE`                     | Min bytes per file                                                             |
| `MAX_FILE_COUNT_PER_UPLOAD`         | Max files per upload (default 6)                                               |
| `MAX_TITLE_LENGTH_PER_UPLOAD`       | Max title chars (default 255)                                                  |
| `MAX_DESC_LENGTH_PER_UPLOAD`        | Max desc chars (default 1024)                                                  |
| `STORAGE_DIR`                       | Storage directory path                                                         |
| `STORAGE_LIMIT_BYTES`               | Hard storage cap                                                               |
| `STORAGE_USAGE_WARNING_PERCENTAGE`  | Warning threshold % (default 80)                                               |
| `LOGLEVEL`                          | Pino log level                                                                 |
| `BASE_URL`                          | Public base URL (e.g.`https://femboyz.cloud`) — used in OG tags and file URLs |
| `SITE_NAME`                         | Display name shown in plain-text previews                                      |
| `AUTH_ADMIN_KEY`                    | Bearer key required by `/api/v2/admin/*`                                        |
| `AUTH_ADMIN_MAX_FAILS`              | Failed admin auth attempts per IP before a block (default 5)                    |
| `AUTH_ADMIN_BLOCK_MINUTES`          | Block duration, also the failure-counter window (default 15)                    |
| `UPLOAD_TOKEN_MAX_FAILS`            | Unknown upload tokens per IP before a block (default 20)                        |
| `UPLOAD_TOKEN_BLOCK_MINUTES`        | Upload token block duration and failure window (default 15)                     |

## Dependencies


| Package                | Use                     |
| ---------------------- | ----------------------- |
| `fastify` v5           | HTTP server             |
| `mongodb` v7           | Database                |
| `zod` v4               | Schema validation       |
| `pino` + `pino-pretty` | Logging                 |
| `wasmagic`             | MIME detection via WASM |
| `filesize`             | Human-readable sizes    |
| `dotenv`               | Env loading             |
| `tsx`                  | Dev runner              |
| `vitest`               | Test runner             |

## TypeScript constraints

Config is strict. Key flags that affect code style:

- `module: nodenext` — relative imports **must** use `.js` extension (e.g. `import { foo } from './foo.js'`)
- `verbatimModuleSyntax: true` — type-only imports must use `import type`
- `noUncheckedIndexedAccess: true` — array/object index access returns `T | undefined`
- `exactOptionalPropertyTypes: true` — optional props can't be set to `undefined` explicitly
- `noUnusedLocals: true` — unused variables are compile errors
- `isolatedModules: true` — no const enums, every file must be a module
- Code style: no semicolons (`;`) — inserted automatically

## Frontend (`client/`)

SvelteKit 2 + Svelte 5 + TypeScript. Lives in `client/`, independent `package.json`.

### Commands (run from `client/`)

```bash
npm run dev          # Vite dev server
npm run build        # production build
npm run check        # svelte-check TS validation
npm test             # vitest (browser via Playwright)
```

### Structure


| Path                           | Role                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| `src/routes/+page.svelte`      | Home page (`/`) — upload UI                                           |
| `src/routes/admin/+page.svelte`| Private admin upload inventory (`/admin`), tabs: uploads / tokens / logs |
| `src/routes/+layout.svelte`    | Global layout: favicon, nav                                            |
| `src/routes/+layout.server.ts` | Server`load` — returns data available to all layouts/pages            |
| `src/hooks.ts`                 | Client hooks —`reroute` (URL rewriting before navigation)             |
| `src/hooks.server.ts`          | Server hooks —`handle` (request/response middleware)                  |
| `src/app.d.ts`                 | Global`App` namespace type declarations (`Locals`, `PageData`, etc.)   |
| `src/app.html`                 | HTML shell — SvelteKit injects`%sveltekit.head%` / `%sveltekit.body%` |
| `src/lib/`                     | Shared code, imported as`$lib/...`                                     |
| `src/lib/assets/`              | Static assets imported by components (e.g. favicon)                    |
| `static/`                      | Raw static files served as-is (not processed by Vite)                  |
| `svelte.config.js`             | SvelteKit config (adapter, aliases)                                    |
| `vite.config.ts`               | Vite + vitest config (plugins, test projects)                          |

### SvelteKit file conventions

- `+page.svelte` — page component
- `+page.ts` / `+page.server.ts` — `load` function for that page (`.server.ts` = server-only)
- `+layout.svelte` — wraps all child routes; receives `data` from `+layout.server.ts`
- `+layout.server.ts` — server `load` runs on every request; return value available as `data` prop in layout
- `hooks.server.ts` exports `handle` — intercepts every server request (auth, headers, etc.)
- `hooks.ts` exports `reroute` — client-side URL rewriting before SvelteKit routing

### Rules

- Always use `<script lang="ts">` — without it Svelte treats the block as plain JS
- Reactivity via Svelte 5 runes: `$state()`, `$derived()`, `$effect()`
- New page: create `src/routes/somepath/+page.svelte` → becomes `/somepath`
- `src/tsconfig.json` extends `.svelte-kit/tsconfig.json` (auto-generated, never edit)
- Assets imported in components go in `src/lib/assets/`; files in `static/` are served directly with no import needed
