// One place that turns failed API calls into sentences people can read. The API sends `{ error: "..." }`
// with a readable message; when it doesn't (proxy errors, HTML pages, empty bodies) the status decides.

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
        public retryAfterS: number | null = null
    ) {
        super(message)
        this.name = 'ApiError'
    }
}

export const NETWORK_ERROR = "Can't reach the server."
export const BAD_RESPONSE = 'Unexpected server response.'

const STATUS_TEXT: Record<number, string> = {
    400: 'Invalid request.',
    401: 'Sign in required.',
    403: "Not allowed.",
    404: "Not found.",
    408: 'Request timed out.',
    409: 'Conflict. Reload and retry.',
    413: 'Too large.',
    415: 'Unsupported content type.',
    422: "Couldn't process that.",
    429: 'Too many requests.',
    500: 'Server error.',
    502: "Server unavailable.",
    503: 'Service unavailable.',
    504: 'Server timed out.',
    507: 'Server storage is full.'
}

export function statusText(status: number): string {
    if (status === 0) return NETWORK_ERROR
    return STATUS_TEXT[status]
        ?? (status >= 500 ? STATUS_TEXT[500]! : `The request failed (HTTP ${status}).`)
}

export function waitText(seconds: number | null): string {
    if (!seconds) return 'Try again later.'
    if (seconds < 90) return `Try again in ${seconds}s.`
    return `Try again in ~${Math.ceil(seconds / 60)} min.`
}

export function parseRetryAfter(header: string | null): number | null {
    const seconds = Number(header)
    return header !== null && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null
}

/** The `error` string of a JSON body, if it is a sentence rather than a machine code like `not_found`. */
export function parseErrorBody(text: string): string | undefined {
    try {
        const body = JSON.parse(text) as { error?: unknown; message?: unknown }
        if (typeof body.message === 'string' && body.message) return body.message
        if (typeof body.error === 'string' && body.error && !/^[a-z0-9_]+$/.test(body.error)) return body.error
    } catch {
        // not JSON
    }
    return undefined
}

function build(status: number, text: string, retryHeader: string | null): ApiError {
    const retryAfterS = parseRetryAfter(retryHeader)
    let message = parseErrorBody(text) ?? statusText(status)
    // the server can't know how long the wait is when it writes the sentence; the header does
    if (status === 429) message = `${message.replace(/\s*Try again later\.?$/, '')} ${waitText(retryAfterS)}`
    return new ApiError(status, message, retryAfterS)
}

export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
    const text = await response.text().catch(() => '')
    return build(response.status, text, response.headers.get('Retry-After'))
}

export function apiErrorFromXhr(xhr: XMLHttpRequest): ApiError {
    return build(xhr.status, xhr.responseText, xhr.getResponseHeader('Retry-After'))
}

/** Throws a readable ApiError for a failed response; returns the response otherwise. */
export async function ensureOk(response: Response): Promise<Response> {
    if (!response.ok) throw await apiErrorFromResponse(response)
    return response
}

/** Readable text for anything a `catch` receives. */
export function errorText(error: unknown, fallback = 'Something went wrong.'): string {
    // fetch rejects with a TypeError ("Failed to fetch", "NetworkError when…", "Load failed") when offline
    if (error instanceof TypeError) return NETWORK_ERROR
    if (error instanceof Error && error.message) return error.message
    return fallback
}

/** fetch() that turns a network failure into NETWORK_ERROR instead of the browser's own wording. */
export async function apiFetch(fetcher: typeof fetch, input: string, init?: RequestInit): Promise<Response> {
    try {
        return await fetcher(input, init)
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw new ApiError(0, NETWORK_ERROR)
    }
}
