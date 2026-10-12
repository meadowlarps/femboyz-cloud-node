import { test, expect, beforeEach, afterEach } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HEAD_BYTES, parseUploadStream, type ReceivedFile } from "../stream.js"
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

let tmp = ""
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "udstream-")) })
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

function parse(body: Readable, xmeta: XMetaFiles) {
    return parseUploadStream(body, xmeta, tmp)
}

// reads back what was written to disk, and checks the MIME sample is the file's start
async function contents(files: ReceivedFile[], i: number): Promise<Buffer> {
    const file = files[i]!
    const data = await fs.readFile(file.tmp_path)
    expect(file.head).toEqual(data.subarray(0, HEAD_BYTES))
    return data
}

// a rejected upload must not leave partial temp files behind
async function expectRejectsClean(promise: Promise<unknown>, match: object) {
    await expect(promise).rejects.toMatchObject(match)
    expect(await fs.readdir(tmp)).toEqual([])
}

// ---- happy path ----

test("single file: one chunk", async () => {
    const data = Buffer.from("hello world")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    const { files, total_bytes } = await parse(stream(data), xmeta)
    expect(await contents(files, 0)).toEqual(data)
    expect(total_bytes).toBe(data.length)
})

test("two files: each delivered as one chunk", async () => {
    const a = Buffer.from("file-one-data")
    const b = Buffer.from("file-two-data-longer")
    const xmeta = makeXMeta([{ filename: "a.bin", data: a }, { filename: "b.bin", data: b }])
    const body = Buffer.concat([a, b])
    const { files, total_bytes } = await parse(stream(body), xmeta)
    expect(await contents(files, 0)).toEqual(a)
    expect(await contents(files, 1)).toEqual(b)
    expect(total_bytes).toBe(a.length + b.length)
})

test("two files: chunk boundary falls inside first file", async () => {
    const a = Buffer.allocUnsafe(100).fill(0xaa)
    const b = Buffer.allocUnsafe(100).fill(0xbb)
    const xmeta = makeXMeta([{ filename: "a.bin", data: a }, { filename: "b.bin", data: b }])
    const body = Buffer.concat([a, b])
    // chunks of 64 bytes — boundary at 64 splits file a (100 bytes) mid-way
    const { files } = await parse(chunked(body, 64), xmeta)
    expect(await contents(files, 0)).toEqual(a)
    expect(await contents(files, 1)).toEqual(b)
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
    const { files } = await parse(chunked(body, 1), xmeta)
    expect(await contents(files, 0)).toEqual(a)
    expect(await contents(files, 1)).toEqual(b)
    expect(await contents(files, 2)).toEqual(c)
})

test("large random file: integrity preserved across chunked delivery", async () => {
    const data = randomBytes(512 * 1024)
    const xmeta = makeXMeta([{ filename: "big.bin", data }])
    const { files } = await parse(chunked(data, 4096), xmeta)
    expect(sha256(await contents(files, 0))).toBe(sha256(data))
})

test("5 MB file in 64 KB chunks: written to disk intact, head capped at HEAD_BYTES", async () => {
    const data = randomBytes(5 * 1024 * 1024)
    const xmeta = makeXMeta([{ filename: "huge.bin", data }])
    const { files } = await parse(chunked(data, 64 * 1024 + 7), xmeta)
    expect(files[0]!.head.length).toBe(HEAD_BYTES)
    expect(sha256(await contents(files, 0))).toBe(sha256(data))
})

test("zero-byte file between two files is written empty instead of stalling", async () => {
    const a = Buffer.from("before")
    const empty = Buffer.alloc(0)
    const c = Buffer.from("after")
    const xmeta = makeXMeta([
        { filename: "a.txt", data: a },
        { filename: "empty.txt", data: empty },
        { filename: "c.txt", data: c }
    ])
    const { files } = await parse(stream(Buffer.concat([a, c])), xmeta)
    expect(await contents(files, 0)).toEqual(a)
    expect(await contents(files, 1)).toEqual(empty)
    expect(await contents(files, 2)).toEqual(c)
})

