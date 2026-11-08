import { ERROR_LOG_PATH, errorFileLogger, scope }       from "./logger.js"
import { shutdownUnexpectedly }                         from "./utils.js"
import { clientStatus, httpError, issueMessage, publicErrorMessage } from "./httpError.js"
import { NoteUploadSchema, XMetaFilesSchema, type XMetaFiles, type StorageDBUploadInstance, type UploadTokenDB } from "./schema.js"
import { receiveUploadReturnID,
    receiveLinkReturnID,
    receiveNoteReturnID,
    notePreview,
    getUploadByID,
    getUploadsByIDs,
    parseUploadIDsQuery,
    getAdminUploadPage,
    deleteUploadByID,
    incrementFileDownload,
    incrementUploadView }                              from "./uploads.js"
import { createFileReadStream, getIncomingDir, getStorageFree, getStorageLimit, getStorageUsage, isThereEnoughStorageFor, storage_release, storage_reserve } from "./storage.js"
import { parseUploadStream, type ReceivedFile }         from "./stream.js"
import { adminAuthStatus,
    authBlockRemainingMs,
    clearAuthFailures,
    registerAuthFailure,
    parseAdminQuery }                                   from "./admin.js"
import { buildErrorLogPage, parseErrorLogQuery, readErrorLogTail } from "./errorlog.js"
import { feed_get_all_uploads, feed_query_parse }        from "./feed.js"
import { createComment, getCommentByID, getCommentsByUploadID, updateCommentReaction } from "./comments.js"
import { token_create,
    token_delete,
    token_find,
    token_header_get,
    token_is_usable,
    token_issuer_get,
    token_log_context,
    token_limits_effective,
    token_limits_info,
    token_list,
    token_release,
    token_reserve,
    token_authlimit,
    token_guess_register,
    token_update,
    token_use_log,
    token_uses_list,
    upload_limits_check,
    type TokenRejectReason }                           from "./tokens.js"
import type { IncomingMessage, OutgoingHttpHeaders }    from "http"
import      fs              from "node:fs/promises"
import type { ContentTypeParserDoneFunction }           from "fastify/types/content-type-parser.js"
import      { filesize }    from "filesize"
import      { ACCOUNTS_ENABLED, envs } from "./config.js"
import      { attachmentContentDisposition, inlineContentDisposition, parseByteRange } from "./httpHeaders.js"
import Fastify, {
    type FastifyError,
    type FastifyInstance,
    type RouteShorthandOptions,
    type FastifyRequest,
    type FastifyReply }     from "fastify"
import cors from "@fastify/cors"
import { account_routes_register } from "./accountApi.js"
                
declare module "fastify" {
    interface FastifyRequest {
        xmeta?: XMetaFiles
        upload_token?: UploadTokenDB
        storage_reserved?: number
    }
}

const scopelog = scope("api")
// "loopback" covers 127.0.0.1/8 and ::1 — nginx and the SSR layer both sit on localhost, and
// resolving "localhost" to ::1 would otherwise make the forwarded client IP silently ignored.
const server: FastifyInstance = Fastify({ logger: false, trustProxy: "loopback" })
const PORT = envs.PORT


