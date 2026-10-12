import { randomBytes } from "node:crypto"
import type { Document } from "mongodb"
import type { FastifyRequest } from "fastify"
import * as z from "zod"
import { filesize } from "filesize"
import { envs } from "./config.js"
import { authlimit_create } from "./authlimit.js"
import { getDB } from "./database.js"
import { errorFileLogger, scope } from "./logger.js"
import {
    TokenUseSchemaDB,
    UPLOAD_TOKEN_REGEX,
    UploadTokenCreateSchema,
    UploadTokenSchemaDB,
    UploadTokenUpdateSchema,
    type TokenUseDB,
    type UploadTokenDB,
    type XMetaFiles
} from "./schema.js"

const scopelog = scope("tokens")

export const TOKEN_HEADER = "x-upload-token"
// Practical ceiling for "unlimited files" — the base64 X-Meta header hits node's 16KB header limit around here anyway.
export const TOKEN_FILES_HARD_CAP = 100
const TOKEN_ID_ATTEMPTS = 5

// Separate from the admin limiter: a user fumbling a token must not lock anyone out of /admin, and vice versa.
export const token_authlimit = authlimit_create({
    max_fails: () => envs.UPLOAD_TOKEN_MAX_FAILS,
    block_ms: () => envs.UPLOAD_TOKEN_BLOCK_MINUTES * 60_000
})

export type TokenRejectReason = "unknown" | "revoked" | "expired" | "exhausted"
export type TokenStatus = "active" | TokenRejectReason
export type UploadLimitsEffective = { max_files: number, max_bytes_per_file: number, max_bytes_total: number }
type TokenIssuer = TokenUseDB["issuer"]

const TokenUsesQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
})

function tokens_collection() {
    return getDB().collection(envs.MDB_COLLECTION_TOKENS)
}

function token_uses_collection() {
    return getDB().collection(envs.MDB_COLLECTION_TOKEN_USES)
}

function token_database_error(action: string, err: unknown): never {
    const message = err instanceof Error ? err.message : String(err)
    scopelog.error(`Failed to ${action}: ${message}`)
    throw Object.assign(new Error("Database error"), { statusCode: 500 })
}

function token_parse(document: unknown): UploadTokenDB {
    const result = UploadTokenSchemaDB.safeParse(document)
    if (!result.success) {
        scopelog.error(`Invalid token document: ${JSON.stringify(result.error.issues)}`)
        throw Object.assign(new Error("Corrupt token document"), { statusCode: 500 })
    }
    return result.data
}

// ISO strings are compared lexically in mongo filters, so every stored date goes through toISOString()
function token_date_normalize(value: string | null): string | null {
    return value === null ? null : new Date(value).toISOString()
}

// ---- LIMITS ----

export function token_header_get(request: FastifyRequest): string | undefined {
    const header = request.headers[TOKEN_HEADER]
    if (typeof header !== "string") return undefined
    const token = header.trim()
    return token === "" ? undefined : token
}

export function token_is_usable(token: UploadTokenDB, now = Date.now()): TokenRejectReason | null {
    if (token.revoked) return "revoked"
    if (token.expires_at !== null && Date.parse(token.expires_at) <= now) return "expired"
    if (token.uses_max !== null && token.uses_count >= token.uses_max) return "exhausted"
    return null
}

export function token_status(token: UploadTokenDB, now = Date.now()): TokenStatus {
    return token_is_usable(token, now) ?? "active"
}

export function token_limits_effective(token: UploadTokenDB | null, free_bytes: number): UploadLimitsEffective {
    const free = Math.max(0, free_bytes)
    if (!token) {
        const max_files = envs.MAX_FILE_COUNT_PER_UPLOAD || 6
        const per_file = envs.MAX_FILE_SIZE || Infinity
        return {
            max_files,
            max_bytes_per_file: Math.min(per_file, free),
            max_bytes_total: Math.min(per_file * max_files, free)
        }
    }
    const max_bytes = Math.min(token.limits.max_bytes ?? Infinity, free)
    return {
        max_files: token.limits.max_files ?? TOKEN_FILES_HARD_CAP,
        max_bytes_per_file: max_bytes,
        max_bytes_total: max_bytes
    }
}

export function upload_limits_check(files: XMetaFiles["files"], limits: UploadLimitsEffective): string | null {
    if (files.length > limits.max_files)
        return `Too many files: ${files.length}/${limits.max_files}`
    const oversized = files.find(file => file.bytes > limits.max_bytes_per_file)
    if (oversized)
        return `File "${oversized.filename}" exceeds per-file limit of ${limits.max_bytes_per_file} bytes`
    const total = files.reduce((sum, file) => sum + file.bytes, 0)
    if (total > limits.max_bytes_total)
        return `Upload of ${total} bytes exceeds total limit of ${limits.max_bytes_total} bytes`
    return null
}

