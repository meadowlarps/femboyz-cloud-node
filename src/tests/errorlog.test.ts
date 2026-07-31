import { expect, test } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    buildErrorLogPage,
    filterErrorLogEntries,
    parseErrorLogLine,
    parseErrorLogQuery,
    readErrorLogTail,
    type ErrorLogQuery,
    type ErrorLogTail
} from "../errorlog.js"

// Shapes taken from the real logs/errors.log: the api.ts error handler line, the bare {err} lines
// from uploads.ts, the string-only line from database.ts, and the one carrying a top-level hash.
const handlerLine = JSON.stringify({
    level: 50,
    time: 1785529032163,
    pid: 53894,
    hostname: "host.local",
    err: {
        type: "Error",
        message: "Upload not found",
        stack: "Error: Upload not found\n    at Object.getUploadHandler (/src/api.ts:122:38)",
        statusCode: 404
    },
    msg: "Upload not found - \"404\" on \"GET\" \"/favicon.ico\" from \"::1\""
})

const noMsgLine = JSON.stringify({
    level: 50,
    time: 1785529032200,
    pid: 1,
    hostname: "host.local",
    err: { type: "MongoServerError", message: "insert failed", stack: "MongoServerError: insert failed" }
})

const noErrLine = JSON.stringify({
    level: 50,
    time: 1785529032300,
    pid: 1,
    hostname: "host.local",
    msg: "Failed to connect to the database"
})

const hashLine = JSON.stringify({
    level: 50,
    time: 1785529032400,
    pid: 1,
    hostname: "host.local",
    err: { type: "Error", message: "ENOENT", stack: "Error: ENOENT", statusCode: 500 },
    hash: "abc123",
    msg: "Failed to clean up blob for deleted upload 123XABCD"
})

function query(overrides: Partial<ErrorLogQuery> = {}): ErrorLogQuery {
    return parseErrorLogQuery(overrides)
}

function tailOf(lines: string[]): ErrorLogTail {
    return {
        text: `${lines.join("\n")}\n`,
        sizeBytes: 1234,
        modifiedAt: "2026-07-31T00:00:00.000Z",
        truncated: false,
        windowBytes: 4096
    }
}

test("log query parsing applies bounds and defaults", () => {
    expect(parseErrorLogQuery({})).toEqual({ page: 1, limit: 20, search: "", status: "all", sort: "newest" })
    expect(parseErrorLogQuery({ page: "3", limit: "50", search: "  ECONNREFUSED  ", status: "5xx", sort: "oldest" }))
        .toEqual({ page: 3, limit: 50, search: "ECONNREFUSED", status: "5xx", sort: "oldest" })
    expect(() => parseErrorLogQuery({ page: 0 })).toThrow("Invalid log query")
    expect(() => parseErrorLogQuery({ limit: 101 })).toThrow("Invalid log query")
    expect(() => parseErrorLogQuery({ status: "2xx" })).toThrow("Invalid log query")
    expect(() => parseErrorLogQuery({ search: "x".repeat(201) })).toThrow("Invalid log query")
})

test("a full handler line lifts the structured error fields", () => {
    const entry = parseErrorLogLine(handlerLine, 0)
    expect(entry).toEqual({
        index: 0,
        time: "2026-07-31T20:17:12.163Z",
        level: 50,
        levelLabel: "error",
        msg: "Upload not found - \"404\" on \"GET\" \"/favicon.ico\" from \"::1\"",
        type: "Error",
        message: "Upload not found",
        stack: "Error: Upload not found\n    at Object.getUploadHandler (/src/api.ts:122:38)",
        statusCode: 404
    })
})

test("lines missing msg, err, or carrying extra keys all parse", () => {
    const noMsg = parseErrorLogLine(noMsgLine, 1)
    expect(noMsg.msg).toBe("")
    expect(noMsg.message).toBe("insert failed")
    expect(noMsg.statusCode).toBeUndefined()

    const noErr = parseErrorLogLine(noErrLine, 2)
    expect(noErr.msg).toBe("Failed to connect to the database")
    expect(noErr.type).toBeUndefined()
    expect(noErr.stack).toBeUndefined()
    expect(noErr.extra).toBeUndefined()

    const withHash = parseErrorLogLine(hashLine, 3)
    expect(withHash.extra).toBe(JSON.stringify({ hash: "abc123" }))
})

test("unlifted nested error fields are kept as capped extra json", () => {
    const entry = parseErrorLogLine(JSON.stringify({
        level: 50,
        time: 1785529032163,
        err: { type: "MongoServerSelectionError", message: "ECONNREFUSED", reason: { servers: { "127.0.0.1:43999": {} } } }
    }), 0)

    expect(entry.extra).toBe(JSON.stringify({ "err.reason": { servers: { "127.0.0.1:43999": {} } } }))
    expect(entry.stack).toBeUndefined()
})

