import { NETWORK_ERROR, parseRetryAfter, statusText, waitText } from '$lib/apiError'

// Account pages talk to /oidc and /api on their own origin: nginx routes them to the API in
// production, the Vite proxy does in dev. The session cookie is HttpOnly and never seen here.

export class AccountApiError extends Error {
    constructor(
        public status: number,
        public code: string,
        public retryAfterS: number | null = null,
        /** The server's own readable sentence, sent alongside generic codes like `bad_request`. */
        public serverMessage: string | null = null
    ) {
        super(code)
    }
}

export async function accountFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(path, {
        method: init.method ?? 'GET',
        credentials: 'same-origin',
        headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    })
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string; retry_after_s?: number }
    if (!response.ok) {
        const retry = body.retry_after_s ?? parseRetryAfter(response.headers.get('Retry-After'))
        throw new AccountApiError(response.status, body.error ?? `http_${response.status}`, retry, body.message ?? null)
    }
    return body as T
}

/** Where to send someone without a site session; `back` is the path to return to. */
export function sessionStartUrl(back = '/account'): string {
    return `/api/v2/account/session/start?return=${encodeURIComponent(back)}`
}

const MESSAGES: Record<string, string> = {
    credentials_invalid: 'Wrong username or password.',
    interaction_expired: 'This sign-in took too long. Start again.',
    invalid_email: "That doesn't look like an email address.",
    own_domain: 'Use an address at another provider, not @femboyz.cloud.',
    email_taken: 'That address is already linked to another account.',
    email_unchanged: 'That is already your external email.',
    invite_invalid: 'This invite link is invalid, expired or already used.',
    invite_busy: 'This invite is being used right now. Try again in a minute.',
    username_invalid: 'Use 3–32 characters: a–z, 0–9, dot, dash or underscore, starting and ending with a letter or digit.',
    username_reserved: 'That username is reserved.',
    username_taken: 'That username is taken.',
    password_too_short: 'Use at least 12 characters.',
    password_too_long: 'That password is too long.',
    password_common: 'That password is too common. Pick something less guessable.',
    password_contains_username: "Don't put your username in your password.",
    password_wrong: 'Wrong password.',
    code_invalid: "That code isn't right.",
    code_expired: 'That code expired. Send a new one.',
    code_burned: 'Too many wrong tries. Send a new code.',
    no_external_email: 'Add and verify an external email first.',
    no_mailbox: 'This account has no mailbox.',
    mailbox_failed: "The mail server didn't respond. Try again in a moment.",
    requests_full: "We're not taking new requests right now. Try again later.",
    not_signed_in: 'Your session ended. Sign in again.',
    bad_origin: 'Request blocked. Reload the page and try again.',
    already_decided: 'Already decided.',
    not_found: "Not found. Reload the list.",
    empty_update: 'Nothing to save.',
    invalid_body: "Some fields are invalid.",
    invalid_query: 'Invalid filters.',
    access_denied: 'Sign-in cancelled.',
    unauthorized: 'Sign in required.',
    forbidden: "Not allowed."
}

/** Codes whose meaning is vague enough that the server's own sentence, when it sent one, says more. */
const GENERIC_CODES = new Set(['bad_request', 'server_error', 'unauthorized', 'forbidden', 'not_found'])

/** Readable text for an account API code, or null when the code isn't one we know. */
export function accountCodeText(code: string, retryAfterS: number | null = null): string | null {
    if (code === 'rate_limited' || code === 'code_limit') return `Too many attempts. ${waitText(retryAfterS)}`
    if (code === 'code_cooldown') return `Wait before asking for another code. ${waitText(retryAfterS)}`
    return MESSAGES[code] ?? null
}

export function accountErrorText(error: unknown): string {
    if (!(error instanceof AccountApiError)) return NETWORK_ERROR
    if (error.serverMessage && GENERIC_CODES.has(error.code)) return error.serverMessage
    if (error.code === 'server_error') return statusText(error.status)
    return accountCodeText(error.code, error.retryAfterS) ?? error.serverMessage ?? statusText(error.status)
}