export function token_limits_info(token: UploadTokenDB) {
    return {
        label: token.label,
        max_files: token.limits.max_files,
        max_bytes: token.limits.max_bytes,
        uses_left: token.uses_max === null ? null : Math.max(0, token.uses_max - token.uses_count),
        expires_at: token.expires_at
    }
}

// ---- USAGE ----

export async function token_find(token: string): Promise<UploadTokenDB | null> {
    const document = await tokens_collection()
        .findOne({ token }, { projection: { _id: 0 } })
        .catch(err => token_database_error("find token", err))
    return document ? token_parse(document) : null
}

export type TokenReserveResult =
    | { ok: true, token: UploadTokenDB }
    | { ok: false, reason: TokenRejectReason, id_token: string }

/** Atomically spends one use, so parallel uploads can't both take the last one. */
export async function token_reserve(token: string, now = Date.now()): Promise<TokenReserveResult> {
    const now_iso = new Date(now).toISOString()
    const document = await tokens_collection()
        .findOneAndUpdate(
            {
                token,
                revoked: false,
                $and: [
                    { $or: [{ expires_at: null }, { expires_at: { $gt: now_iso } }] },
                    { $or: [{ uses_max: null }, { $expr: { $lt: ["$uses_count", "$uses_max"] } }] }
                ]
            },
            { $inc: { uses_count: 1 } },
            { returnDocument: "after", projection: { _id: 0 } })
        .catch(err => token_database_error("reserve token", err))
    if (document) return { ok: true, token: token_parse(document) }

    const existing = await token_find(token)
    if (!existing) return { ok: false, reason: "unknown", id_token: "unknown" }
    return { ok: false, reason: token_is_usable(existing, now) ?? "exhausted", id_token: existing.id_token }
}

export async function token_release(id_token: string): Promise<void> {
    await tokens_collection()
        .updateOne({ id_token, uses_count: { $gt: 0 } }, { $inc: { uses_count: -1 } })
        .catch(err => errorFileLogger.error({ err }, `Failed to release use of token ${id_token}`))
}

export function token_issuer_get(request: FastifyRequest): TokenIssuer {
    return {
        ip:   request.ip,
        ua:   request.headers["user-agent"] ?? "unknown",
        uuid: typeof request.headers["x-client-uuid"] === "string" ? request.headers["x-client-uuid"] : "not-implemented"
    }
}

// Enough to tell a typo or a bad paste (quotes, spaces, cut short) from a guess, without logging a usable secret.
export function token_supplied_hint(value: string): string {
    const shown = value.length >= 16 ? `${value.slice(0, 4)}…${value.slice(-2)}` : `${value.slice(0, 2)}…`
    const shape = UPLOAD_TOKEN_REGEX.test(value) ? "" : ", malformed"
    return `${shown} (${value.length} chars${shape})`
}

/** Who and where for token_use_log: issuer, route, and the supplied header's hint. */
export function token_log_context(request: FastifyRequest): Pick<TokenUseDB, "issuer" | "route" | "supplied"> {
    const supplied = token_header_get(request)
    return {
        issuer: token_issuer_get(request),
        route: `${request.method} ${request.routeOptions.url ?? request.url}`,
        ...(supplied === undefined ? {} : { supplied: token_supplied_hint(supplied) })
    }
}

/**
 * Counts a wrong guess against the caller's IP. Only "unknown" counts — revoked/expired/exhausted
 * tokens were real, so they aren't guessing. Success never clears the counter: otherwise one valid
 * token could be used to reset it between guesses.
 */
export function token_guess_register(issuer: TokenIssuer, reason: TokenRejectReason, now = Date.now()): void {
    if (reason !== "unknown") return
    const { blocked, blockedUntil } = token_authlimit.register_failure(issuer.ip, now)
    if (!blocked) return
    const summary = `Upload token guessing blocked - ip "${issuer.ip}" exceeded ${envs.UPLOAD_TOKEN_MAX_FAILS} unknown tokens, `
        + `blocked until ${new Date(blockedUntil).toISOString()} - ua "${issuer.ua}"`
    scopelog.warn(summary)
    errorFileLogger.error(summary)
}

/** Best-effort audit trail — a logging failure never fails the upload it describes. */
export async function token_use_log(entry: Omit<TokenUseDB, "when">): Promise<void> {
    // the hint only helps for unknown tokens; for real ones id_token already says which token it was
    const { supplied, ...rest } = entry
    const document: TokenUseDB = {
        ...rest,
        ...(supplied !== undefined && entry.id_token === "unknown" ? { supplied } : {}),
        when: new Date().toISOString()
    }
    if (entry.outcome !== "ok") {
        const summary = `Token ${entry.outcome} - id "${entry.id_token}" reason "${entry.reason ?? "none"}"`
            + (document.route ? ` - route "${document.route}"` : "")
            + (document.supplied ? ` - supplied "${document.supplied}"` : "")
            + (entry.files > 0 ? ` - ${entry.files} file(s), ${filesize(entry.bytes)}` : "")
            + ` - ip "${entry.issuer.ip}" - uuid "${entry.issuer.uuid}" - ua "${entry.issuer.ua}"`
        scopelog.warn(summary)
        errorFileLogger.error(summary)
    } else {
        scopelog.info(`Token ${entry.id_token} used for upload ${entry.id_upload_pub} from ${entry.issuer.ip}`)
    }
    await token_uses_collection()
        .insertOne(document)
        .catch(err => errorFileLogger.error({ err }, `Failed to log use of token ${entry.id_token}`))
}

