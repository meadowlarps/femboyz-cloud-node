# CLAUDE.md — client/

SvelteKit 2 + Svelte 5 + TypeScript frontend for femboyz-cloud-node. Run all commands from `client/`.

## Commands

```bash
npm run dev        # Vite dev server
npm run build      # production build
npm run preview    # preview production build
npm run check      # svelte-check TS validation
```

## Env

Copy `.env.example` → `.env.development` (or `.env.production`). Vite loads by mode.

| Var | Purpose |
|---|---|
| `VITE_API_ENDPOINT` | Backend base URL (e.g. `http://localhost:3000`) |

## Structure

```
src/
  routes/
    +layout.svelte       # global layout — favicon, lang init
    +page.svelte         # home page — upload UI
  lib/
    index.ts             # re-exports from $lib
    lang.ts              # i18n: loadLang / t / setLang / getLang
    lang/
      en.json            # English strings
      ru.json            # Russian strings
    assets/
      favicon.svg
  app.html               # HTML shell
  app.d.ts               # App namespace types (Locals, PageData, etc.)
```

## i18n

`lang.ts` — simple key→string lookup. No external library.

```ts
import { loadLang, t } from '$lib'

await loadLang('ru')   // loads src/lib/lang/ru.json
t('some_key')          // returns translated string or key if missing
```

- Available langs: `en`, `ru`
- Add new lang: create `src/lib/lang/<code>.json`, add code to `availableLangs` in `lang.ts`
- `loadLang` called in `+layout.svelte` — runs on every page

## Rules

- Always `<script lang="ts">` — plain JS otherwise
- Reactivity: Svelte 5 runes — `$state()`, `$derived()`, `$effect()`
- New page: `src/routes/<path>/+page.svelte` → becomes `/<path>`
- `src/tsconfig.json` extends `.svelte-kit/tsconfig.json` — never edit the generated one
- Assets imported by components go in `src/lib/assets/`; files in `static/` served directly

## API

Backend runs separately (see root `CLAUDE.md`). Client hits `VITE_API_ENDPOINT`.

Key endpoints used:

| Method | Path | Used for |
|---|---|---|
| GET | `/api/v2/ids` | list all upload IDs |
| GET | `/api/v2/maxfsize` | pre-check available storage |
| POST | `/api/v2/udstream` | file stream upload |
| POST | `/api/v2/ulink` | link upload |
| GET | `/:id` | view upload |
| GET | `/:id/:fid` | serve raw file |
