import { createHash } from "node:crypto"
import type { XMetaFiles } from "./schema.js"
import { filesize } from "filesize"

export async function parseUploadStream(
    stream: AsyncIterable<unknown>,
    xmeta: XMetaFiles
): Promise<{ files_buffers: Buffer[], total_bytes: number }> {
    const xfiles = xmeta.files
    const total_declared_bytes = xfiles.reduce((a, f) => a + f.bytes, 0)
    const files_buffers = new Array<Buffer>(xfiles.length)
    let curr_file_idx = 0
    let curr_file_chunks: Buffer[] = []
    let curr_file_bytes_left = xfiles[curr_file_idx]!.bytes
    let hash = createHash("sha256")
    let total_bytes = 0

    for await (const raw of stream) {
        const packet: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
        total_bytes += packet.length
        let progress = 0

        while (progress < packet.length) {
            if (curr_file_idx >= xfiles.length)
                throw Object.assign(
                    new Error("Stream too long: received more bytes than declared"),
                    { statusCode: 400 })

            const take = Math.min(curr_file_bytes_left, packet.length - progress)
            const chunk = packet.subarray(progress, progress + take)
            hash.update(chunk)
            curr_file_chunks.push(chunk)
            progress += take
            curr_file_bytes_left -= take

            if (curr_file_bytes_left === 0) {
                const computed_hash = hash.digest("hex")
                const xfile = xfiles[curr_file_idx]!
                if (computed_hash !== xfile.sha256)
                    throw Object.assign(
                        new Error(`Hash mismatch for ${xfile.filename}:\nGOT:      ${computed_hash}\nEXPECTED: ${xfile.sha256}`), { statusCode: 400 })
                files_buffers[curr_file_idx] = Buffer.concat(curr_file_chunks)
                curr_file_idx++
                if (curr_file_idx < xfiles.length) {
                    curr_file_bytes_left = xfiles[curr_file_idx]!.bytes
                    curr_file_chunks = []
                    hash = createHash("sha256")
                }
            }
        }
    }

    if (curr_file_idx !== xfiles.length)
        throw Object.assign(
            new Error(`Stream ended early:` + 
                `received ${curr_file_idx}/${xfiles.length} files`
                + `, ${filesize(total_bytes)}/${filesize(total_declared_bytes)}`),
            { statusCode: 400 })

    return { files_buffers, total_bytes }
}
