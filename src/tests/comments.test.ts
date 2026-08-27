import { beforeEach, expect, test, vi } from "vitest"
import type { FastifyReply, FastifyRequest } from "fastify"
import type { CommentInstanceDB, CommentReactionState } from "../schema.js"

type Document = Record<string, unknown>

const CLIENT_UUID = "550e8400-e29b-41d4-a716-446655440000"
const CLIENT_UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
const UPLOAD_ID = "123XABCD"
const COMMENT_ID = "12345678"
const PARENT_ID = "87654321"
const OTHER_UPLOAD = "999XABCD"

const database = vi.hoisted(() => ({
    uploads: [] as Document[],
    comments: [] as Document[],
    inserted: null as Document | null,
    updated: null as Document | null,
    sort: null as Document | null,
    fail: false,
    duplicateInsertCount: 0,
    insertAttempts: 0
}))

function applyReactionPipeline(document: Document, update: Document[]) {
    const setReactionStage = update.find(stage => {
        const set = stage.$set as {
            reactions?: { $setField?: { field?: string, value?: CommentReactionState } }
        } | undefined
        return set?.reactions?.$setField?.field !== undefined
    })
    const setField = (setReactionStage?.$set as { reactions?: { $setField?: { field?: string, value?: CommentReactionState } } })
        ?.reactions?.$setField
    if (!setField?.field || !setField.value)
        throw new Error("unexpected reaction pipeline")

    const reactions = (document.reactions ?? {}) as Record<string, CommentReactionState>
    const prior = reactions[setField.field] ?? { rating: null, eyes: false }
    const desired = setField.value
    const stat = document.stat as { up: number, down: number, eyes: number }

    if (prior.rating === "up") stat.up = Math.max(0, stat.up - 1)
    if (prior.rating === "down") stat.down = Math.max(0, stat.down - 1)
    if (prior.eyes) stat.eyes = Math.max(0, stat.eyes - 1)

    if (desired.rating === "up") stat.up += 1
    if (desired.rating === "down") stat.down += 1
    if (desired.eyes) stat.eyes += 1

    reactions[setField.field] = structuredClone(desired)
    document.reactions = reactions
    document.stat = stat
}

vi.mock("../config.js", () => ({
    envs: {
        CURR_ENV: "TEST",
        MDB_COLLECTION_UPLOADS: "uploads",
        MDB_COLLECTION_COMMENTS: "comments",
        PORT: 0,
        MAX_FILE_SIZE: 1024,
        MIN_FILE_SIZE: 1,
        MAX_FILE_COUNT_PER_UPLOAD: 6,
        MAX_TITLE_LENGTH_PER_UPLOAD: 255,
        MAX_DESC_LENGTH_PER_UPLOAD: 1024,
        MAX_COMMENT_LENGTH: 500,
        STORAGE_DIR: "./storage",
        STORAGE_LIMIT_BYTES: 1024,
        STORAGE_USAGE_WARNING_PERCENTAGE: 80,
        EMPTY_STORAGE_DIR_ON_STARTUP: false,
        SITE_NAME: "test",
        AUTH_ADMIN_MAX_FAILS: 5,
        AUTH_ADMIN_BLOCK_MINUTES: 15
    }
}))

vi.mock("../database.js", () => ({
    getDB: () => ({
        collection: (name: string) => {
            const documents = name === "uploads" ? database.uploads : database.comments
            const matches = (document: Document, filter: Document) =>
                Object.entries(filter).every(([key, value]) => document[key] === value)

            return {
                findOne: async (filter: Document) => {
                    if (database.fail) throw new Error("database unavailable")
                    return documents.find(document => matches(document, filter)) ?? null
                },
                find: (filter: Document) => ({
                    sort: (sort: Document) => {
                        database.sort = sort
                        return {
                            toArray: async () => {
                                if (database.fail) throw new Error("database unavailable")
                                return documents
                                    .filter(document => matches(document, filter))
                                    .toSorted((left, right) =>
                                        String(left.when).localeCompare(String(right.when))
                                        || String(left.id_comment_pub).localeCompare(String(right.id_comment_pub)))
                            }
                        }
                    }
                }),
                insertOne: async (document: Document) => {
                    if (database.fail) throw new Error("database unavailable")
                    database.insertAttempts += 1

                    if (database.duplicateInsertCount > 0) {
                        database.duplicateInsertCount -= 1
                        const err = new Error("duplicate key") as Error & { code: number }
                        err.code = 11000
                        throw err
                    }

                    const duplicate = documents.some(item => item.id_comment_pub === document.id_comment_pub)
                    if (duplicate) {
                        const err = new Error("duplicate key") as Error & { code: number }
                        err.code = 11000
                        throw err
                    }

                    database.inserted = structuredClone(document)
                    database.comments.push(document)
                    return { acknowledged: true }
                },
                findOneAndUpdate: async (filter: Document, update: Document | Document[]) => {
                    if (database.fail) throw new Error("database unavailable")

                    const index = documents.findIndex(document => matches(document, filter))
                    if (index === -1) return null

                    const document = documents[index]!
                    if (Array.isArray(update))
                        applyReactionPipeline(document, update)

                    database.updated = structuredClone(document)
                    return structuredClone(document)
                }
            }
        }
    })
}))

