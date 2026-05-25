import { errorFileLogger, scope }                       from "./logger.js"
import { shutdownUnexpectedly }                         from "./utils.js"
import { XMetaFilesSchema, type XMetaFiles, type StorageDBUploadInstance } from "./schema.js"
import { receiveUploadReturnID,
    receiveLinkReturnID,
    getAllUploadIDs,
    getUploadByID }                                    from "./uploads.js"
import { getStorageUsage, isThereEnoughStorageFor, readFile } from "./storage.js"
import { parseUploadStream }                            from "./stream.js"
import type { IncomingMessage }                         from "http"
import type { ContentTypeParserDoneFunction }           from "fastify/types/content-type-parser.js"
import      { filesize }    from "filesize"
import      { envs }        from "./config.js"
import Fastify, {
    type FastifyError,
    type FastifyInstance,
    type RouteShorthandOptions,
    type FastifyRequest,
    type FastifyReply }     from "fastify"
                
declare module "fastify" {
    interface FastifyRequest {
        xmeta?: XMetaFiles
    }
}

const scopelog = scope("api")
const server: FastifyInstance = Fastify({ logger: false })
const PORT = envs.PORT


export async function startServer() {
    scopelog.info("Starting server...")

    server.setErrorHandler(errorHandler)
    server.setNotFoundHandler(notFoundHandler)
    server.addContentTypeParser("application/octet-stream", 
        udstreamContentTypeParser)                                  // Custom content type parser for raw binary data
    server.addHook("onRequest", onRequestHook)                      // Log incoming requests
    server.get("/ping", pongHandler)                                // Serve: Pong
    server.get("/", rootHandler)                                    // Serve: Home page route
    server.get("/api/v2/ids", getListOfIdsHandler)                  // Serve: Route to get a list of all upload IDs
    server.get("/:id", getUploadHandler)                            // Serve: Route to handle fetching an upload by its ID
    server.get("/:id/:fid", getUploadHandler)                       // Serve: Route to specific file of :id upload
    server.get("/api/v2/maxfsize", askMaxFileUploadSizeHandler)     // Serve: Route to check how large file the server can accept
    server.post("/api/v2/ulink", ulinkVal, ulinkHandler)            // Receive: Route to handle receiving a new upload link
    server.post("/api/v2/udstream", udstreamVal, udstreamHandler)   // Receive: Route to handle receiving a new upload file stream

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
    reply.status(404).send({ error: "Not found" })
}

async function pongHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.send({ message: "pong" })
}

async function rootHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.send({ message: "Hello, World!" })
}

async function getListOfIdsHandler(request: FastifyRequest, reply: FastifyReply) {
    const ids: { id_pub: string, type: string }[] = await getAllUploadIDs()
    reply.send({ count: ids.length, ids: ids })
}

