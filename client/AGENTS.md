# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server
npm run build        # production build
npm run check        # svelte-check TS validation
npm run check:watch  # TS validation in watch mode
```

No test runner is configured yet.

## Environment

Set `VITE_API_ENDPOINT` to point at the backend (e.g. `http://localhost:3000`). Without it, requests default to same-origin.

## Architecture

SvelteKit 2 + Svelte 5 (runes mode forced project-wide via `svelte.config.js` — `$state`, `$derived`, `$effect` everywhere, no legacy reactivity).

### Upload flow

`+page.ts` `load` → calls `fetchUploadLimits` (`GET /api/v2/maxfsize`) at page load time and passes limits down as `PageData`.

`+page.svelte` holds all upload state. On submit it calls `sendUpload` from `$lib/upload/uploader.ts`, which:
1. Hashes every file with `crypto.subtle` (SHA-256) before sending
2. Builds an `XMetaFiles` object, base64-encodes it into `X-Meta` header
3. Concatenates all `File` blobs into one `Blob` and POSTs via XHR (not `fetch`) so upload progress events work
4. Returns `UploadResult { id, type }` on success

Progress tracking is per-file, calculated by walking cumulative byte offsets across the concatenated blob.

### Receiving uploads

`$lib/upload/downloader.ts` defines the `UploadData` / `FileData` types matching `GET /:id` JSON response (`Accept: application/json`). Per-file content is fetched at `/:id/:index`. This module has no logic yet — types only.

`MiniUpload.svelte` is a placeholder component for the uploads grid (hardcoded IDs in `+page.svelte`); fetching and display not implemented.

### i18n

`$lib/lang.ts` — minimal custom i18n. `loadLang(lang)` lazy-imports JSON from `$lib/lang/`. `t(key)` returns translation or falls back to key. Languages: `en`, `ru`. Not yet wired into any UI.

### API contract

See `(repo root)/schema/*.info` files for the canonical server↔frontend protocol. `downloader.ts` mirrors `schema/frontend_upload_receiveByID.info`.
