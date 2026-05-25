import { createHash } from "node:crypto"
import type { XMetaFiles } from "./schema.js"

export async function parseUploadStream(
    stream: AsyncIterable<unknown>,
    xmeta: XMetaFiles
): Promise<{ fileBuffers: Buffer[], totalBytes: number }> {
    const fileBuffers = new Array<Buffer>(xmeta.files.length)
    let fileIdx = 0
    let remainingInFile = xmeta.files[0]!.bytes
    let fileChunks: Buffer[] = []
    let hash = createHash("sha256")
    let totalBytes = 0

    for await (const raw of stream) {
        const incoming: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
        totalBytes += incoming.length
        let pos = 0

        while (pos < incoming.length) {
            if (fileIdx >= xmeta.files.length)
                throw Object.assign(
                    new Error("Stream too long: received more bytes than declared"),
                    { statusCode: 400 })

            const take = Math.min(remainingInFile, incoming.length - pos)
            const slice = incoming.subarray(pos, pos + take)
            hash.update(slice)
            fileChunks.push(slice)
            pos += take
            remainingInFile -= take

            if (remainingInFile === 0) {
                const digest = hash.digest("hex")
                const xfile = xmeta.files[fileIdx]!
                if (digest !== xfile.sha256)
                    throw Object.assign(
                        new Error(`Hash mismatch for ${xfile.filename}:\nGOT:      ${digest}\nEXPECTED: ${xfile.sha256}`),
                        { statusCode: 400 })
                fileBuffers[fileIdx] = Buffer.concat(fileChunks)
                fileIdx++
                if (fileIdx < xmeta.files.length) {
                    remainingInFile = xmeta.files[fileIdx]!.bytes
                    fileChunks = []
                    hash = createHash("sha256")
                }
            }
        }
    }

    if (fileIdx !== xmeta.files.length)
        throw Object.assign(
            new Error(`Stream ended early: received ${fileIdx}/${xmeta.files.length} files`),
            { statusCode: 400 })

    return { fileBuffers, totalBytes }
}