export async function startServer() {
    scopelog.info("Starting server...")

    await server.register(cors, {
        origin: envs.CORS_ORIGIN === "*" ? true : (envs.CORS_ORIGIN ?? false),
        methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    })

    server.setErrorHandler(errorHandler)
    server.setNotFoundHandler(notFoundHandler)
    server.addContentTypeParser("application/octet-stream", 
        udstreamContentTypeParser)                                  // Custom content type parser for raw binary data
    server.addHook("onRequest", onRequestHook)                      // Log incoming requests
    server.get("/ping", pongHandler)                                // Serve: Pong
    server.get("/", rootHandler)                                    // Serve: Home page route
    server.get("/api/v2/feed", feed_handle)                          // Serve: Paginated public upload feed
    server.post("/api/v2/viewed/:id", viewedUploadHandler)          // Count: Interactive upload view
    server.get("/api/v2/uploads", uploadsBatchHandler)              // Serve: Several uploads' JSON in one request
    server.get("/api/v2/admin/uploads", { preHandler: adminAuthHandler }, adminUploadsHandler)
    server.delete("/api/v2/admin/uploads/:id", { preHandler: adminAuthHandler }, adminDeleteUploadHandler)
    server.get("/api/v2/admin/logs", { preHandler: adminAuthHandler }, adminLogsHandler)
    server.get("/api/v2/admin/tokens", { preHandler: adminAuthHandler }, admin_tokens_list_handle)
    server.post("/api/v2/admin/tokens", { preHandler: adminAuthHandler }, admin_tokens_create_handle)
    server.patch("/api/v2/admin/tokens/:id", { preHandler: adminAuthHandler }, admin_tokens_update_handle)
    server.delete("/api/v2/admin/tokens/:id", { preHandler: adminAuthHandler }, admin_tokens_delete_handle)
    server.get("/api/v2/admin/tokens/:id/uses", { preHandler: adminAuthHandler }, admin_tokens_uses_handle)
    server.post("/api/v2/uploads/:uploadId/comments", createCommentHandler)
    server.get("/api/v2/uploads/:uploadId/comments", getUploadCommentsHandler)
    server.put("/api/v2/comments/:commentId/reactions", updateCommentReactionHandler)
    server.get("/api/v2/comments/:commentId", getCommentHandler)
    server.get("/:id", getUploadHandler)                            // Serve: Route to handle fetching an upload by its ID
    server.get("/:id/:fid", getUploadHandler)                       // Serve: Route to specific file of :id upload
    server.get("/api/v2/maxfsize", askMaxFileUploadSizeHandler)     // Serve: Route to check how large file the server can accept
    server.post("/api/v2/ulink", ulinkVal, ulinkHandler)            // Receive: Route to handle receiving a new upload link
    server.post("/api/v2/unote", unoteVal, unoteHandler)            // Receive: Route to handle receiving a new text note
    server.post("/api/v2/udstream", udstreamVal, udstreamHandler)   // Receive: Route to handle receiving a new upload file stream
    if (ACCOUNTS_ENABLED)
        await account_routes_register(server, adminAuthHandler)    // femboyz accounts: /oidc/*, /api/v2/account/*, admin account routes

    try {
        await server.listen({ port: PORT })
        scopelog.info(`Server started on port ${PORT}`)
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        scopelog.error(message)
        shutdownUnexpectedly()
    }
}

function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
    scopelog.warn("404 — route not found")
    reply.status(404).send({ error: "There's nothing at this address." })
}

async function pongHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.send({ message: "pong" })
}

async function rootHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.send({ message: "Hello, World!" })
}

export async function feed_handle(request: FastifyRequest, reply: FastifyReply) {
    const range = feed_query_parse(request.query)
    const all_uploads = feed_get_all_uploads()
    const base_url = (envs.BASE_URL ?? `${request.protocol}://${request.hostname}`).replace(/\/$/, "")
    const items = all_uploads.slice(range.start, range.end).map(upload => {
        const common = {
            id: upload.id_pub,
            type: upload.type,
            meta: upload.meta,
            views: upload.stat.views,
            when: upload.when
        }

        if (upload.type === "link")
            return { ...common, files: [], link: upload.link.redir }
        if (upload.type === "note")
            return { ...common, files: [], note_preview: notePreview(upload.note.text), note_length: upload.note.text.length }

        return {
            ...common,
            files: upload.files.map((file, index) => ({
                index,
                filename: file.filename,
                size: file.size,
                mime: file.mime,
                url: `${base_url}/${upload.id_pub}/${index}`,
                stat_dl: file.stat_dl
            }))
        }
    })

    reply.send({
        items,
        start: range.start,
        end: range.end,
        total: all_uploads.length,
        has_more: range.end < all_uploads.length
    })
}

/**
 * Public JSON descriptor of an upload, as returned by `GET /:id` with `Accept: application/json`.
 * Notes carry their full text only when `fullNote` is set; lists get the preview alone.
 */
