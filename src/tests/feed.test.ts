import { beforeEach, expect, test, vi } from "vitest"
import type { FastifyReply, FastifyRequest } from "fastify"
import type { StorageDBUploadInstance } from "../schema.js"

const database = vi.hoisted(() => ({
    documents: [] as unknown[],
    filter: undefined as unknown,
    projection: undefined as unknown,
    sort: undefined as unknown
}))

vi.mock("../database.js", () => ({
    getDB: () => ({
        collection: () => ({
            find: (filter: unknown, projection: unknown) => {
                database.filter = filter
                database.projection = projection
                return {
                    sort: (sort: unknown) => {
                        database.sort = sort
                        return { toArray: async () => database.documents }
                    }
                }
            }
        })
    })
}))

import { feed_get_all_uploads, feed_init, feed_query_parse, feed_upload_add, feed_upload_remove } from "../feed.js"
import { feed_handle } from "../api.js"

function feed_upload_make(id: string, is_public: boolean, when: string): StorageDBUploadInstance {
    return {
        id_pub: id,
        public: is_public,
        status: "ready",
        meta: { title: id, desc: "" },
        stat: { views: 0, up: 0, down: 0 },
        issuer: { ip: "127.0.0.1", ua: "test", uuid: "test" },
        when,
        type: "files",
        files: [{
            filename: "test.txt",
            size: 4,
            mime: "text/plain",
            hashkey256: "a".repeat(64),
            stat_dl: 0
        }]
    }
}

beforeEach(async () => {
    database.documents = []
    await feed_init()
})

test("feed initializes from every public upload in newest-first order", async () => {
    const newer = feed_upload_make("123XABCD", true, "2026-08-22T12:00:00.000Z")
    const older = feed_upload_make("124XABCD", true, "2026-08-21T12:00:00.000Z")
    database.documents = [newer, older]

    await feed_init()

    expect(database.filter).toEqual({ public: true })
    expect(database.projection).toEqual({ projection: { _id: 0 } })
    expect(database.sort).toEqual({ when: -1, id_pub: 1 })
    expect(feed_get_all_uploads().map(upload => upload.id_pub)).toEqual([newer.id_pub, older.id_pub])
})

test("feed keeps new public uploads ordered newest first and removes them", () => {
    const newest = feed_upload_make("125XABCD", true, "2026-08-22T12:00:00.000Z")
    const middle = feed_upload_make("126XABCD", true, "2026-08-21T12:00:00.000Z")
    const oldest = feed_upload_make("127XABCD", true, "2026-08-20T12:00:00.000Z")
    const private_upload = feed_upload_make("128XABCD", false, "2026-08-23T12:00:00.000Z")

    feed_upload_add(newest)
    feed_upload_add(oldest)
    feed_upload_add(middle)
    feed_upload_add(private_upload)
    expect(feed_get_all_uploads()).toEqual([newest, middle, oldest])

    feed_upload_remove(middle.id_pub)
    expect(feed_get_all_uploads()).toEqual([newest, oldest])
})

test("feed query defaults to 20 items and rejects invalid ranges", () => {
    expect(feed_query_parse({})).toEqual({ start: 0, end: 20 })
    expect(feed_query_parse({ s: "20" })).toEqual({ start: 20, end: 40 })
    expect(() => feed_query_parse({ s: "20", e: "20" })).toThrow("Invalid feed query")
    expect(() => feed_query_parse({ s: "0", e: "101" })).toThrow("Invalid feed query")
})

test("feed endpoint returns safe paginated upload metadata", async () => {
    for (let index = 0; index < 25; index++) {
        const id = String(index).padStart(8, "0")
        const when = new Date(Date.UTC(2026, 0, 1, 0, 0, 25 - index)).toISOString()
        feed_upload_add(feed_upload_make(id, true, when))
    }

    let response: unknown
    const reply = {
        send(value: unknown) {
            response = value
            return this
        }
    } as unknown as FastifyReply
    const request = {
        query: {},
        protocol: "https",
        hostname: "example.com"
    } as FastifyRequest

    await feed_handle(request, reply)

    const first_page = response as {
        items: Array<{ id: string, files: Array<Record<string, unknown>> }>,
        start: number,
        end: number,
        total: number,
        has_more: boolean
    }
    expect(first_page).toMatchObject({ start: 0, end: 20, total: 25, has_more: true })
    expect(first_page.items).toHaveLength(20)
    expect(first_page.items[0]?.id).toBe("00000000")
    expect(first_page.items[0]).not.toHaveProperty("issuer")
    expect(first_page.items[0]?.files[0]).not.toHaveProperty("hashkey256")

    request.query = { s: "20", e: "40" }
    await feed_handle(request, reply)

    const second_page = response as typeof first_page
    expect(second_page).toMatchObject({ start: 20, end: 40, total: 25, has_more: false })
    expect(second_page.items).toHaveLength(5)
    expect(second_page.items[0]?.id).toBe("00000020")
})