async function getUploadHandler(request: FastifyRequest, reply: FastifyReply) {
    const { id, fid } = request.params as { id: string; fid?: string }

    const upload = await getUploadByID(id)
    if (!upload) throw Object.assign(new Error("Upload not found"), { statusCode: 404 })

    if (fid !== undefined) {
        if (upload.type === "link") throw Object.assign(new Error("Not found"), { statusCode: 404 })
        const fidNum = parseInt(fid, 10)
        if (isNaN(fidNum) || fidNum < 0) throw Object.assign(new Error("Invalid file index"), { statusCode: 400 })
        const file = upload.files[fidNum]
        if (!file) throw Object.assign(new Error("File not found"), { statusCode: 404 })
        const buffer = await readFile(file.hashkey256)
        return reply
            .header("Content-Type", file.mime)
            .header("Content-Disposition", `inline; filename="${file.filename}"`)
            .header("Content-Length", String(buffer.length))
            .send(buffer)
    }

    if (upload.type === "link") return reply.redirect(upload.link.redir)

    const baseUrl = envs.BASE_URL ?? `${request.protocol}://${request.hostname}`
    const siteName = envs.SITE_NAME
    const accept = request.headers.accept ?? ""

    if (accept.includes("application/json")) {
        return reply.send({
            id: upload.id_pub,
            type: upload.type,
            public: upload.public,
            meta: upload.meta,
            files: upload.files.map((f, i) => ({
                index: i,
                filename: f.filename,
                size: f.size,
                mime: f.mime,
                url: `${baseUrl}/${id}/${i}`
            })),
            when: upload.when
        })
    }

    if (accept.includes("text/plain") && !accept.includes("text/html")) {
        const title = upload.meta.title || id
        const count = upload.files.length
        let text: string
        if (upload.type === "album") {
            const first = upload.files[0]!
            const kind = first.mime.startsWith("image/") ? "image" : "video"
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

async function udstreamHandler(request: FastifyRequest, reply: FastifyReply) {
    const xmeta = request.xmeta!
    const { fileBuffers, totalBytes } = await parseUploadStream(request.body as AsyncIterable<unknown>, xmeta)
    const upl: { id: string, type: string } = await receiveUploadReturnID(request, xmeta, fileBuffers)
    scopelog.info(`Received upload: '${xmeta.meta.title}' (${xmeta.files.length} files, total ${filesize(totalBytes)}) from ${request.ip}`)
    reply.status(200).send(upl)
}

async function askMaxFileUploadSizeHandler(request: FastifyRequest, reply: FastifyReply) {
    const maxAcceptableSize = Math.min(
        envs.MAX_FILE_SIZE * envs.MAX_FILE_COUNT_PER_UPLOAD, 
        envs.STORAGE_LIMIT_BYTES - getStorageUsage()
    )
    reply.status(200).send({ maxsize: maxAcceptableSize, maxsizeperfile: envs.MAX_FILE_SIZE })
}

// ---- UPLOAD PAGE ----

type FilesUpload = Extract<StorageDBUploadInstance, { type: "files" | "album" | "playlist" }>

function buildUploadPage(upload: FilesUpload, id: string, baseUrl: string, siteName: string): string {
    const title = upload.meta.title || id
    const desc  = upload.meta.desc
    const count = upload.files.length
    const first = upload.files[0]

    let ogTags = `<meta property="og:title" content="${escapeHtml(title)}">\n  `
    ogTags    += `<meta property="og:url" content="${baseUrl}/${id}">\n  `

    if (upload.type === "album" && first?.mime.startsWith("image/")) {
        const imgUrl = `${baseUrl}/${id}/0`
        if (first.mime === "image/gif") {
            ogTags += `<meta property="og:type" content="video.other">\n  `
            ogTags += `<meta property="og:image" content="${imgUrl}">\n  `
            ogTags += `<meta property="og:video" content="${imgUrl}">\n  `
            ogTags += `<meta property="og:video:type" content="image/gif">\n  `
        } else {
            ogTags += `<meta property="og:type" content="website">\n  `
            ogTags += `<meta property="og:image" content="${imgUrl}">\n  `
            ogTags += `<meta property="og:image:type" content="${escapeHtml(first.mime)}">\n  `
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

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

// ---- HELPERS ----

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
            throw Object.assign(new Error("Storage limit exceeded"), { statusCode: 507 })

        const raw = Buffer.from(request.headers["x-meta"] as string, "base64").toString("utf-8")

        let parsed: string
        try { parsed = JSON.parse(raw) }
        catch { throw Object.assign( new Error(`Invalid x-meta header, JSON parse failed: ${raw}`), {statusCode: 400}) }

        const result = XMetaFilesSchema.safeParse(parsed)
        if (!result.success)
            throw Object.assign(
                new Error(`Invalid x-meta header, validation failed: ${JSON.stringify(result.error.issues)}`), {statusCode: 400})
        
        request.xmeta = result.data
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

    const clientMessage =
        status === 400 || status > 404 && status < 500 ? "Bad request"
        : status === 401 ? "Unauthorized"
        : status === 403 ? "Forbidden"
        : status === 404 ? "Not found"
        : status === 507 ? "Storage limit exceeded"
        : "Internal server error"

    const clientStatus =
        status === 400 || status > 404 && status < 500 ? 400
        : status === 401 ? 401
        : status === 403 ? 403
        : status === 404 ? 404
        : status === 507 ? 507
        : 500

    reply.status(clientStatus).send({ error: clientMessage })
}

function udstreamContentTypeParser(request: FastifyRequest, payload: IncomingMessage, done: ContentTypeParserDoneFunction) {
    done(null, payload) // Pass the raw buffer to the route handler
}