import { comment_id_gen, createComment, getCommentByID, getCommentsByUploadID, updateCommentReaction } from "../comments.js"
import {
    createCommentHandler,
    getCommentHandler,
    getUploadCommentsHandler,
    updateCommentReactionHandler
} from "../api.js"

function makeComment(
    id: string,
    uploadId: string,
    when = "2026-08-25T10:00:00.000Z",
    reactions?: Record<string, CommentReactionState>
): CommentInstanceDB {
    return {
        id_upload_pub: uploadId,
        id_comment_pub: id,
        content: `comment ${id}`,
        when,
        stat: { up: 0, down: 0, eyes: 0 },
        ...(reactions === undefined ? {} : { reactions }),
        issuer: { ip: "127.0.0.1", ua: "test", uuid: CLIENT_UUID }
    }
}

function makeRequest(
    body: unknown,
    params: Document = {},
    headers: Document = { "user-agent": "vitest", "x-client-uuid": CLIENT_UUID }
): FastifyRequest {
    return {
        body,
        params,
        ip: "1.2.3.4",
        headers
    } as unknown as FastifyRequest
}

function captureReply() {
    const result = { status: 200, body: undefined as unknown }
    const reply = {
        status(status: number) {
            result.status = status
            return this
        },
        send(body: unknown) {
            result.body = body
            return this
        }
    } as unknown as FastifyReply
    return { reply, result }
}

function storedComment(id = COMMENT_ID) {
    return database.comments.find(document => document.id_comment_pub === id) as Document
}

beforeEach(() => {
    database.uploads = []
    database.comments = []
    database.inserted = null
    database.updated = null
    database.sort = null
    database.fail = false
    database.duplicateInsertCount = 0
    database.insertAttempts = 0
})

test("creates a trimmed public comment with private issuer metadata", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })
    database.comments.push(makeComment(PARENT_ID, UPLOAD_ID) as unknown as Document)

    const created = await createComment(makeRequest({
        content: "  hello  ",
        id_reply_to: PARENT_ID
    }), UPLOAD_ID)

    expect(created.id).toMatch(/^\d{8}$/)
    expect(created).toMatchObject({
        id_reply_to: PARENT_ID,
        content: "hello",
        stat: { up: 0, down: 0, eyes: 0 }
    })
    expect(created).not.toHaveProperty("issuer")
    expect(created).not.toHaveProperty("reactions")
    expect(database.inserted).toMatchObject({
        id_upload_pub: UPLOAD_ID,
        issuer: { ip: "1.2.3.4", ua: "vitest", uuid: CLIENT_UUID }
    })
})

test("rejects invalid content and missing or private uploads", async () => {
    await expect(createComment(makeRequest({ content: "   " }), UPLOAD_ID))
        .rejects.toMatchObject({ statusCode: 400 })

    for (const uploads of [[], [{ id_pub: UPLOAD_ID, public: false }]]) {
        database.uploads = uploads
        await expect(createComment(makeRequest({ content: "hello" }), UPLOAD_ID))
            .rejects.toMatchObject({ statusCode: 404 })
    }
})

test("rejects missing or invalid client UUID on create", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })

    await expect(createComment(makeRequest({ content: "hello" }, {}, {}), UPLOAD_ID))
        .rejects.toMatchObject({ statusCode: 400 })
    await expect(createComment(makeRequest({ content: "hello" }, {}, { "x-client-uuid": "not-a-uuid" }), UPLOAD_ID))
        .rejects.toMatchObject({ statusCode: 400 })
})

