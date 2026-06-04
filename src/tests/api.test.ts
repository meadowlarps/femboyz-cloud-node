import { test, expect } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import { parseUploadStream } from "../stream.js"
import type { XMetaFiles } from "../schema.js"

// ---- helpers ----

function sha256(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex")
}

function makeXMeta(files: Array<{ filename: string; data: Buffer }>): XMetaFiles {
    return {
        type: "files",
        is_public: false,
        meta: { title: "test", desc: "" },
        files: files.map(f => ({ filename: f.filename, sha256: sha256(f.data), bytes: f.data.length }))
    }
}

// deliver buffer as N-byte network chunks
function chunked(data: Buffer, size: number): Readable {
    const parts: Buffer[] = []
    for (let i = 0; i < data.length; i += size)
        parts.push(data.subarray(i, i + size))
    return Readable.from(parts)
}

function stream(...bufs: Buffer[]): Readable {
    return Readable.from(bufs)
}

// ---- happy path ----

test("single file: one chunk", async () => {
    const data = Buffer.from("hello world")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    const { files_buffers, total_bytes } = await parseUploadStream(stream(data), xmeta)
    expect(files_buffers[0]).toEqual(data)
    expect(total_bytes).toBe(data.length)
})

test("two files: each delivered as one chunk", async () => {
    const a = Buffer.from("file-one-data")
    const b = Buffer.from("file-two-data-longer")
    const xmeta = makeXMeta([{ filename: "a.bin", data: a }, { filename: "b.bin", data: b }])
    const body = Buffer.concat([a, b])
    const { files_buffers, total_bytes } = await parseUploadStream(stream(body), xmeta)
    expect(files_buffers[0]).toEqual(a)
    expect(files_buffers[1]).toEqual(b)
    expect(total_bytes).toBe(a.length + b.length)
})

test("two files: chunk boundary falls inside first file", async () => {
    const a = Buffer.allocUnsafe(100).fill(0xaa)
    const b = Buffer.allocUnsafe(100).fill(0xbb)
    const xmeta = makeXMeta([{ filename: "a.bin", data: a }, { filename: "b.bin", data: b }])
    const body = Buffer.concat([a, b])
    // chunks of 64 bytes — boundary at 64 splits file a (100 bytes) mid-way
    const { files_buffers } = await parseUploadStream(chunked(body, 64), xmeta)
    expect(files_buffers[0]).toEqual(a)
    expect(files_buffers[1]).toEqual(b)
})

test("three files: 1-byte network chunks (maximum boundary stress)", async () => {
    const a = Buffer.from("aaaa")
    const b = Buffer.from("bbbbbb")
    const c = Buffer.from("cc")
    const xmeta = makeXMeta([
        { filename: "a.txt", data: a },
        { filename: "b.txt", data: b },
        { filename: "c.txt", data: c }
    ])
    const body = Buffer.concat([a, b, c])
    const { files_buffers } = await parseUploadStream(chunked(body, 1), xmeta)
    expect(files_buffers[0]).toEqual(a)
    expect(files_buffers[1]).toEqual(b)
    expect(files_buffers[2]).toEqual(c)
})

test("large random file: integrity preserved across chunked delivery", async () => {
    const data = randomBytes(512 * 1024)
    const xmeta = makeXMeta([{ filename: "big.bin", data }])
    const { files_buffers } = await parseUploadStream(chunked(data, 4096), xmeta)
    expect(sha256(files_buffers[0]!)).toBe(sha256(data))
})

// ---- hash manipulation ----

test("hash mismatch on first (only) file → 400", async () => {
    const data = Buffer.from("real data")
    const tampered = makeXMeta([{ filename: "a.txt", data }])
    tampered.files[0]!.sha256 = sha256(Buffer.from("different data"))
    await expect(parseUploadStream(stream(data), tampered))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Hash mismatch") })
})

test("hash mismatch on second file, first file valid → 400", async () => {
    const a = Buffer.from("good file")
    const b = Buffer.from("also good")
    const xmeta = makeXMeta([{ filename: "a.txt", data: a }, { filename: "b.txt", data: b }])
    xmeta.files[1]!.sha256 = sha256(Buffer.from("wrong"))
    const body = Buffer.concat([a, b])
    await expect(parseUploadStream(stream(body), xmeta))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Hash mismatch for b.txt") })
})

test("correct hash but bytes field understates file size → hash mismatch (bytes field tampered)", async () => {
    const data = Buffer.from("hello world")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    // claim only first 5 bytes, but sha256 is still for full data
    xmeta.files[0]!.bytes = 5
    // stream delivers full data — after 5 bytes, hash won't match, then "stream too long"
    await expect(parseUploadStream(stream(data), xmeta))
        .rejects.toMatchObject({ statusCode: 400 })
})

// ---- length mismatches ----

test("empty stream when files expected → 400 stream ended early", async () => {
    const data = Buffer.from("some content")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    await expect(parseUploadStream(Readable.from([]), xmeta))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Stream ended early") })
})

test("stream ends mid-file (partial body) → 400 stream ended early", async () => {
    const data = Buffer.allocUnsafe(200).fill(0x42)
    const xmeta = makeXMeta([{ filename: "a.bin", data }])
    // only send first 100 bytes
    await expect(parseUploadStream(stream(data.subarray(0, 100)), xmeta))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Stream ended early") })
})

test("stream too long: extra bytes after all declared files → 400", async () => {
    const data = Buffer.from("exact content")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    const extra = Buffer.concat([data, Buffer.from(" extra")])
    await expect(parseUploadStream(stream(extra), xmeta))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Stream too long") })
})

test("stream too long: extra chunk arrives after all files complete → 400", async () => {
    const a = Buffer.from("file one")
    const b = Buffer.from("file two")
    const xmeta = makeXMeta([{ filename: "a.txt", data: a }, { filename: "b.txt", data: b }])
    // deliver correct body, then send a third rogue chunk
    const rogue = Buffer.from("injected")
    await expect(parseUploadStream(stream(Buffer.concat([a, b]), rogue), xmeta))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Stream too long") })
})

test("xmeta declares more bytes than stream contains → 400 stream ended early", async () => {
    const data = Buffer.from("short")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    xmeta.files[0]!.bytes = 9999  // lie about size
    await expect(parseUploadStream(stream(data), xmeta))
        .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Stream ended early") })
})