test("oversized stacks are truncated rather than streamed whole", () => {
    const entry = parseErrorLogLine(JSON.stringify({
        level: 50,
        time: 1785529032163,
        err: { type: "Error", message: "boom", stack: "x".repeat(9000) }
    }), 0)

    expect(entry.stack).toHaveLength(8001)
    expect(entry.stack?.endsWith("…")).toBe(true)
})

test("malformed lines degrade to a raw passthrough", () => {
    expect(parseErrorLogLine("not json at all", 7)).toEqual({
        index: 7,
        time: "",
        level: 0,
        levelLabel: "unknown",
        msg: "",
        raw: "not json at all"
    })
    expect(parseErrorLogLine("[1,2,3]", 8).raw).toBe("[1,2,3]")
    expect(parseErrorLogLine(JSON.stringify({ level: 50, time: "nonsense" }), 9).time).toBe("")
})

test("status buckets separate client errors, server errors, and unstatused entries", () => {
    const entries = [handlerLine, noMsgLine, noErrLine, hashLine].map(parseErrorLogLine)

    expect(filterErrorLogEntries(entries, query({ status: "4xx" })).map(e => e.statusCode)).toEqual([404])
    expect(filterErrorLogEntries(entries, query({ status: "5xx" })).map(e => e.statusCode)).toEqual([500])
    expect(filterErrorLogEntries(entries, query({ status: "none" }))).toHaveLength(2)
    expect(filterErrorLogEntries(entries, query({ status: "all" }))).toHaveLength(4)
})

test("search matches across msg, error message, type, stack, and extra", () => {
    const entries = [handlerLine, noMsgLine, noErrLine, hashLine].map(parseErrorLogLine)

    expect(filterErrorLogEntries(entries, query({ search: "favicon" }))).toHaveLength(1)
    expect(filterErrorLogEntries(entries, query({ search: "mongoservererror" }))).toHaveLength(1)
    expect(filterErrorLogEntries(entries, query({ search: "getUploadHandler" }))).toHaveLength(1)
    expect(filterErrorLogEntries(entries, query({ search: "abc123" }))).toHaveLength(1)
    expect(filterErrorLogEntries(entries, query({ search: "undefined" }))).toHaveLength(0)
})

test("pages are newest-first by default and report matched versus total counts", () => {
    const tail = tailOf([handlerLine, noMsgLine, noErrLine, hashLine])

    const newest = buildErrorLogPage(query({ limit: 2 }), tail)
    expect(newest.items.map(e => e.time)).toEqual(["2026-07-31T20:17:12.400Z", "2026-07-31T20:17:12.300Z"])
    expect(newest.totalCount).toBe(4)
    expect(newest.matchedCount).toBe(4)
    expect(newest.totalPages).toBe(2)
    expect(newest.file).toEqual({
        sizeBytes: 1234,
        modifiedAt: "2026-07-31T00:00:00.000Z",
        truncated: false,
        windowBytes: 4096
    })

    const secondPage = buildErrorLogPage(query({ limit: 2, page: 2 }), tail)
    expect(secondPage.items.map(e => e.time)).toEqual(["2026-07-31T20:17:12.200Z", "2026-07-31T20:17:12.163Z"])

    const oldest = buildErrorLogPage(query({ limit: 1, sort: "oldest" }), tail)
    expect(oldest.items[0]?.time).toBe("2026-07-31T20:17:12.163Z")

    const filtered = buildErrorLogPage(query({ status: "4xx" }), tail)
    expect(filtered.matchedCount).toBe(1)
    expect(filtered.totalCount).toBe(4)
})

test("tail reading is bounded, drops the partial first line, and tolerates a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "errorlog-"))
    const path = join(dir, "errors.log")

    try {
        expect(await readErrorLogTail(join(dir, "missing.log"))).toEqual({
            text: "",
            sizeBytes: 0,
            modifiedAt: "",
            truncated: false,
            windowBytes: 5 * 1024 * 1024
        })

        const contents = `${[handlerLine, noMsgLine, noErrLine].join("\n")}\n`
        await writeFile(path, contents)

        const whole = await readErrorLogTail(path)
        expect(whole.truncated).toBe(false)
        expect(whole.text).toBe(contents)
        expect(whole.sizeBytes).toBe(Buffer.byteLength(contents))

        // A window that opens mid-line must discard the fragment instead of parsing it.
        const window = Buffer.byteLength(`${noMsgLine}\n${noErrLine}\n`) + 10
        const clipped = await readErrorLogTail(path, window)
        expect(clipped.truncated).toBe(true)
        expect(clipped.windowBytes).toBe(window)
        expect(clipped.text).toBe(`${noMsgLine}\n${noErrLine}\n`)

        const page = buildErrorLogPage(query({ sort: "oldest" }), clipped)
        expect(page.items.map(e => e.message)).toEqual(["insert failed", undefined])
        expect(page.items.every(e => e.raw === undefined)).toBe(true)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
