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
- Entry point: `src/index.ts` — init order: `runDB()` → `initStorage()` → `startServer()`

### Module map


| File              | Role                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `src/index.ts`    | Boot: DB → storage → HTTP server                                                      |
| `src/api.ts`      | Fastify server, all route handlers                                                      |
| `src/admin.ts`    | Admin auth, query pipeline, blob cleanup, and storage mutation lock                     |
| `src/config.ts`   | Reads`.env.*`, exports `envs` object                                                    |
| `src/database.ts` | MongoDB connect/disconnect,`getDB()`                                                    |
| `src/storage.ts`  | Filesystem storage: write/read/delete files, usage tracking                             |
| `src/uploads.ts`  | Business logic: receive file streams, receive links, ID generation, MIME classification |
| `src/schema.ts`   | Zod schemas:`XMetaFilesSchema`, `StorageDBUploadInstanceSchema`                         |
| `src/logger.ts`   | Pino logger,`scope(name)` factory, `errorFileLogger` → `./logs/errors.log`             |
| `src/utils.ts`    | `shutdownUnexpectedly()` (process.exit(1))                                              |

## API routes


| Method | Path               | Handler                       | Description                                                      |
| ------ | ------------------ | ----------------------------- | ---------------------------------------------------------------- |
| GET    | `/ping`            | `pongHandler`                 | Health check                                                     |
| GET    | `/`                | `rootHandler`                 | Root                                                             |
| GET    | `/api/v2/feed`     | `feedHandler`                 | Reserved public feed placeholder (501)                           |
| GET    | `/api/v2/admin/uploads` | `adminUploadsHandler`     | Authorized paginated/searchable upload inventory                 |
| DELETE | `/api/v2/admin/uploads/:id` | `adminDeleteUploadHandler` | Authorized permanent upload deletion                          |
| GET    | `/:id`             | `getUploadHandler`            | Fetch upload by ID — link→302, files→HTML/JSON/text by Accept |
| GET    | `/:id/:fid`        | `getUploadHandler`            | Serve raw file by index (Content-Type + Content-Disposition)     |
| GET    | `/api/v2/maxfsize` | `askMaxFileUploadSizeHandler` | Max acceptable upload size given current storage                 |
| POST   | `/api/v2/ulink`    | `ulinkHandler`                | Receive link upload (JSON body)                                  |
| POST   | `/api/v2/udstream` | `udstreamHandler`             | Receive file stream upload                                       |

## Frontend protocols

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

### Link upload — `POST /api/v2/ulink`

```json
{ "type": "link", "link": "https://example.com" }
```

Server pings the URL (HEAD) before saving.

## Storage

- Files stored flat in `STORAGE_DIR` (default `./storage`), named by SHA-256 hash
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
| `src/routes/admin/+page.svelte`| Private admin upload inventory (`/admin`)                              |
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
