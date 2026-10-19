# AGENTS / CLAUDE.md

This file provides guidance to agents when working with code in this repository.

## Commands

```bash
npm run dev          # run with tsx, NODE_ENV=dev, LOGLEVEL=debug (no compile step)
npm run dev:watch    # same + file watching
npm run build        # tsc compile → dist/
npm start            # NODE_ENV=prod node dist/index.js
npm test             # vitest
```

## Architecture

TypeScript Node.js server.

- `src/` → source, `dist/` → compiled output
- `client` → SvelteKit client

### Module map

| File               | Role                                                          |
| ------------------ | ------------------------------------------------------------- |
| `src/index.ts`     | Boot: DB → public feed → storage → HTTP server             |
| `src/api.ts`       | Fastify server and route handlers                             |
| `src/admin.ts`     | Admin auth, upload inventory, deletion, storage mutation lock |
| `src/config.ts`    | Reads `.env.*`, exports `envs`                                |
| `src/database.ts`  | MongoDB connection, `getDB()`                                 |
| `src/storage.ts`   | Filesystem storage and usage tracking                         |
| `src/feed.ts`      | In-memory newest-first public feed                            |
| `src/authlimit.ts` | Per-IP failure counter and temporary blocks                   |
| `src/tokens.ts`    | Upload tokens: limits, use accounting, admin CRUD             |
| `src/uploads.ts`   | Upload handling, ID generation, counters, MIME classification |
| `src/schema.ts`    | Zod schemas                                                   |
| `src/logger.ts`    | Pino logger, `scope(name)` factory, error log file            |
| `src/accounts.ts`  | femboyz accounts: username/password rules, requests, invites, signup, external email, redirect, admin |
| `src/accountApi.ts` | Account routes, their rate limits, Origin check, Stalwart bounce webhook |
| `src/oidc.ts`      | OIDC provider (oidc-provider) at `/oidc`, Mongo adapter, femboyz.cloud site session |
| `src/emailcodes.ts` | 4-digit email codes: HMAC storage, attempts, send limits    |
| `src/stalwart.ts`  | Stalwart JMAP management client: mailboxes, quota, redirect Sieve |
| `src/mailer.ts`    | nodemailer to Stalwart as noreply@, mail templates            |
| `src/utils.ts`     | Shared helpers                                                |

## API routes

| Method       | Path                            | Description                                          |
| ------------ | ------------------------------- | ---------------------------------------------------- |
| GET          | `/ping`, `/`                    | Health check, root                                   |
| GET          | `/api/v2/feed`                  | Public feed, paginated with `s`/`e`                  |
| GET          | `/api/v2/uploads?ids=A,B`       | Batch upload lookup (up to 100)                      |
| GET          | `/api/v2/maxfsize`              | Upload limits (or those of `X-Upload-Token`)         |
| POST         | `/api/v2/udstream`              | File stream upload                                   |
| POST         | `/api/v2/ulink`                 | Link upload                                          |
| POST         | `/api/v2/unote`                 | Text note upload                                     |
| POST         | `/api/v2/viewed/:id`            | Record a view                                        |
| GET          | `/:id`, `/:id/:fid`             | Upload page/JSON, raw file by index                  |
| GET/DELETE   | `/api/v2/admin/uploads[/:id]`   | Admin upload inventory / deletion                    |
| GET          | `/api/v2/admin/logs`            | Admin error log viewer                               |
| GET/POST/PATCH/DELETE | `/api/v2/admin/tokens[/:id]`, `/:id/uses` | Admin upload tokens and usage log |

Accounts (off unless `OIDC_ISSUER` is set; MAIL_PLAN.md, DEPLOYMENT.md section 14):

| Method       | Path                            | Description                                          |
| ------------ | ------------------------------- | ---------------------------------------------------- |
| ALL          | `/oidc/*`                       | OIDC provider; `/oidc/interaction/:uid[/login\|/abort]` are ours |
| GET/POST     | `/api/v2/account/session/*`     | Site session: `start`, `callback`, `logout`          |
| POST/GET     | `/api/v2/account/request`, `/invite/:code`, `/available`, `/signup[/email-code]` | Request access, invites, signup |
| GET/POST/DELETE/PATCH | `/api/v2/account/me[/email[/verify]\|/redirect]` | `/account` settings (session cookie) |
| GET/POST/PATCH/DELETE | `/api/v2/admin/account/{requests,invites,users}[/:id[/approve\|/reject]]` | Admin |
| POST         | `/api/v2/account/stalwart/webhook` | Stalwart bounce events (HMAC-signed)              |

