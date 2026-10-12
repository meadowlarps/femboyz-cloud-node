import { createHash, randomUUID } from "node:crypto"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import type { XMetaFiles } from "./schema.js"
import { filesize } from "filesize"

// enough for libmagic to identify nearly every format
export const HEAD_BYTES = 64 * 1024

export type ReceivedFile = { tmp_path: string, head: Buffer }

// Splits the concatenated body into one temp file per declared file, hashing as it writes.
// Only the current socket chunk and a HEAD_BYTES sample per file stay in memory.
export async function parseUploadStream(
    stream: AsyncIterable<unknown>,
    xmeta: XMetaFiles,
    tmp_dir: string
): Promise<{ files: ReceivedFile[], total_bytes: number }> {
    const xfiles = xmeta.files
    const total_declared_bytes = xfiles.reduce((a, f) => a + f.bytes, 0)
    const files: ReceivedFile[] = []
    const created: string[] = []
    let curr_file_idx = 0
    let curr_file_bytes_left = 0
    let curr_head: Buffer[] = []
    let curr_head_bytes = 0
    let curr_path = ""
    let fh: FileHandle | null = null
    let hash = createHash("sha256")
    let total_bytes = 0

    const openNext = async () => {
        curr_file_bytes_left = xfiles[curr_file_idx]!.bytes
        curr_head = []
        curr_head_bytes = 0
        hash = createHash("sha256")
        curr_path = path.join(tmp_dir, `${randomUUID()}.part`)
        created.push(curr_path)
        fh = await fs.open(curr_path, "wx")
    }

    // closes + verifies every file whose bytes are all in, opening the next; loops so 0-byte files don't stall
    const finishCompleted = async () => {
        while (curr_file_idx < xfiles.length && curr_file_bytes_left === 0) {
            await fh!.close()
            fh = null
            const computed_hash = hash.digest("hex")
            const xfile = xfiles[curr_file_idx]!
            if (computed_hash !== xfile.sha256)
                throw Object.assign(
                    new Error(`Hash mismatch for ${xfile.filename}:\nGOT:      ${computed_hash}\nEXPECTED: ${xfile.sha256}`), { statusCode: 400 })
            files.push({ tmp_path: curr_path, head: Buffer.concat(curr_head) })
            curr_file_idx++
            if (curr_file_idx < xfiles.length) await openNext()
        }
    }

    try {
        await openNext()
        await finishCompleted()

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
                await fh!.write(chunk)
                if (curr_head_bytes < HEAD_BYTES) {
                    const head_part = chunk.subarray(0, HEAD_BYTES - curr_head_bytes)
                    curr_head.push(Buffer.from(head_part))   // copy, so the socket buffer can be freed
                    curr_head_bytes += head_part.length
                }
                progress += take
                curr_file_bytes_left -= take
                await finishCompleted()
            }
        }

        if (curr_file_idx !== xfiles.length)
            throw Object.assign(
                new Error(`Stream ended early:` +
                    `received ${curr_file_idx}/${xfiles.length} files`
                    + `, ${filesize(total_bytes)}/${filesize(total_declared_bytes)}`),
                { statusCode: 400 })
    } catch (err) {
        await (fh as FileHandle | null)?.close().catch(() => {})
        await Promise.all(created.map(p => fs.rm(p, { force: true }).catch(() => {})))
        throw err
    }

    return { files, total_bytes }
}