function uploadToJSON(upload: StorageDBUploadInstance, baseUrl: string, fullNote = false) {
    const common = {
        id: upload.id_pub,
        type: upload.type,
        public: upload.public,
        meta: upload.meta,
        views: upload.stat.views,
        when: upload.when
    }

    if (upload.type === "link")
        return { ...common, files: [], link: upload.link.redir }
    if (upload.type === "note")
        return {
            ...common,
            files: [],
            note_preview: notePreview(upload.note.text),
            note_length: upload.note.text.length,
            ...(fullNote ? { note: upload.note.text } : {})
        }

    return {
        ...common,
        files: upload.files.map((file, index) => ({
            index,
            filename: file.filename,
            size: file.size,
            mime: file.mime,
            url: `${baseUrl.replace(/\/$/, "")}/${upload.id_pub}/${index}`,
            stat_dl: file.stat_dl
        }))
    }
}

export async function uploadsBatchHandler(request: FastifyRequest, reply: FastifyReply) {
    const ids = parseUploadIDsQuery(request.query)
    const baseUrl = envs.BASE_URL ?? `${request.protocol}://${request.hostname}`
    const byId = new Map((await getUploadsByIDs(ids)).map(upload => [upload.id_pub, upload]))
    const items = []
    const missing = []
    for (const id of ids) {
        const upload = byId.get(id)
        if (upload) items.push(uploadToJSON(upload, baseUrl))
        else missing.push(id)
    }
    reply.send({ items, missing })
}

export async function viewedUploadHandler(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string }
    if (!await incrementUploadView(id))
        throw httpError(404, UPLOAD_NOT_FOUND)
    reply.status(204).send()
}

export async function createCommentHandler(request: FastifyRequest, reply: FastifyReply) {
    const { uploadId } = request.params as { uploadId: string }
    reply.status(201).send(await createComment(request, uploadId))
}

export async function getUploadCommentsHandler(request: FastifyRequest, reply: FastifyReply) {
    const { uploadId } = request.params as { uploadId: string }
    const comments = await getCommentsByUploadID(uploadId)
    if (!comments)
        throw httpError(404, UPLOAD_NOT_FOUND)
    reply.send(comments)
}

export async function getCommentHandler(request: FastifyRequest, reply: FastifyReply) {
    const { commentId } = request.params as { commentId: string }
    const comment = await getCommentByID(commentId)
    if (!comment)
        throw httpError(404, "Comment not found.")
    reply.send(comment)
}

export async function updateCommentReactionHandler(request: FastifyRequest, reply: FastifyReply) {
    const { commentId } = request.params as { commentId: string }
    reply.send(await updateCommentReaction(request, commentId))
}

export async function adminAuthHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store")

    const blockedMs = authBlockRemainingMs(request.ip)
    if (blockedMs > 0) {
        reply.header("Retry-After", String(Math.ceil(blockedMs / 1000)))
        throw httpError(429, "Too many wrong admin keys.")
    }

    const status = adminAuthStatus(request.headers.authorization, envs.AUTH_ADMIN_KEY)
    if (status === 503)
        throw httpError(503, "AUTH_ADMIN_KEY isn't configured.")
    if (status === 401) {
        const { blocked, blockedUntil } = registerAuthFailure(request.ip)
        if (blocked) {
            const summary = `Admin auth blocked - ip "${request.ip}" exceeded ${envs.AUTH_ADMIN_MAX_FAILS} failed attempts, `
                + `blocked until ${new Date(blockedUntil).toISOString()} - ua "${request.headers["user-agent"] ?? "unknown"}"`
            scopelog.warn(summary)
            errorFileLogger.error(summary)
        }
        throw httpError(401, "Wrong admin key.")
    }
    clearAuthFailures(request.ip)
}

async function adminUploadsHandler(request: FastifyRequest, reply: FastifyReply) {
    const query = parseAdminQuery(request.query)
    const baseUrl = envs.BASE_URL ?? `${request.protocol}://${request.hostname}`
    const uploads = await getAdminUploadPage(query, baseUrl)
    const usedBytes = getStorageUsage()
    const limitBytes = getStorageLimit()
    reply.send({
        ...uploads,
        storage: { usedBytes, limitBytes, freeBytes: Math.max(0, limitBytes - usedBytes) }
    })
}

async function adminDeleteUploadHandler(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string }
    const result = await deleteUploadByID(id)
    if (!result) throw httpError(404, UPLOAD_NOT_FOUND)
    reply.send(result)
}

