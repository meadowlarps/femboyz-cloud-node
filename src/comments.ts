import { randomInt } from "node:crypto"
import type { Document } from "mongodb"
import type { FastifyRequest } from "fastify"
import { envs } from "./config.js"
import { getDB } from "./database.js"
import { scope } from "./logger.js"
import { httpError, issueMessage } from "./httpError.js"
import {
    ClientUuidSchema,
    CommentCreateSchema,
    CommentIdSchema,
    CommentInstanceSchemaDB,
    CommentPublicSchema,
    CommentReactionUpdateSchema,
    type CommentInstanceDB,
    type CommentPublic,
    type CommentReactionState
} from "./schema.js"

const scopelog = scope("comments")
const COMMENT_LABELS = { content: "Comment", id_reply_to: "Reply target" }
const COMMENT_ID_ATTEMPTS = 8
const COMMENT_ID_DIGITS = "0123456789"

function databaseError(action: string, err: unknown): never {
    const message = err instanceof Error ? err.message : String(err)
    scopelog.error(`Failed to ${action}: ${message}`)
    throw Object.assign(new Error("Database error"), { statusCode: 500 })
}

function isDuplicateKeyError(err: unknown): boolean {
    return typeof err === "object"
        && err !== null
        && "code" in err
        && (err as { code: unknown }).code === 11000
}

function parseClientUuid(request: FastifyRequest): string {
    const header = request.headers["x-client-uuid"]
    if (typeof header !== "string")
        throw httpError(400, "Invalid client ID. Reload the page.")

    const parsed = ClientUuidSchema.safeParse(header)
    if (!parsed.success)
        throw httpError(400, "Invalid client ID. Reload the page.")

    return parsed.data
}

async function publicUploadExists(uploadId: string): Promise<boolean> {
    return Boolean(await getDB()
        .collection(envs.MDB_COLLECTION_UPLOADS)
        .findOne({ id_pub: uploadId, public: true }, { projection: { _id: 1 } })
        .catch(err => databaseError(`check upload ${uploadId}`, err)))
}

function toPublic(document: unknown, context: string): CommentPublic {
    const result = CommentInstanceSchemaDB.safeParse(document)
    if (!result.success) {
        scopelog.error(`Invalid comment ${context}: ${JSON.stringify(result.error.issues)}`)
        throw Object.assign(new Error("Corrupt comment document"), { statusCode: 500 })
    }

    const comment = result.data
    return CommentPublicSchema.parse({
        id: comment.id_comment_pub,
        ...(comment.id_reply_to === undefined ? {} : { id_reply_to: comment.id_reply_to }),
        content: comment.content,
        when: comment.when,
        stat: comment.stat
    })
}

function buildReactionUpdatePipeline(clientUuid: string, desired: CommentReactionState): Document[] {
    const desiredRating = desired.rating
    const desiredEyes = desired.eyes

    return [
        {
            $set: {
                _prior: {
                    $ifNull: [
                        { $getField: { field: clientUuid, input: { $ifNull: ["$reactions", {}] } } },
                        { rating: null, eyes: false }
                    ]
                }
            }
        },
        {
            $set: {
                stat: {
                    up: {
                        $max: [
                            0,
                            {
                                $add: [
                                    "$stat.up",
                                    { $cond: [{ $eq: ["$_prior.rating", "up"] }, -1, 0] },
                                    { $cond: [{ $eq: [desiredRating, "up"] }, 1, 0] }
                                ]
                            }
                        ]
                    },
                    down: {
                        $max: [
                            0,
                            {
                                $add: [
                                    "$stat.down",
                                    { $cond: [{ $eq: ["$_prior.rating", "down"] }, -1, 0] },
                                    { $cond: [{ $eq: [desiredRating, "down"] }, 1, 0] }
                                ]
                            }
                        ]
                    },
                    eyes: {
                        $max: [
                            0,
                            {
                                $add: [
                                    "$stat.eyes",
                                    { $cond: ["$_prior.eyes", -1, 0] },
                                    { $cond: [desiredEyes, 1, 0] }
                                ]
                            }
                        ]
                    }
                },
                reactions: {
                    $setField: {
                        field: clientUuid,
                        input: { $ifNull: ["$reactions", {}] },
                        value: { rating: desiredRating, eyes: desiredEyes }
                    }
                }
            }
        },
        { $unset: "_prior" }
    ]
}