test("stream error mid-upload (client abort) → partial temp files removed", async () => {
    const a = Buffer.from("complete first file")
    const b = Buffer.allocUnsafe(1000).fill(0x11)
    const xmeta = makeXMeta([{ filename: "a.txt", data: a }, { filename: "b.bin", data: b }])
    async function* aborted() {
        yield a
        yield b.subarray(0, 300)
        throw Object.assign(new Error("aborted"), { code: "ECONNRESET" })
    }
    await expectRejectsClean(parseUploadStream(aborted(), xmeta, tmp), { message: "aborted" })
})

// ---- hash manipulation ----

test("hash mismatch on first (only) file → 400", async () => {
    const data = Buffer.from("real data")
    const tampered = makeXMeta([{ filename: "a.txt", data }])
    tampered.files[0]!.sha256 = sha256(Buffer.from("different data"))
    await expectRejectsClean(parse(stream(data), tampered), { statusCode: 400, message: expect.stringContaining("Hash mismatch") })
})

test("hash mismatch on second file, first file valid → 400", async () => {
    const a = Buffer.from("good file")
    const b = Buffer.from("also good")
    const xmeta = makeXMeta([{ filename: "a.txt", data: a }, { filename: "b.txt", data: b }])
    xmeta.files[1]!.sha256 = sha256(Buffer.from("wrong"))
    const body = Buffer.concat([a, b])
    await expectRejectsClean(parse(stream(body), xmeta), { statusCode: 400, message: expect.stringContaining("Hash mismatch for b.txt") })
})

test("correct hash but bytes field understates file size → hash mismatch (bytes field tampered)", async () => {
    const data = Buffer.from("hello world")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    // claim only first 5 bytes, but sha256 is still for full data
    xmeta.files[0]!.bytes = 5
    // stream delivers full data — after 5 bytes, hash won't match, then "stream too long"
    await expectRejectsClean(parse(stream(data), xmeta), { statusCode: 400 })
})

// ---- length mismatches ----

test("empty stream when files expected → 400 stream ended early", async () => {
    const data = Buffer.from("some content")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    await expectRejectsClean(parse(Readable.from([]), xmeta), { statusCode: 400, message: expect.stringContaining("Stream ended early") })
})

test("stream ends mid-file (partial body) → 400 stream ended early", async () => {
    const data = Buffer.allocUnsafe(200).fill(0x42)
    const xmeta = makeXMeta([{ filename: "a.bin", data }])
    // only send first 100 bytes
    await expectRejectsClean(parse(stream(data.subarray(0, 100)), xmeta), { statusCode: 400, message: expect.stringContaining("Stream ended early") })
})

test("stream too long: extra bytes after all declared files → 400", async () => {
    const data = Buffer.from("exact content")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    const extra = Buffer.concat([data, Buffer.from(" extra")])
    await expectRejectsClean(parse(stream(extra), xmeta), { statusCode: 400, message: expect.stringContaining("Stream too long") })
})

test("stream too long: extra chunk arrives after all files complete → 400", async () => {
    const a = Buffer.from("file one")
    const b = Buffer.from("file two")
    const xmeta = makeXMeta([{ filename: "a.txt", data: a }, { filename: "b.txt", data: b }])
    // deliver correct body, then send a third rogue chunk
    const rogue = Buffer.from("injected")
    await expectRejectsClean(parse(stream(Buffer.concat([a, b]), rogue), xmeta), { statusCode: 400, message: expect.stringContaining("Stream too long") })
})

test("xmeta declares more bytes than stream contains → 400 stream ended early", async () => {
    const data = Buffer.from("short")
    const xmeta = makeXMeta([{ filename: "a.txt", data }])
    xmeta.files[0]!.bytes = 9999  // lie about size
    await expectRejectsClean(parse(stream(data), xmeta), { statusCode: 400, message: expect.stringContaining("Stream ended early") })
})
