import { expect, test } from "vitest"
import type { FastifyReply, FastifyRequest } from "fastify"
import {
    adminAuthStatus,
    buildAdminPipeline,
    cleanupUnreferencedFiles,
    escapeRegExp,
    parseAdminQuery,
    withStorageMutationLock
} from "../admin.js"
import { feedHandler } from "../api.js"

test("admin authorization accepts only the exact configured bearer key", () => {
    expect(adminAuthStatus("Bearer correct-key", "correct-key")).toBe(200)
    expect(adminAuthStatus(undefined, "correct-key")).toBe(401)
    expect(adminAuthStatus("Basic correct-key", "correct-key")).toBe(401)
    expect(adminAuthStatus("Bearer correct-key-extra", "correct-key")).toBe(401)
    expect(adminAuthStatus("Bearer correct-key", undefined)).toBe(503)
})

test("admin query parsing applies bounds and defaults", () => {
    expect(parseAdminQuery({})).toEqual({ page: 1, limit: 20, search: "", type: "all", sort: "newest" })
    expect(parseAdminQuery({ page: "2", limit: "50", search: "  1.2.3.4  ", type: "album", sort: "largest" }))
        .toEqual({ page: 2, limit: 50, search: "1.2.3.4", type: "album", sort: "largest" })
    expect(() => parseAdminQuery({ page: 0 })).toThrow("Invalid admin query")
    expect(() => parseAdminQuery({ limit: 101 })).toThrow("Invalid admin query")
    expect(() => parseAdminQuery({ search: "x".repeat(201) })).toThrow("Invalid admin query")
})

test("admin pipeline escapes search and uses deterministic pagination sorts", () => {
    expect(escapeRegExp("a+b[0].*")).toBe("a\\+b\\[0\\]\\.\\*")

    const expectedSort = {
        newest: { when: -1, id_pub: 1 },
        oldest: { when: 1, id_pub: 1 },
        largest: { totalSize: -1, id_pub: 1 },
        smallest: { totalSize: 1, id_pub: 1 }
    }

    for (const sort of ["newest", "oldest", "largest", "smallest"] as const) {
        const pipeline = buildAdminPipeline(parseAdminQuery({
            page: "3",
            limit: "10",
            search: "a+b",
            type: "files",
            sort
        }))
        const items = pipeline[1]!.$facet.items
        expect(items[0].$match.type).toBe("files")
        expect(items[0].$match.$or).toHaveLength(5)
        expect(items[0].$match.$or[0]["issuer.ip"].$regex).toBe("a\\+b")
        expect(items[1].$sort).toEqual(expectedSort[sort])
        expect(items[2]).toEqual({ $skip: 20 })
        expect(items[3]).toEqual({ $limit: 10 })
    }
})

test("blob cleanup preserves shared files, deduplicates hashes, and reports failures", async () => {
    const deleted: string[] = []
    const result = await cleanupUnreferencedFiles(
        ["unused", "shared", "unused", "broken"],
        async hash => hash === "shared",
        async hash => {
            if (hash === "broken") throw new Error("disk failure")
            deleted.push(hash)
            return 12
        }
    )

    expect(deleted).toEqual(["unused"])
    expect(result.reclaimedBytes).toBe(12)
    expect(result.sharedFilesKept).toBe(1)
    expect(result.failures.map(failure => failure.hash)).toEqual(["broken"])
})

test("storage mutation lock serializes concurrent work", async () => {
    const events: string[] = []
    let releaseFirst = () => {}
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = withStorageMutationLock(async () => {
        events.push("first-start")
        await gate
        events.push("first-end")
    })
    const second = withStorageMutationLock(async () => { events.push("second") })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual(["first-start"])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(["first-start", "first-end", "second"])
})

test("feed endpoint is an explicit 501 placeholder", async () => {
    let status = 0
    let body: unknown
    const reply = {
        status(code: number) {
            status = code
            return this
        },
        send(value: unknown) {
            body = value
            return this
        }
    } as unknown as FastifyReply

    await feedHandler({} as FastifyRequest, reply)
    expect(status).toBe(501)
    expect(body).toEqual({ error: "Feed not implemented" })
})
