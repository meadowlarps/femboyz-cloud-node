# Repository Guidelines

## Project Structure & Module Organization

This directory is the SvelteKit client for the larger `femboyz-cloud-node` repository. Treat it as a separate package with its own `package.json` and `package-lock.json`.

- `src/routes/` contains SvelteKit route components such as `+page.svelte` and `+layout.svelte`.
- `src/lib/` contains shared client code, including `lang.ts`, exported helpers in `index.ts`, and assets under `src/lib/assets/`.
- `src/lib/lang/` stores locale JSON files, currently `en.json` and `ru.json`.
- `static/` contains files served directly, such as `robots.txt`.
- Generated output lives in `.svelte-kit/` and `build/`; do not edit or commit it.

## Build, Test, and Development Commands

Run commands from `client/`.

- `npm run dev` starts the local Vite/SvelteKit development server.
- `npm run build` creates the production build with Vite.
- `npm run preview` serves the built app locally for inspection.
- `npm run check` runs `svelte-kit sync` and `svelte-check` using `tsconfig.json`.
- `npm run check:watch` runs the same checks continuously while editing.

## Coding Style & Naming Conventions

Use Svelte 5 with `<script lang="ts">` in components. Keep TypeScript strict and prefer typed helpers in `src/lib/` when logic is shared across routes. Follow the existing tab-indented JSON style in `package.json`; otherwise match the surrounding file. Use SvelteKit route naming conventions exactly (`+page.svelte`, `+layout.svelte`, `+server.ts` when needed). Keep locale keys stable across all files in `src/lib/lang/`.

## Testing Guidelines

No client test script is currently configured. For client changes, run `npm run check` before submitting. Run `npm run build` when touching routing, app shell behavior, SvelteKit config, dependency versions, or code that may affect production bundling. If tests are added later, place them near the relevant source or in a clear test directory and add an npm script.

## Commit & Pull Request Guidelines

The current Git history uses short, descriptive commit messages without a strict convention. Prefer concise imperative messages such as `fix upload page validation` or `add language selector`. Pull requests should include a brief summary, verification steps run, linked issues when applicable, and screenshots or screen recordings for visible UI changes.

## Security & Configuration Tips

Use `.env.example` as the documented template for local configuration. Do not commit secrets, generated build output, or local runtime files. Backend API behavior is defined outside this package, so coordinate protocol changes with the root server code and schema notes.
