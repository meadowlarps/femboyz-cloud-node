import { open } from "node:fs/promises"
import * as z from "zod"

const ErrorLogQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(200).default(""),
    status: z.enum(["all", "4xx", "5xx", "none"]).default("all"),
    sort: z.enum(["newest", "oldest"]).default("newest")
})

export type ErrorLogQuery = z.infer<typeof ErrorLogQuerySchema>

export type ErrorLogEntry = {
    index: number
    time: string
    level: number
    levelLabel: string
    msg: string
    type?: string
    message?: string
    statusCode?: number
    stack?: string
    extra?: string
    raw?: string
}

export type ErrorLogTail = {
    text: string
    sizeBytes: number
    modifiedAt: string
    truncated: boolean
    windowBytes: number
}

export const DEFAULT_TAIL_WINDOW_BYTES = 5 * 1024 * 1024

const MAX_MSG_LENGTH = 2000
const MAX_STACK_LENGTH = 8000
const MAX_EXTRA_LENGTH = 2000
const MAX_RAW_LENGTH = 2000

// pino writes numeric levels; errorFileLogger is pinned to "error" so only 50/60 occur in practice.
const LEVEL_LABELS: Record<number, string> = {
    10: "trace",
    20: "debug",
    30: "info",
    40: "warn",
    50: "error",
    60: "fatal"
}

const IGNORED_TOP_KEYS = new Set(["level", "time", "pid", "hostname", "err", "msg"])
const IGNORED_ERR_KEYS = new Set(["type", "message", "stack", "statusCode"])

export function parseErrorLogQuery(value: unknown): ErrorLogQuery {
    const result = ErrorLogQuerySchema.safeParse(value)
    if (!result.success)
        throw Object.assign(new Error("Invalid log query"), { statusCode: 400 })
    return result.data
}

function capText(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value
}

function toISOTime(value: unknown): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return ""
    const date = new Date(value)
    return isNaN(date.getTime()) ? "" : date.toISOString()
}

function unparseable(line: string, index: number): ErrorLogEntry {
    return { index, time: "", level: 0, levelLabel: "unknown", msg: "", raw: capText(line, MAX_RAW_LENGTH) }
}

// Log lines are not uniform: some carry no msg, some no err, some extra top-level keys.
// Everything but level/time is optional, and a malformed line degrades to a raw passthrough.
export function parseErrorLogLine(line: string, index: number): ErrorLogEntry {
    let parsed: unknown
    try {
        parsed = JSON.parse(line)
    } catch {
        return unparseable(line, index)
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return unparseable(line, index)

    const record = parsed as Record<string, unknown>
    const err = typeof record.err === "object" && record.err !== null && !Array.isArray(record.err)
        ? record.err as Record<string, unknown>
        : null

    const level = typeof record.level === "number" ? record.level : 0
    const type = err && typeof err.type === "string" ? err.type : undefined
    const message = err && typeof err.message === "string" ? capText(err.message, MAX_MSG_LENGTH) : undefined
    const statusCode = err && typeof err.statusCode === "number" ? err.statusCode : undefined
    const stack = err && typeof err.stack === "string" ? capText(err.stack, MAX_STACK_LENGTH) : undefined

    // Anything we did not lift out (a top-level `hash`, MongoDB's nested `reason`) is kept as capped JSON
    // so the entry stays debuggable without letting a 2.5 KB topology dump into every response.
    const leftovers: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record))
        if (!IGNORED_TOP_KEYS.has(key)) leftovers[key] = value
    if (err)
        for (const [key, value] of Object.entries(err))
            if (!IGNORED_ERR_KEYS.has(key)) leftovers[`err.${key}`] = value
    const extra = Object.keys(leftovers).length > 0
        ? capText(JSON.stringify(leftovers), MAX_EXTRA_LENGTH)
        : undefined

    return {
        index,
        time: toISOTime(record.time),
        level,
        levelLabel: LEVEL_LABELS[level] ?? "unknown",
        msg: typeof record.msg === "string" ? capText(record.msg, MAX_MSG_LENGTH) : "",
        ...(type !== undefined && { type }),
        ...(message !== undefined && { message }),
        ...(statusCode !== undefined && { statusCode }),
        ...(stack !== undefined && { stack }),
        ...(extra !== undefined && { extra })
    }
}

function statusBucket(statusCode: number | undefined): string {
    if (statusCode === undefined) return "none"
    if (statusCode >= 500) return "5xx"
    if (statusCode >= 400) return "4xx"
    return "other"
}

// Plain case-insensitive substring, not regex: no user-supplied pattern reaches a matcher, so
// there is no ReDoS surface to escape around (unlike the Mongo search in admin.ts).
export function filterErrorLogEntries(entries: ErrorLogEntry[], query: ErrorLogQuery): ErrorLogEntry[] {
    const needle = query.search.toLowerCase()
    return entries.filter(entry => {
        if (query.status !== "all" && statusBucket(entry.statusCode) !== query.status) return false
        if (!needle) return true
        const haystack = [entry.msg, entry.message, entry.type, entry.stack, entry.extra, entry.raw]
            .filter((value): value is string => typeof value === "string")
            .join(" ")
            .toLowerCase()
        return haystack.includes(needle)
    })
}

// The log file has no rotation and grows without bound, so only a bounded tail window is ever read.
export async function readErrorLogTail(path: string, windowBytes = DEFAULT_TAIL_WINDOW_BYTES): Promise<ErrorLogTail> {
    let handle
    try {
        handle = await open(path, "r")
    } catch (err) {
        // logger.ts creates ./logs at import but the file itself only appears on the first error write.
        if ((err as NodeJS.ErrnoException).code === "ENOENT")
            return { text: "", sizeBytes: 0, modifiedAt: "", truncated: false, windowBytes }
        throw err
    }

    try {
        const stats = await handle.stat()
        const start = Math.max(0, stats.size - windowBytes)
        const length = stats.size - start
        const buffer = Buffer.alloc(length)
        if (length > 0) await handle.read(buffer, 0, length, start)

        const raw = buffer.toString("utf8")
        const truncated = start > 0
        const newline = raw.indexOf("\n")
        // A window starting mid-file opens on a partial line — drop it rather than parse a fragment.
        const text = truncated ? (newline === -1 ? "" : raw.slice(newline + 1)) : raw

        return { text, sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString(), truncated, windowBytes }
    } finally {
        await handle.close()
    }
}

export function buildErrorLogPage(query: ErrorLogQuery, tail: ErrorLogTail) {
    const entries = tail.text
        .split("\n")
        .filter(line => line.trim() !== "")
        .map(parseErrorLogLine)
    if (query.sort === "newest") entries.reverse()

    const matched = filterErrorLogEntries(entries, query)
    const start = (query.page - 1) * query.limit

    return {
        items: matched.slice(start, start + query.limit),
        page: query.page,
        pageSize: query.limit,
        matchedCount: matched.length,
        totalCount: entries.length,
        totalPages: Math.ceil(matched.length / query.limit),
        file: {
            sizeBytes: tail.sizeBytes,
            modifiedAt: tail.modifiedAt,
            truncated: tail.truncated,
            windowBytes: tail.windowBytes
        }
    }
}