test("retries comment creation after duplicate key errors", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })
    database.duplicateInsertCount = 2

    const created = await createComment(makeRequest({ content: "hello" }), UPLOAD_ID)

    expect(database.insertAttempts).toBe(3)
    expect(created.id).toMatch(/^\d{8}$/)
    expect(database.inserted).toMatchObject({ id_comment_pub: created.id })
})

test("rejects a missing parent or a parent from another upload", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })

    await expect(createComment(makeRequest({ content: "hello", id_reply_to: "" }), UPLOAD_ID))
        .rejects.toMatchObject({ statusCode: 400 })
    await expect(createComment(makeRequest({ content: "hello", id_reply_to: "00000000" }), UPLOAD_ID))
        .rejects.toMatchObject({ statusCode: 400 })

    database.comments.push(makeComment(PARENT_ID, OTHER_UPLOAD) as unknown as Document)
    await expect(createComment(makeRequest({ content: "hello", id_reply_to: PARENT_ID }), UPLOAD_ID))
        .rejects.toMatchObject({ statusCode: 400 })
})

test("retrieves one comment only while its upload is public", async () => {
    const stored = makeComment(COMMENT_ID, UPLOAD_ID)
    database.comments.push(stored as unknown as Document)
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })

    await expect(getCommentByID(COMMENT_ID)).resolves.toEqual({
        id: COMMENT_ID,
        content: `comment ${COMMENT_ID}`,
        when: stored.when,
        stat: stored.stat
    })
    expect(await getCommentByID(COMMENT_ID)).not.toHaveProperty("reactions")
    await expect(getCommentByID("00000001")).resolves.toBeNull()

    database.uploads[0]!.public = false
    await expect(getCommentByID(COMMENT_ID)).resolves.toBeNull()
})

test("returns upload comments oldest-first without private metadata", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })
    database.comments.push(
        makeComment(COMMENT_ID, UPLOAD_ID, "2026-08-25T11:00:00.000Z") as unknown as Document,
        makeComment(PARENT_ID, UPLOAD_ID, "2026-08-25T10:00:00.000Z") as unknown as Document
    )

    const comments = await getCommentsByUploadID(UPLOAD_ID)

    expect(comments?.map(comment => comment.id)).toEqual([PARENT_ID, COMMENT_ID])
    expect(comments?.[0]).not.toHaveProperty("issuer")
    expect(comments?.[0]).not.toHaveProperty("reactions")
    expect(database.sort).toEqual({ when: 1, id_comment_pub: 1 })
})

test("returns null for comments on missing or private uploads", async () => {
    await expect(getCommentsByUploadID(UPLOAD_ID)).resolves.toBeNull()

    database.uploads.push({ id_pub: UPLOAD_ID, public: false })
    await expect(getCommentsByUploadID(UPLOAD_ID)).resolves.toBeNull()
})

test("reports corrupt comments and database failures as 500", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })
    database.comments.push({ ...makeComment(COMMENT_ID, UPLOAD_ID), content: "" })

    await expect(getCommentsByUploadID(UPLOAD_ID))
        .rejects.toMatchObject({ statusCode: 500, message: "Corrupt comment document" })

    database.fail = true
    await expect(getCommentByID(COMMENT_ID))
        .rejects.toMatchObject({ statusCode: 500, message: "Database error" })
})

test("toggles and switches the single rating without count drift", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })
    database.comments.push(makeComment(COMMENT_ID, UPLOAD_ID) as unknown as Document)

    const up = await updateCommentReaction(
        makeRequest({ rating: "up", eyes: false }),
        COMMENT_ID
    )
    expect(up.stat).toEqual({ up: 1, down: 0, eyes: 0 })

    const repeated = await updateCommentReaction(
        makeRequest({ rating: "up", eyes: false }),
        COMMENT_ID
    )
    expect(repeated.stat).toEqual({ up: 1, down: 0, eyes: 0 })

    const down = await updateCommentReaction(
        makeRequest({ rating: "down", eyes: false }),
        COMMENT_ID
    )
    expect(down.stat).toEqual({ up: 0, down: 1, eyes: 0 })

    const cleared = await updateCommentReaction(
        makeRequest({ rating: null, eyes: false }),
        COMMENT_ID
    )
    expect(cleared.stat).toEqual({ up: 0, down: 0, eyes: 0 })
    expect(storedComment().reactions).toMatchObject({
        [CLIENT_UUID]: { rating: null, eyes: false }
    })
})