async function insertCommentDocument(
    comments: ReturnType<ReturnType<typeof getDB>["collection"]>,
    document: CommentInstanceDB
): Promise<CommentInstanceDB> {
    let candidate = document

    for (let attempt = 0; attempt < COMMENT_ID_ATTEMPTS; attempt++) {
        try {
            await comments.insertOne(candidate)
            return candidate
        } catch (err) {
            if (!isDuplicateKeyError(err))
                databaseError("save comment", err)
            if (attempt === COMMENT_ID_ATTEMPTS - 1)
                databaseError("save comment", err)

            candidate = {
                ...candidate,
                id_comment_pub: comment_id_gen()
            }
        }
    }

    throw new Error("unreachable comment insert")
}

export async function createComment(request: FastifyRequest, uploadId: string): Promise<CommentPublic> {
    const input = CommentCreateSchema.safeParse(request.body)
    if (!input.success)
        throw httpError(400, issueMessage(input.error.issues, COMMENT_LABELS, "Invalid comment."))

    const clientUuid = parseClientUuid(request)

    if (!await publicUploadExists(uploadId))
        throw httpError(404, "Upload not found.")

    const comments = getDB().collection(envs.MDB_COLLECTION_COMMENTS)
    if (input.data.id_reply_to !== undefined) {
        const parent = await comments.findOne({
            id_comment_pub: input.data.id_reply_to,
            id_upload_pub: uploadId
        }, { projection: { _id: 1 } }).catch(err => databaseError("check parent comment", err))
        if (!parent)
            throw httpError(400, "Reply target not found.")
    }

    const document: CommentInstanceDB = CommentInstanceSchemaDB.parse({
        id_upload_pub: uploadId,
        id_comment_pub: comment_id_gen(),
        ...(input.data.id_reply_to === undefined ? {} : { id_reply_to: input.data.id_reply_to }),
        content: input.data.content,
        when: new Date().toISOString(),
        stat: { up: 0, down: 0, eyes: 0 },
        issuer: {
            ip: request.ip,
            ua: request.headers["user-agent"] ?? "unknown",
            uuid: clientUuid
        }
    })

    const saved = await insertCommentDocument(comments, document)
    return toPublic(saved, saved.id_comment_pub)
}

export async function updateCommentReaction(
    request: FastifyRequest,
    commentId: string
): Promise<CommentPublic> {
    if (!CommentIdSchema.safeParse(commentId).success)
        throw httpError(400, "Invalid comment ID.")

    const input = CommentReactionUpdateSchema.safeParse(request.body)
    if (!input.success)
        throw httpError(400, "Invalid reaction.")

    const clientUuid = parseClientUuid(request)
    const comments = getDB().collection(envs.MDB_COLLECTION_COMMENTS)

    const existing = await comments.findOne(
        { id_comment_pub: commentId },
        { projection: { _id: 0, id_upload_pub: 1 } }
    ).catch(err => databaseError(`fetch comment ${commentId}`, err))
    if (!existing)
        throw httpError(404, "Comment not found.")

    if (!await publicUploadExists(String(existing.id_upload_pub)))
        throw httpError(404, "Comment not found.")

    const updated = await comments.findOneAndUpdate(
        { id_comment_pub: commentId },
        buildReactionUpdatePipeline(clientUuid, input.data),
        { returnDocument: "after", projection: { _id: 0 } }
    ).catch(err => databaseError(`update reaction on comment ${commentId}`, err))

    if (!updated)
        throw httpError(404, "Comment not found.")

    return toPublic(updated, commentId)
}

export async function getCommentByID(commentId: string): Promise<CommentPublic | null> {
    const document = await getDB()
        .collection(envs.MDB_COLLECTION_COMMENTS)
        .findOne({ id_comment_pub: commentId }, { projection: { _id: 0 } })
        .catch(err => databaseError(`fetch comment ${commentId}`, err))
    if (!document) return null

    const result = CommentInstanceSchemaDB.safeParse(document)
    if (!result.success) return toPublic(document, commentId)
    if (!await publicUploadExists(result.data.id_upload_pub)) return null
    return toPublic(result.data, commentId)
}

export async function getCommentsByUploadID(uploadId: string): Promise<CommentPublic[] | null> {
    if (!await publicUploadExists(uploadId)) return null

    const documents = await getDB()
        .collection(envs.MDB_COLLECTION_COMMENTS)
        .find({ id_upload_pub: uploadId }, { projection: { _id: 0 } })
        .sort({ when: 1, id_comment_pub: 1 })
        .toArray()
        .catch(err => databaseError(`fetch comments for upload ${uploadId}`, err))

    return documents.map(document => toPublic(document, `for upload ${uploadId}`))
}

export function comment_id_gen(): string {
    let result = ""
    for (let i = 0; i < 8; i++)
        result += COMMENT_ID_DIGITS[randomInt(0, 10)]
    return result
}
