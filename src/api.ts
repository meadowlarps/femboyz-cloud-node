import { createHash } from "node:crypto"
import type { Readable } from "node:stream"
import Fastify, {
    type FastifyError,
    type FastifyInstance,
    type RouteShorthandOptions,
    type FastifyRequest,
    type FastifyReply } from "fastify"
import { errorFileLogger, scope } from "./logger.js"
import { shutdownUnexpectedly } from "./utils.js"
import { envs } from "./config.js"
import { XMetaFilesSchema, type XMetaFiles } from "./schema.js"
import { receiveUpload } from "./uploads.js"
import type { IncomingMessage } from "http"
import type { ContentTypeParserDoneFunction } from "fastify/types/content-type-parser.js"
import { filesize } from "filesize"
import { getStorageUsage } from "./storage.js"

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
    server.get("/:id", getUploadHandler)                            // Serve: Route to handle fetching an upload by its ID
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
        const raw = Buffer.from(request.headers["x-meta"] as string, "base64").toString("utf-8")

        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            throw Object.assign(
                new Error(`Invalid x-meta header, JSON parse failed: ${raw}`), {statusCode: 400})
        }

        const result = XMetaFilesSchema.safeParse(parsed)
        if (!result.success) {
            throw Object.assign(
                new Error(`Invalid x-meta header, validation failed: ${JSON.stringify(result.error.issues)}`), {statusCode: 400})
        }
        request.xmeta = result.data
    }
}
async function onRequestHook(request: FastifyRequest, reply: FastifyReply) {
    scopelog.debug(`Received request: ${request.method} ${request.url} from ${request.ip}`)
}

function errorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
    const status = err.statusCode ?? 500
    status < 500 ? scopelog.warn(`${status} — ${err.message}`) : scopelog.error(`${status} — ${err.message}`)
    errorFileLogger.error({ err }, `${err.message} - "${status}" on "${request.method}" "${request.url}" from "${request.ip}"`)

    const clientSideStatusMessage =
        status === 400 || status > 404 && status < 500 ? "Bad request"
        : status === 401 ? "Unauthorized"
        : status === 403 ? "Forbidden"
        : status === 404 ? "Not found"
        : status === 507 ? "Storage limit exceeded"
        : "Internal server error"

    const clientSideStatusCode =
        status === 400 || status > 404 && status < 500 ? 400
        : status === 401 ? 401
        : status === 403 ? 403
        : status === 404 ? 404
        : status === 507 ? 507
        : 500

    reply.status(clientSideStatusCode).send({ error: clientSideStatusMessage })
}

function udstreamContentTypeParser(request: FastifyRequest, payload: IncomingMessage, done: ContentTypeParserDoneFunction) {
    done(null, payload) // Pass the raw buffer to the route handler
}

function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
    scopelog.warn("404 — route not found")
    errorFileLogger.warn({ method: request.method, url: request.url }, "404 — route not found")

    reply.status(404).send({ error: "Not found" })
}

async function pongHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.send({ message: "pong" })
}

async function rootHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.send({ message: "Hello, World!" })
}

async function getUploadHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.send({ message: "Get upload successful" })
}

async function ulinkHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.send({ message: "Ulink successful" })
}

async function readStream(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
        let totalLength = 0
        for (const buffer of chunks) {
            totalLength += buffer.length
        }
    }
    return Buffer.concat(chunks)
}

async function udstreamHandler(request: FastifyRequest, reply: FastifyReply) {
    const meta = request.xmeta!

    const body = await readStream(request.body as Readable)

    const expectedBytes = meta.files.reduce((sum, f) => sum + f.bytes, 0)
    if (body.length !== expectedBytes)
        throw Object.assign(new Error(`Stream length mismatch: got ${body.length}, expected ${expectedBytes}`), { statusCode: 400 })
    if (await getStorageUsage() + body.length > envs.STORAGE_LIMIT_BYTES)
        throw Object.assign(new Error("Storage limit exceeded"), { statusCode: 507 })

    const fileBuffers: Buffer[] = []
    let offset = 0
    for (const fileMeta of meta.files) {
        const currentChunk = body.subarray(offset, offset + fileMeta.bytes)
        const computedHash = createHash("sha256").update(currentChunk).digest("hex")
        if (computedHash !== fileMeta.sha256)
            throw Object.assign(new Error(`Hash mismatch for ${fileMeta.filename}: \nHASH COMPUTE: ${computedHash}\nHASH META:    ${fileMeta.sha256}`), { statusCode: 400 })
        fileBuffers.push(currentChunk)
        offset += fileMeta.bytes
    }

    await receiveUpload(meta, fileBuffers)
    scopelog.info(`Received upload: Title: '${meta.meta.title}' (${meta.files.length} files, total ${filesize(body.length)}) - from ${request.ip}`)
    reply.status(200).send({ message: "Upload successful" })
}