// ---- ADMIN ----

function token_body_parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body)
    if (!result.success)
        throw Object.assign(new Error(`Invalid token body: ${JSON.stringify(result.error.issues)}`), { statusCode: 400 })
    return result.data
}

function token_admin_view(token: UploadTokenDB) {
    return { ...token, status: token_status(token) }
}

export async function token_list() {
    const documents = await tokens_collection()
        .find({}, { projection: { _id: 0 } })
        .sort({ when: -1 })
        .toArray()
        .catch(err => token_database_error("list tokens", err))
    return { items: documents.map(document => token_admin_view(token_parse(document))) }
}

// Which unique index a failed insert hit, or null when it wasn't a duplicate key error.
function token_duplicate_key(err: unknown): string | null {
    if (typeof err !== "object" || err === null || !("code" in err) || err.code !== 11000) return null
    const pattern = "keyPattern" in err && typeof err.keyPattern === "object" && err.keyPattern !== null ? err.keyPattern : {}
    return Object.keys(pattern)[0] ?? "unknown"
}

export async function token_create(body: unknown) {
    const input = token_body_parse(UploadTokenCreateSchema, body)
    const document: UploadTokenDB = {
        id_token:   randomBytes(4).toString("hex").toUpperCase(),
        token:      input.token ?? randomBytes(24).toString("base64url"),
        label:      input.label,
        limits:     input.limits,
        uses_max:   input.uses_max,
        uses_count: 0,
        expires_at: token_date_normalize(input.expires_at),
        revoked:    false,
        when:       new Date().toISOString()
    }

    for (let attempt = 1; ; attempt++) {
        try {
            // insertOne mutates its argument with _id — hand it a copy so the response stays clean
            await tokens_collection().insertOne({ ...document })
            break
        } catch (err) {
            const duplicate_key = token_duplicate_key(err)
            if (duplicate_key === null || attempt >= TOKEN_ID_ATTEMPTS) token_database_error("create token", err)
            const token_taken = duplicate_key === "token"
            // a custom value is the admin's choice — never swap it silently
            if (token_taken && input.token !== undefined) return { ok: false as const, reason: "duplicate" as const }
            if (token_taken) document.token = randomBytes(24).toString("base64url")
            else document.id_token = randomBytes(4).toString("hex").toUpperCase()
        }
    }

    scopelog.info(`Admin created ${input.token === undefined ? "random" : "custom"} token ${document.id_token} "${document.label}"`)
    return { ok: true as const, token: token_admin_view(document) }
}

export async function token_update(id_token: string, body: unknown) {
    const input = token_body_parse(UploadTokenUpdateSchema, body)
    const update: Document = { ...input }
    if (input.expires_at !== undefined) update.expires_at = token_date_normalize(input.expires_at)
    if (Object.keys(update).length === 0)
        throw Object.assign(new Error("Empty token update"), { statusCode: 400 })

    const document = await tokens_collection()
        .findOneAndUpdate({ id_token }, { $set: update }, { returnDocument: "after", projection: { _id: 0 } })
        .catch(err => token_database_error(`update token ${id_token}`, err))
    if (!document) return null

    scopelog.info(`Admin updated token ${id_token}: ${JSON.stringify(update)}`)
    return token_admin_view(token_parse(document))
}

// Usage logs are kept on purpose — the audit trail outlives the token.
export async function token_delete(id_token: string): Promise<boolean> {
    const result = await tokens_collection()
        .deleteOne({ id_token })
        .catch(err => token_database_error(`delete token ${id_token}`, err))
    if (result.deletedCount > 0) scopelog.info(`Admin deleted token ${id_token}`)
    return result.deletedCount > 0
}

export async function token_uses_list(id_token: string, query: unknown) {
    const parsed = TokenUsesQuerySchema.safeParse(query)
    if (!parsed.success)
        throw Object.assign(new Error("Invalid token uses query"), { statusCode: 400 })
    const { page, limit } = parsed.data

    const [documents, total] = await Promise.all([
        token_uses_collection()
            .find({ id_token }, { projection: { _id: 0 } })
            .sort({ when: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
        token_uses_collection().countDocuments({ id_token })
    ]).catch(err => token_database_error(`list uses of token ${id_token}`, err))

    const items = documents.flatMap(document => {
        const result = TokenUseSchemaDB.safeParse(document)
        if (result.success) return [result.data]
        scopelog.error(`Invalid token use document: ${JSON.stringify(result.error.issues)}`)
        return []
    })
    return { items, page, pageSize: limit, total, totalPages: Math.ceil(total / limit) }
}