async function adminLogsHandler(request: FastifyRequest, reply: FastifyReply) {
    const query = parseErrorLogQuery(request.query)
    const tail = await readErrorLogTail(ERROR_LOG_PATH)
    reply.send(buildErrorLogPage(query, tail))
}

async function admin_tokens_list_handle(request: FastifyRequest, reply: FastifyReply) {
    reply.send(await token_list())
}

async function admin_tokens_create_handle(request: FastifyRequest, reply: FastifyReply) {
    const result = await token_create(request.body)
    // sent directly: errorHandler would flatten 409 into a generic "Bad request"
    if (!result.ok) return reply.status(409).send({ error: "Token value already taken." })
    reply.status(201).send(result.token)
}

async function admin_tokens_update_handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string }
    const token = await token_update(id, request.body)
    if (!token) throw httpError(404, "Token not found.")
    reply.send(token)
}

async function admin_tokens_delete_handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string }
    if (!await token_delete(id)) throw httpError(404, "Token not found.")
    reply.send({ deleted: true, id })
}

async function admin_tokens_uses_handle(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id: string }
    reply.send(await token_uses_list(id, request.query))
}

async function getUploadHandler(request: FastifyRequest, reply: FastifyReply) {
    const { id, fid } = request.params as { id: string; fid?: string }

    const upload = await getUploadByID(id)
    if (!upload) throw httpError(404, UPLOAD_NOT_FOUND)

    if (fid !== undefined) {
        if (upload.type === "link" || upload.type === "note") throw httpError(404, "Upload has no files.")
        const fidNum = parseInt(fid, 10)
        if (isNaN(fidNum) || fidNum < 0) throw httpError(400, "Invalid file index.")
        const file = upload.files[fidNum]
        if (!file) throw httpError(404, "File not found.")

        const { dl } = request.query as { dl?: string }
        const wantsDownload = dl === "1"

        reply
            .header("Content-Type", file.mime)
            .header("Content-Disposition", wantsDownload
                ? attachmentContentDisposition(file.filename)
                : inlineContentDisposition(file.filename))
            .header("Content-Security-Policy", "sandbox")
            .header("X-Content-Type-Options", "nosniff")
            .header("Accept-Ranges", "bytes")

        let range
        try {
            range = parseByteRange(request.headers.range, file.size)
        } catch (err) {
            if (!(err instanceof RangeError)) throw err
            return reply
                .status(416)
                .header("Content-Range", `bytes */${file.size}`)
                .send()
        }

        reply.header("Content-Length", String(range ? range.end - range.start + 1 : file.size))

        if (range)
            reply.status(206).header("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`)

        if (request.method === "HEAD") {
            reply.hijack()
            reply.raw.writeHead(reply.statusCode, reply.getHeaders() as OutgoingHttpHeaders)
            reply.raw.end()
            return reply
        }

        // Only whole-file download requests count — ranged reads are seeks or resumed transfers.
        if (wantsDownload && !range) void incrementFileDownload(id, fidNum)

        return reply.send(createFileReadStream(file.hashkey256, range))
    }

    const baseUrl = envs.BASE_URL ?? `${request.protocol}://${request.hostname}`
    const siteName = envs.SITE_NAME
    const accept = request.headers.accept ?? ""

    if (accept.includes("application/json"))
        return reply.send(uploadToJSON(upload, baseUrl, true))

    if (upload.type === "link")
        return reply.redirect(upload.link.redir)

    if (upload.type === "note") {
        if (accept.includes("text/plain") && !accept.includes("text/html"))
            return reply.type("text/plain; charset=utf-8").send(upload.note.text)
        return reply.type("text/html").send(buildNotePage(upload, id, baseUrl, siteName))
    }

    if (accept.includes("text/plain") && !accept.includes("text/html")) {
        const title = upload.meta.title || id
        const count = upload.files.length
        let text: string
        if (upload.type === "album") {
            const mediaGroups = new Set(upload.files.map(file => file.mime.split("/")[0]))
            const kind = mediaGroups.size === 1
                ? (mediaGroups.has("image") ? "image" : "video")
                : "media item"
            text = `${title}\n${count} ${kind}${count !== 1 ? "s" : ""} via ${siteName}`
        } else if (upload.type === "playlist") {
            text = `${title}\nPlaylist via ${baseUrl} (${count} audio${count !== 1 ? "s" : ""})`
        } else {
            text = `${title}\n${count} file${count !== 1 ? "s" : ""} via ${siteName}`
        }
        return reply.type("text/plain").send(text)
    }

    return reply.type("text/html").send(buildUploadPage(upload, id, baseUrl, siteName))
}

async function ulinkHandler(request: FastifyRequest, reply: FastifyReply) {
    const id = await receiveLinkReturnID(request)

    reply.send({ message: "Ulink successful", id: id })
}

async function unoteHandler(request: FastifyRequest, reply: FastifyReply) {
    const result = NoteUploadSchema.safeParse(request.body)
    if (!result.success)
        throw httpError(400, issueMessage(result.error.issues, NOTE_LABELS, "Invalid note."), JSON.stringify(result.error.issues))
    const id = await receiveNoteReturnID(request, result.data)

    reply.send({ message: "Unote successful", id: id })
}

async function udstreamHandler(request: FastifyRequest, reply: FastifyReply) {
    const xmeta = request.xmeta!
    const token = request.upload_token
    const declared_bytes = xmeta.files.reduce((sum, file) => sum + file.bytes, 0)
    let upl: { id: string, type: string }
    let total_bytes: number
    let files: ReceivedFile[] = []
    try {
        const parsed = await parseUploadStream(request.body as AsyncIterable<unknown>, xmeta, getIncomingDir())
        files = parsed.files
        total_bytes = parsed.total_bytes
        upl = await receiveUploadReturnID(request, xmeta, files, token?.id_token)
    } catch (err) {
        if (token) {
            // the use was reserved in preHandler — give it back, the upload never landed
            await token_release(token.id_token)
            await token_use_log({
                id_token: token.id_token, outcome: "failed", reason: err instanceof Error ? err.message : String(err),
                files: xmeta.files.length, bytes: declared_bytes, ...token_log_context(request)
            })
        }
        throw err
    } finally {
        storage_release(request.storage_reserved ?? 0)
        // committed files were already renamed away; this only catches leftovers from a failed commit
        await Promise.all(files.map(f => fs.rm(f.tmp_path, { force: true }).catch(() => {})))
    }
    if (token)
        await token_use_log({
            id_token: token.id_token, outcome: "ok", id_upload_pub: upl.id,
            files: xmeta.files.length, bytes: total_bytes, ...token_log_context(request)
        })
    scopelog.info(
        `Received upload: '${xmeta.meta.title}' (${xmeta.files.length} files ` 
        + `total ${filesize(total_bytes)}) from ${request.ip}${token ? ` with token ${token.id_token}` : ""}`)
    reply.status(200).send(upl)
}

async function askMaxFileUploadSizeHandler(request: FastifyRequest, reply: FastifyReply) {
    const supplied = token_header_get(request)
    let token: UploadTokenDB | null = null
    if (supplied !== undefined) {
        const blocked = token_reply_blocked(request, reply)
        if (blocked) return blocked
        token = await token_find(supplied)
        const reason = token ? token_is_usable(token) : "unknown"
        if (reason) {
            token_guess_register(token_issuer_get(request), reason)
            await token_use_log({
                id_token: token?.id_token ?? "unknown", outcome: "rejected", reason: `prerequest: ${reason}`,
                files: 0, bytes: 0, ...token_log_context(request)
            })
            return token_reply_rejected(reply, reason)
        }
    }

    const limits = token_limits_effective(token, getStorageFree())
    reply.status(200).send({ 
        maxsize: limits.max_bytes_total, 
        maxsizeperfile: limits.max_bytes_per_file,
        maxcount: limits.max_files,
        max_title_length: envs.MAX_TITLE_LENGTH_PER_UPLOAD,
        max_desc_length: envs.MAX_DESC_LENGTH_PER_UPLOAD,
        max_note_length: envs.MAX_NOTE_LENGTH,
        ...(token ? { token: token_limits_info(token) } : {})
    })
}

// Checked before any token lookup, so a blocked IP learns nothing more about which tokens exist.
function token_reply_blocked(request: FastifyRequest, reply: FastifyReply) {
    const blocked_ms = token_authlimit.block_remaining_ms(request.ip)
    if (blocked_ms <= 0) return null
    return reply
        .status(429)
        .header("Retry-After", String(Math.ceil(blocked_ms / 1000)))
        .header("Cache-Control", "no-store")
        .send({ error: "Too many wrong tokens." })
}

// Token rejections skip errorHandler on purpose: the client needs the reason, and token_use_log already wrote it down.
function token_reply_rejected(reply: FastifyReply, reason: TokenRejectReason) {
    return reply.status(403).header("Cache-Control", "no-store").send({ error: TOKEN_REJECT_MESSAGES[reason] })
}

// ---- UPLOAD PAGE ----

type FilesUpload = Extract<StorageDBUploadInstance, { type: "files" | "album" | "playlist" }>

function buildUploadPage(upload: FilesUpload, id: string, baseUrl: string, siteName: string): string {
    const title = upload.meta.title || id
    const desc  = upload.meta.desc
    const count = upload.files.length
    const previewImageIndex = upload.type === "album"
        ? upload.files.findIndex(file => file.mime.startsWith("image/"))
        : -1
    const previewImage = upload.files[previewImageIndex]

    let ogTags = `<meta property="og:title" content="${escapeHtml(title)}">\n  `
    ogTags    += `<meta property="og:url" content="${baseUrl}/${id}">\n  `

    if (previewImage) {
        const imgUrl = `${baseUrl}/${id}/${previewImageIndex}`
        if (previewImage.mime === "image/gif") {
            ogTags += `<meta property="og:type" content="video.other">\n  `
            ogTags += `<meta property="og:image" content="${imgUrl}">\n  `
            ogTags += `<meta property="og:video" content="${imgUrl}">\n  `
            ogTags += `<meta property="og:video:type" content="image/gif">\n  `
        } else {
            ogTags += `<meta property="og:type" content="website">\n  `
            ogTags += `<meta property="og:image" content="${imgUrl}">\n  `
            ogTags += `<meta property="og:image:type" content="${escapeHtml(previewImage.mime)}">\n  `
        }
    } else {
        ogTags += `<meta property="og:type" content="website">\n  `
        ogTags += `<meta property="og:description" content="${count} file${count !== 1 ? "s" : ""} via ${siteName}">\n  `
    }

    const items = upload.files
        .map((f, i) => `    <li><a href="${baseUrl}/${id}/${i}">${escapeHtml(f.filename)}</a> — ${escapeHtml(f.mime)}, ${filesize(f.size)}</li>`)
        .join("\n")

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${ogTags}<title>${escapeHtml(title)}</title>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${desc ? `<p>${escapeHtml(desc)}</p>` : ""}
  <ul>
${items}
  </ul>
</body>
</html>`
}

type NoteUploadDB = Extract<StorageDBUploadInstance, { type: "note" }>

function buildNotePage(upload: NoteUploadDB, id: string, baseUrl: string, siteName: string): string {
    const title = upload.meta.title || id
    const excerpt = notePreview(upload.note.text).replace(/\s+/g, " ").trim()

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:url" content="${baseUrl}/${id}">
  <meta property="og:type" content="article">
  <meta property="og:description" content="${escapeHtml(excerpt || `Note via ${siteName}`)}">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <pre style="white-space: pre-wrap">${escapeHtml(upload.note.text)}</pre>
</body>
</html>`
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

// ---- HELPERS ----

const UPLOAD_NOT_FOUND = "Upload not found."
const STORAGE_FULL = "Server storage is full."

const TOKEN_REJECT_MESSAGES: Record<TokenRejectReason, string> = {
    unknown: "Unknown token.",
    revoked: "Token revoked.",
    expired: "Token expired.",
    exhausted: "Token used up."
}

const NOTE_LABELS = { "meta.title": "Title", text: "Note" }
const XMETA_LABELS = {
    "meta.title": "Title",
    "meta.desc": "Description",
    files: "File list",
    "files.*.filename": "File name",
    "files.*.sha256": "File hash",
    "files.*.bytes": "File size"
}

const ulinkVal: RouteShorthandOptions = {
    schema: {
        body: { 
            type: "object",
            required: ["type", "link"],
            properties: {
                type: { type: "string", const: "link" },
                link: { type: "string", format: "uri", pattern: "^(https?://|www\\.)" }
            }
        }
    }
}

const unoteVal: RouteShorthandOptions = {
    // 100k chars can reach ~600 KB of JSON once escaped; content is validated by NoteUploadSchema in the handler
    bodyLimit: 2 * 1024 * 1024,
    schema: {
        body: {
            type: "object",
            required: ["type", "text"],
            properties: {
                type: { type: "string", const: "note" },
                text: { type: "string" }
            }
        }
    }
}

const udstreamVal: RouteShorthandOptions = {
    schema: {
        headers: {
            type: "object",
            required: ["x-meta", "content-type", "content-length"],
            properties: {
                "content-type": { type: "string", const: "application/octet-stream" },
                "content-length": { type: "integer", minimum: envs.MIN_FILE_SIZE || 0 },
                "x-meta": { type: "string" }
            }
        }
    },
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        // changed x-meta header from stringfied JSON to base64 encoded JSON 
        // to avoid issues with special characters in headers and to allow larger metadata
        if (!isThereEnoughStorageFor(parseInt(request.headers["content-length"] as string)))
            throw httpError(507, STORAGE_FULL)

        const raw = Buffer.from(request.headers["x-meta"] as string, "base64").toString("utf-8")

        let parsed: string
        try { parsed = JSON.parse(raw) }
        catch { throw httpError(400, "X-Meta header isn't valid JSON.", raw.slice(0, 500)) }

        const result = XMetaFilesSchema.safeParse(parsed)
        if (!result.success)
            throw httpError(400, issueMessage(result.error.issues, XMETA_LABELS, "Invalid X-Meta header."),
                JSON.stringify(result.error.issues))
        const xmeta = result.data
        const declared_bytes = xmeta.files.reduce((sum, file) => sum + file.bytes, 0)

        const supplied = token_header_get(request)
        if (supplied !== undefined) {
            const blocked = token_reply_blocked(request, reply)
            if (blocked) return blocked
            const reserved = await token_reserve(supplied)
            if (!reserved.ok) {
                token_guess_register(token_issuer_get(request), reserved.reason)
                await token_use_log({
                    id_token: reserved.id_token, outcome: "rejected", reason: reserved.reason,
                    files: xmeta.files.length, bytes: declared_bytes, ...token_log_context(request)
                })
                return token_reply_rejected(reply, reserved.reason)
            }
            request.upload_token = reserved.token
        }

        const violation = upload_limits_check(xmeta.files, token_limits_effective(request.upload_token ?? null, getStorageFree()))
        if (violation) {
            if (request.upload_token) {
                await token_release(request.upload_token.id_token)
                await token_use_log({
                    id_token: request.upload_token.id_token, outcome: "rejected", reason: violation,
                    files: xmeta.files.length, bytes: declared_bytes, ...token_log_context(request)
                })
            }
            throw httpError(413, violation)
        }

        // the check above is a cheap early reject; this claims the space so concurrent uploads can't overbook it
        const reserve_bytes = parseInt(request.headers["content-length"] as string)
        if (!storage_reserve(reserve_bytes)) {
            if (request.upload_token) await token_release(request.upload_token.id_token)
            throw httpError(507, STORAGE_FULL)
        }
        request.storage_reserved = reserve_bytes
        request.xmeta = xmeta
    }
}

async function onRequestHook(request: FastifyRequest, reply: FastifyReply) {
    scopelog.debug(`Received request: ${request.method} ${request.url} from ${request.ip}`)
}

function errorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
    const status = err.statusCode ?? 500
    // looks ugly af but idk how to make this cleaner
    status < 500 ? scopelog.warn(`${status} — ${err.message} from ${request.ip}`) : scopelog.error(`${status} — ${err.message} from ${request.ip}`)
    errorFileLogger.error({ err }, `${err.message} - "${status}" on "${request.method}" "${request.url}" from "${request.ip}"`)

    reply.status(clientStatus(status)).send({ error: publicErrorMessage(err, status) })
}

function udstreamContentTypeParser(request: FastifyRequest, payload: IncomingMessage, done: ContentTypeParserDoneFunction) {
    done(null, payload) // Pass the raw buffer to the route handler
}
