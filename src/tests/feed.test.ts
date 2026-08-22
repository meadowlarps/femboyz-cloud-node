import { beforeEach, expect, test, vi } from "vitest"
import type { FastifyReply, FastifyRequest } from "fastify"
import type { StorageDBUploadInstance } from "../schema.js"

const database = vi.hoisted(() => ({
    documents: [] as unknown[],
    document: null as unknown,
    filter: undefined as unknown,
    projection: undefined as unknown,
    sort: undefined as unknown,
    update: undefined as unknown
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
            },
            findOne: async (filter: unknown, projection: unknown) => {
                database.filter = filter
                database.projection = projection
                return database.document
            },
            updateOne: async (filter: unknown, update: unknown) => {
                database.filter = filter
                database.update = update
                const document = database.document as { stat: { views: number } } | null
                if (!document) return { matchedCount: 0 }
                document.stat.views++
                return { matchedCount: 1 }
            }
        })
    })
}))

import {
    feed_get_all_uploads,
    feed_init,
    feed_query_parse,
    feed_update_upload,
    feed_upload_add,
    feed_upload_remove
} from "../feed.js"
import { feed_handle, viewedUploadHandler } from "../api.js"

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
    database.document = null
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

test("feed refreshes an upload from MongoDB and removes it when it becomes private", async () => {
    const upload = feed_upload_make("129XABCD", true, "2026-08-22T12:00:00.000Z")
    feed_upload_add(upload)
    database.document = {
        ...upload,
        meta: { title: "Updated title", desc: "" },
        stat: { ...upload.stat, views: 4 }
    }

    await feed_update_upload(upload.id_pub)

    expect(database.filter).toEqual({ id_pub: upload.id_pub })
    expect(database.projection).toEqual({ projection: { _id: 0 } })
    expect(feed_get_all_uploads()[0]).toMatchObject({
        id_pub: upload.id_pub,
        meta: { title: "Updated title" },
        stat: { views: 4 }
    })

    database.document = { ...upload, public: false }
    await feed_update_upload(upload.id_pub)
    expect(feed_get_all_uploads()).toEqual([])
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

test("viewed endpoint increments the MongoDB counter and refreshes the feed", async () => {
    const upload = feed_upload_make("130XABCD", true, "2026-08-22T12:00:00.000Z")
    feed_upload_add(upload)
    database.document = feed_upload_make(upload.id_pub, true, upload.when)

    let status = 0
    const reply = {
        status(code: number) {
            status = code
            return this
        },
        send() {
            return this
        }
    } as unknown as FastifyReply
    const request = { params: { id: upload.id_pub } } as FastifyRequest

    await viewedUploadHandler(request, reply)

    expect(database.update).toEqual({ $inc: { "stat.views": 1 } })
    expect(status).toBe(204)
    expect(feed_get_all_uploads()[0]?.stat.views).toBe(1)
})

test("viewed endpoint rejects an unknown upload", async () => {
    const request = { params: { id: "999XABCD" } } as FastifyRequest
    const reply = {} as FastifyReply

    await expect(viewedUploadHandler(request, reply))
        .rejects.toMatchObject({ statusCode: 404, message: "Upload not found" })
})
