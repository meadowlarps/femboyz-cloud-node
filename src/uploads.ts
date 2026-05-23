import type { FastifyRequest } from "fastify"
import type { StorageDBUploadInstance, XMetaFiles } from "./schema.js"
import { writeFile } from "./storage.js"
import { WASMagic } from "wasmagic"
import { scope } from "./logger.js"

const scopelog = scope("uploads")
const magic = await WASMagic.create()
scopelog.info("WASMagic initialized")

export async function receiveUpload(request: FastifyRequest, _meta: XMetaFiles, _files: Buffer[]): Promise<void> {
    // DONE: check STORAGE_LIMIT_BYTES before writing -> done in API route handler to reject immediately on limit exceed
    // DONE: write each buffer to STORAGE_DIR/<sha256>
    // TODO: save document to MongoDB

    // console.debug("Received upload metadata:", _meta)
    scopelog.debug(`Received file sizes: ${_files.map(f => f.length)}`)

    const mongoDocument: StorageDBUploadInstance = {
        id_pub: genSafeID(),
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
    // console.debug("Final MongoDB document to insert:", mongoDocument)
}

function genSafeID(): string {
    // TODO: check for collisions in MongoDB, regenerate if collision occurs
    return idGen()
}

export function idGen(): string {
    // target format: 1234ABCD
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    const digits = "0123456789"
    const l = 4
    const r = 4
    let result = ""
    for (let i = 0; i < l; i++) {
        result += digits.charAt(Math.floor(Math.random() * digits.length))
    }
    for (let i = 0; i < r; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
}

export function typeClassify(mimes: string[]): "files" | "album" | "playlist" {
    const groups = new Set(mimes.map(m => m.split("/")[0]!))
    if (groups.size !== 1) return "files"
    if (groups.has("image") || groups.has("video")) return "album"
    if (groups.has("audio")) return "playlist"
    return "files"
}