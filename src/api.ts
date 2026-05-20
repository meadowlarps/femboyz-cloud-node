import Fastify, {
    type FastifyError,
    type FastifyInstance,
    type RouteShorthandOptions,
    type FastifyRequest,
    type FastifyReply } from "fastify"
import { errorFileLogger, scope } from "./logger.js"
import { shutdownUnexpectedly } from "./utils.js"
import { envs } from "./config.js"
import { XMetaFilesSchema } from "./schema.js"
import type { IncomingMessage } from "http"
import type { ContentTypeParserDoneFunction } from "fastify/types/content-type-parser.js"

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
            required: ["x-meta", "content-type"],
            properties: {
                "content-type": { type: "string", const: "application/octet-stream" },
                "x-meta": { type: "string" }
            }
        }
    },
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const raw = request.headers["x-meta"] as string

        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            throw Object.assign(
                new Error(`Invalid x-meta header, expected JSON: ${raw}`), 
                {statusCode: 400})
        }

        const result = XMetaFilesSchema.safeParse(parsed)
        if (!result.success) {
            throw Object.assign(
                new Error(`Invalid x-meta header, validation failed: ${JSON.stringify(result.error.issues)}`), 
                {statusCode: 400})
        }
    }
}
async function onRequestHook(request: FastifyRequest, reply: FastifyReply) {
    scopelog.debug(`Received request: ${request.method} ${request.url} from ${request.ip}`)
}

function errorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
    const status = err.statusCode ?? 500
    scopelog.warn(`${status} — ${err.message}`)
    errorFileLogger.error({ err }, `${err.message} - "${status}" on "${request.method}" "${request.url}" from "${request.ip}"`)

    const clientSideStatusMessage = 
        status === 400 || status > 404 && status < 500 ? "Bad request"
        : status === 401 ? "Unauthorized"
        : status === 403 ? "Forbidden"
        : status === 404 ? "Not found"
        : "Internal server error"

    const clientSideStatusCode = 
        status === 400 || status > 404 && status < 500 ? 400
        : status === 401 ? 401
        : status === 403 ? 403
        : status === 404 ? 404
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

async function udstreamHandler(request: FastifyRequest, reply: FastifyReply) {
    reply.send({ message: "Udstream successful" })
}
