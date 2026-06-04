import type { FastifyRequest } from "fastify"
import { StorageDBUploadInstanceSchema, type StorageDBUploadInstance, type XMetaFiles } from "./schema.js"
import { writeFile } from "./storage.js"
import { WASMagic } from "wasmagic"
import { errorFileLogger, scope } from "./logger.js"
import { getDB } from "./database.js"
import { envs } from "./config.js"
import { randomInt } from "node:crypto";

const scopelog = scope("uploads")
const magic = await WASMagic.create()
scopelog.info("WASMagic initialized")

export async function getUploadByID(id: string): Promise<StorageDBUploadInstance | null> {
    const doc = await getDB()
        .collection(envs.MDB_COLLECTION_UPLOADS)
        .findOne({ id_pub: id }, { projection: { _id: 0 } })
        .catch(err => {
            const message = err instanceof Error ? err.message : String(err)
            scopelog.error(`Failed to fetch upload ${id}: ${message}`)
            throw Object.assign(new Error("Database error"), { statusCode: 500 })
        })
    if (!doc) return null
    const result = StorageDBUploadInstanceSchema.safeParse(doc)
    if (!result.success) {
        scopelog.error(`Invalid document for ID ${id}: ${JSON.stringify(result.error.issues)}`)
        throw Object.assign(new Error("Corrupt upload document"), { statusCode: 500 })
    }
    return result.data
}

export async function getAllUploadIDs(): Promise<{ id_pub: string, type: string }[]> {
    const c = getDB().collection(envs.MDB_COLLECTION_UPLOADS)
    const uploads = await c.find({}, { projection: { id_pub: 1, type: 1, _id: 0 } }).toArray()
        .catch(err => {
            const message = err instanceof Error ? err.message : String(err)
            scopelog.error(`Failed to fetch upload IDs from database: ${message}`)
            throw Object.assign(new Error("Database error"), { statusCode: 500 })
        })
    return uploads.map(u => ({ id_pub: u.id_pub as string, type: u.type as string}))
}

export async function receiveLinkReturnID(request: FastifyRequest): Promise<string> {
    const id_pub = await genSafeID()
    const body = request.body as { type: string, link: string }

    // ping site to check if link is alive
    try {
        const res = await fetch(body.link, { method: "HEAD", redirect: "manual" })
        if (res.status >= 400 && res.status < 500) {
            throw Object.assign(new Error(`Link is not reachable, status code: ${res.status}`), { statusCode: 404 })
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        scopelog.error(`Failed to reach provided link: ${message}`)
        throw Object.assign(new Error("Provided link is not reachable"), { statusCode: 404 })
    }

    const mongoDocument: StorageDBUploadInstance = {
        id_pub: id_pub,
        public: false,
        status: "ready",
        meta:   { title: "", desc: "" },
        stat:   { views: 0, up: 0, down: 0 },
        issuer: {
            ip:     request.ip,
            ua:     request.headers["user-agent"] as string ?? "unknown",
            uuid:   request.headers["x-client-uuid"] as string ?? "not-implemented"
        },
        when: new Date().toISOString(),
        type: "link",
        link: { redir: body.link }
    }

    let insertAttempts = 1
    while (true) {
        try {
            await getDB().collection(envs.MDB_COLLECTION_UPLOADS).insertOne(mongoDocument)
            break
        } catch (err: any) {
            if (err?.code === 11000 && insertAttempts++ <= 3) {
                scopelog.warn(`ID collision: ${id_pub}`)
                mongoDocument.id_pub = idGen()
                continue
            }
            errorFileLogger.error({ err })
            throw Object.assign(new Error("Database error"), { statusCode: 500 })
        }
    }

    scopelog.info(`Upload ${id_pub} saved to database as redirect link: ${body.link}`)

    return id_pub
}

export async function receiveUploadReturnID(request: FastifyRequest, _meta: XMetaFiles, _files: Buffer[]): Promise<{ id: string, type: string}> {
    // DONE: check STORAGE_LIMIT_BYTES before writing -> done in API route handler to reject immediately on limit exceed
    // DONE: write each buffer to STORAGE_DIR/<sha256>
    // DONE: save document to MongoDB

    // console.debug("Received upload metadata:", _meta)
    scopelog.debug(`Received file sizes: ${_files.map(f => f.length)}`)

    const mongoDocument: StorageDBUploadInstance = {
        id_pub: idGen(),
        public: _meta.is_public,
        status: "ready",
        meta:   _meta.meta,
        stat: { views: 0, up: 0, down: 0 },
        issuer: {
            ip:     request.ip,
            ua:     request.headers["user-agent"] as string ?? "unknown",
            uuid:   request.headers["x-client-uuid"] as string ?? "not-implemented"
        },
        when: new Date().toISOString(),
        type: "files",
        files: []
    }

    scopelog.debug(`Generated unique public ID: ${mongoDocument.id_pub}`)

    // process files
    await Promise.all(
        _files.map((_file, index) => {  
            mongoDocument.files.push({
                filename:       _meta.files[index]!.filename,
                size:           _meta.files[index]!.bytes,
                mime:           magic.detect(_file),
                hashkey256:     _meta.files[index]!.sha256,
                stat_dl:        0
            })
            return writeFile(_meta.files[index]!.sha256, _file)
        })
    )

    mongoDocument.type = typeClassify(mongoDocument.files.map(f => f.mime))
    scopelog.debug(`Classified upload type as: ${mongoDocument.type}`)

    let insertAttempts = 1
    while (true) {
        try {
            await getDB().collection(envs.MDB_COLLECTION_UPLOADS).insertOne(mongoDocument)
            break
        } catch (err: any) {
            if (err?.code === 11000 && insertAttempts++ <= 3) {
                scopelog.warn(`ID collision: ${mongoDocument.id_pub}`)
                mongoDocument.id_pub = idGen()
                continue
            }
            errorFileLogger.error({ err })
            throw Object.assign(new Error("Database error"), { statusCode: 500 })
        }
    }

    scopelog.info(`Upload ${mongoDocument.id_pub} saved to database with ${mongoDocument.files.length} file(s)`)

    return { id: mongoDocument.id_pub, type: mongoDocument.type}
}

async function genSafeID(): Promise<string> {
    // DONE: check for collisions in MongoDB, regenerate if collision occurs
    let id: string = ''
    do {
        if (id) scopelog.debug(`ID collision detected: ${id}. Regenerating...`)
        id = idGen()
    } while (await getDB().collection(envs.MDB_COLLECTION_UPLOADS).findOne({ id_pub: id }))
    return id
}

export function idGen(): string {
    const num_chars = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    const format = "NNNXCCCC"
    let result = ""

    for (let i = 0; i < format.length; i++)
        if      (format[i] === "N") result += randomInt(10)
        else if (format[i] === "C") result += chars[randomInt(chars.length)]
        else                        result += num_chars[randomInt(num_chars.length)]

    return result
}

export function typeClassify(mimes: string[]): "files" | "album" | "playlist" {
    const groups = new Set(mimes.map(m => m.split("/")[0]!))
    if (groups.size !== 1) return "files"
    if (groups.has("image") || groups.has("video")) return "album"
    if (groups.has("audio")) return "playlist"
    return "files"
}