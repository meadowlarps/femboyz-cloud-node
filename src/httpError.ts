import type { FastifyError } from "fastify"

/** An error meant for the client: `publicMessage` is sent as `{ error }`, `message` (with any `detail`) only goes to the logs. */
export class HttpError extends Error {
    constructor(public statusCode: number, public publicMessage: string, detail?: string) {
        super(detail ? `${publicMessage}: ${detail}` : publicMessage)
    }
}

export function httpError(statusCode: number, publicMessage: string, detail?: string): HttpError {
    return new HttpError(statusCode, publicMessage, detail)
}

const STATUS_MESSAGES: Record<number, string> = {
    400: "Invalid request.",
    401: "Sign in required.",
    403: "Not allowed.",
    404: "Not found.",
    405: "Method not allowed.",
    408: "Request timed out.",
    409: "Conflict. Reload and retry.",
    413: "Request too large.",
    415: "Unsupported content type.",
    429: "Too many requests.",
    500: "Server error.",
    502: "Upstream service unavailable.",
    503: "Service unavailable.",
    507: "Server storage is full."
}

/** Status sent to the client: any 4xx as-is, 5xx narrowed to the ones that mean something to it. */
export function clientStatus(status: number): number {
    if (status >= 400 && status < 500) return status
    return status === 502 || status === 503 || status === 507 ? status : 500
}

export function statusMessage(status: number): string {
    return STATUS_MESSAGES[status] ?? (status >= 500 ? STATUS_MESSAGES[500]! : STATUS_MESSAGES[400]!)
}

type ValidationIssue = { instancePath?: string, keyword?: string, params?: Record<string, unknown> }

function validationMessage(err: FastifyError): string {
    const issue = (err.validation?.[0] ?? {}) as ValidationIssue
    const field = typeof issue.params?.missingProperty === "string"
        ? issue.params.missingProperty
        : (issue.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".")
    switch (err.validationContext) {
        case "headers":
            if (field === "x-meta") return "Missing X-Meta header."
            if (field === "content-length")
                return issue.keyword === "minimum" ? "Upload is below the minimum size." : "Missing Content-Length."
            if (field === "content-type") return "Content-Type must be application/octet-stream."
            return "Missing or invalid headers."
        case "body":
            if (field === "link") return "Invalid link. Use http://, https:// or www."
            if (field === "text") return "Note text is missing."
            return field ? `The "${field}" field is missing or invalid.` : "Invalid request body."
        case "querystring":
            return "Invalid query."
        case "params":
            return "Invalid URL."
        default:
            return STATUS_MESSAGES[400]!
    }
}

/** A readable message for errors Fastify itself raises (validation, body parsing, limits). */
function fastifyMessage(err: FastifyError): string | null {
    if (err.validation) return validationMessage(err)
    switch (err.code) {
        case "FST_ERR_CTP_BODY_TOO_LARGE": return "Request too large."
        case "FST_ERR_CTP_INVALID_MEDIA_TYPE": return "Unsupported content type."
        case "FST_ERR_CTP_EMPTY_JSON_BODY": return "Empty request body."
        case "FST_ERR_CTP_INVALID_JSON_BODY": return "Invalid JSON."
        case "FST_ERR_CTP_INVALID_CONTENT_LENGTH": return "Content-Length doesn't match the body."
        default: return null
    }
}

/** What the client is told about `err`: our own message when we threw it, never internals of a 5xx. */
export function publicErrorMessage(err: FastifyError | Error, status: number): string {
    if (err instanceof HttpError) return err.publicMessage
    if (status < 500) return fastifyMessage(err as FastifyError) ?? statusMessage(status)
    return statusMessage(status)
}

type IssueLike = { code: string, path: PropertyKey[], message: string, origin?: string, maximum?: unknown, minimum?: unknown }

/**
 * One readable sentence for the first zod issue. `labels` names fields by their dotted path ("meta.title": "The title");
 * a `*` segment matches any array index ("files.*.filename").
 */
export function issueMessage(issues: readonly IssueLike[], labels: Record<string, string>, fallback: string): string {
    const issue = issues[0]
    if (!issue) return fallback
    const path = issue.path.map(part => typeof part === "number" ? "*" : String(part)).join(".")
    const label = labels[path]
    if (issue.code === "custom") return issue.message.endsWith(".") ? issue.message : `${issue.message}.`
    if (!label) return fallback
    if (issue.code === "too_big") return `${label} too ${issue.origin === "number" ? "large" : "long"} (max ${issue.maximum}).`
    if (issue.code === "too_small" && issue.origin !== "number" && issue.minimum === 1) return `${label} is empty.`
    if (issue.code === "too_small") return `${label} too ${issue.origin === "number" ? "small" : "short"} (min ${issue.minimum}).`
    return `Invalid ${label.toLowerCase()}.`
}
