import type { ParamMatcher } from '@sveltejs/kit'

/**
 * Mirrors `idGen()` on the server (3 digits, 1 uppercase alphanumeric, 4 uppercase letters) and
 * the upload-ID regex in the nginx vhost.
 *
 * Without this, `[id]` matches any single path segment, so every scanner probe for `/.env` or
 * `/wp-load.php` became an SSR call to the API — one Mongo lookup and one stack trace in
 * errors.log per probe. Unmatched paths now 404 inside SvelteKit and never reach the API.
 */
export const match: ParamMatcher = param => /^[0-9]{3}[0-9A-Z][A-Z]{4}$/.test(param)