test("toggles eyes independently from the rating", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })
    database.comments.push(makeComment(COMMENT_ID, UPLOAD_ID) as unknown as Document)

    const selected = await updateCommentReaction(
        makeRequest({ rating: "up", eyes: true }),
        COMMENT_ID
    )
    expect(selected.stat).toEqual({ up: 1, down: 0, eyes: 1 })

    const eyesCleared = await updateCommentReaction(
        makeRequest({ rating: "up", eyes: false }),
        COMMENT_ID
    )
    expect(eyesCleared.stat).toEqual({ up: 1, down: 0, eyes: 0 })
})

test("keeps different clients' reactions independent and private", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })
    database.comments.push(makeComment(COMMENT_ID, UPLOAD_ID) as unknown as Document)

    await updateCommentReaction(makeRequest({ rating: "up", eyes: true }), COMMENT_ID)
    const result = await updateCommentReaction(
        makeRequest(
            { rating: "down", eyes: false },
            {},
            { "user-agent": "vitest", "x-client-uuid": CLIENT_UUID_B }
        ),
        COMMENT_ID
    )

    expect(result.stat).toEqual({ up: 1, down: 1, eyes: 1 })
    expect(result).not.toHaveProperty("reactions")
    expect(database.updated?.reactions).toMatchObject({
        [CLIENT_UUID]: { rating: "up", eyes: true },
        [CLIENT_UUID_B]: { rating: "down", eyes: false }
    })
})

test("rejects invalid reactions and inaccessible comments", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })
    database.comments.push(makeComment(COMMENT_ID, UPLOAD_ID) as unknown as Document)

    await expect(updateCommentReaction(makeRequest({ rating: "sideways", eyes: false }), COMMENT_ID))
        .rejects.toMatchObject({ statusCode: 400 })
    await expect(updateCommentReaction(makeRequest({ rating: "up", eyes: false }, {}, {}), COMMENT_ID))
        .rejects.toMatchObject({ statusCode: 400 })
    await expect(updateCommentReaction(makeRequest({ rating: "up", eyes: false }), "invalid"))
        .rejects.toMatchObject({ statusCode: 400 })
    await expect(updateCommentReaction(makeRequest({ rating: "up", eyes: false }), "00000000"))
        .rejects.toMatchObject({ statusCode: 404 })

    database.uploads[0]!.public = false
    await expect(updateCommentReaction(makeRequest({ rating: "up", eyes: false }), COMMENT_ID))
        .rejects.toMatchObject({ statusCode: 404 })
})

test("comment handlers return canonical comments and reaction counts", async () => {
    database.uploads.push({ id_pub: UPLOAD_ID, public: true })

    const createReply = captureReply()
    await createCommentHandler(
        makeRequest({ content: "hello" }, { uploadId: UPLOAD_ID }),
        createReply.reply
    )
    expect(createReply.result.status).toBe(201)

    const created = createReply.result.body as { id: string }
    const reactionReply = captureReply()
    await updateCommentReactionHandler(
        makeRequest({ rating: "up", eyes: true }, { commentId: created.id }),
        reactionReply.reply
    )
    expect(reactionReply.result.body).toMatchObject({
        id: created.id,
        stat: { up: 1, down: 0, eyes: 1 }
    })

    const oneReply = captureReply()
    await getCommentHandler(makeRequest(undefined, { commentId: created.id }), oneReply.reply)
    expect(oneReply.result.body).toEqual(reactionReply.result.body)

    const listReply = captureReply()
    await getUploadCommentsHandler(makeRequest(undefined, { uploadId: UPLOAD_ID }), listReply.reply)
    expect(listReply.result.body).toEqual([reactionReply.result.body])
})

test("HTTP read handlers return 404 for inaccessible resources", async () => {
    await expect(getUploadCommentsHandler(
        makeRequest(undefined, { uploadId: UPLOAD_ID }),
        captureReply().reply
    )).rejects.toMatchObject({ statusCode: 404 })

    await expect(getCommentHandler(
        makeRequest(undefined, { commentId: COMMENT_ID }),
        captureReply().reply
    )).rejects.toMatchObject({ statusCode: 404 })
})

test("comment_id_gen produces random 8-digit strings", () => {
    const sample = Array.from({ length: 1000 }, () => comment_id_gen())
    for (const id of sample)
        expect(id).toMatch(/^\d{8}$/)

    expect(new Set(sample).size).toBeGreaterThan(990)
})