Admin routes require `AUTH_ADMIN_KEY` as a bearer key. Non-GET account routes require a same-site `Origin`.

## Frontend protocols

Full specs live in `schema/`. Don't duplicate them here.

- Public feed (`GET /api/v2/feed`): `schema/frontend_feed.md`. Ranges are start-inclusive, end-exclusive; defaults `s=0&e=20`.
- File upload (`POST /api/v2/udstream`): raw concatenated file bytes, with a base64 JSON `X-Meta` header listing each file's `filename`, `sha256` and `bytes`. The server splits the stream by `bytes` and verifies each hash.
- Upload tokens (`X-Upload-Token`): `schema/frontend_upload_token.md`.
- Link upload (`POST /api/v2/ulink`): JSON `{ "type": "link", "link": "..." }`; the server HEAD-pings the URL first.
- Note upload (`POST /api/v2/unote`): `schema/frontend_note_upload.md`. Text lives in MongoDB.
- View tracking (`POST /api/v2/viewed/:id`): `schema/frontend_upload_viewed.md`.
- Accounts: `schema/frontend_account_{login,signup,settings,admin}.md`, `schema/mongo_{user,account_request,invite}.md`.

## Storage

- Files are stored flat in `STORAGE_DIR`, named by SHA-256 (deduplicated)
- Uploads stream to `STORAGE_DIR/.incoming/` while hashing, then are renamed into place
- In-flight uploads reserve their `Content-Length` against `STORAGE_LIMIT_BYTES`

## MongoDB

- Collections: uploads, tokens, token uses (names via `MDB_COLLECTION_*`)
- Upload documents are a union of files/album/playlist, link and note types (`StorageDBUploadInstance`)
- IDs look like `123XABCD`
- Upload type: all images/video → `album`, all audio → `playlist`, otherwise `files`

## Key env vars

See `src/config.ts` for the full list and defaults.

| Var                                 | Purpose                                            |
| ----------------------------------- | -------------------------------------------------- |
| `MDB_URI` / `MDB_PORT` / `MDB_NAME` | MongoDB connection                                 |
| `WEBSRV_PORT`                       | HTTP port                                          |
| `STORAGE_DIR` / `STORAGE_LIMIT_BYTES` | Storage location and hard cap                    |
| `MAX_FILE_SIZE` / `MIN_FILE_SIZE` / `MAX_FILE_COUNT_PER_UPLOAD` | Default upload limits |
| `BASE_URL`                          | Public base URL, used in OG tags and file URLs     |
| `AUTH_ADMIN_KEY`                    | Bearer key for `/api/v2/admin/*`                   |
| `LOGLEVEL`                          | Pino log level                                     |

## TypeScript constraints

Config is strict. Key flags that affect code style:

- `module: nodenext` — relative imports **must** use `.js` extension (e.g. `import { foo } from './foo.js'`)
- `verbatimModuleSyntax: true` — type-only imports must use `import type`
- `exactOptionalPropertyTypes: true` — optional props can't be set to `undefined` explicitly
- `isolatedModules: true` — no const enums, every file must be a module
- Code style: no semicolons (`;`) — inserted automatically

## Frontend (`client/`)

SvelteKit 2 + Svelte 5 + TypeScript. Lives in `client/`.

### Commands (run from `client/`)

```bash
npm run dev          # Vite dev server
npm run build        # production build
npm run check        # svelte-check TS validation
npm test             # vitest (browser via Playwright)
```

### Structure

| Path                            | Role                                        |
| ------------------------------- | ------------------------------------------- |
| `src/routes/+page.svelte`       | Home page (`/`), upload UI                  |
| `src/routes/admin/+page.svelte` | Admin page (`/admin`): uploads / tokens / requests / invites / users / logs |
| `src/routes/login/`, `signup/`, `account/` | femboyz accounts; `src/lib/account/` holds the API helper and the code input |
| `src/routes/+layout.svelte`     | Global layout                               |
| `src/hooks.server.ts`           | Server `handle`: `frame-ancestors` for the account pages |
| `src/lib/`                      | Shared code (`$lib/...`)                    |
| `static/`                       | Files served as-is                          |

### Rules

- Always use `<script lang="ts">`
- Reactivity via Svelte 5 runes: `$state()`, `$derived()`, `$effect()`
