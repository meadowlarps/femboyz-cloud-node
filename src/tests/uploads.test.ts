import { test, assert } from "vitest"
import { idGen, notePreview, NOTE_PREVIEW_LENGTH, typeClassify } from "../uploads.js"
import { NoteUploadSchema } from "../schema.js"

test("ID Gen Collisions and Performance", () => {
    const tryCount = 100000
    const ids = new Set<string>()
    const t0 = performance.now()
    for (let index = 0; index < tryCount; index++) {
        ids.add(idGen())
    }
    const elapsed = performance.now() - t0

    const collisionRateCriteria = 0.01
    const collisionRate = (tryCount - ids.size) / tryCount * 100
    if (collisionRate > 0.0) {
        console.warn(`Collision rate ${collisionRate}%`)
    } else {
        console.log(`Collision rate ${collisionRate}%`)
    }
    console.log(`idGen: ${tryCount} ids in ${elapsed.toFixed(2)}ms (${(elapsed / tryCount * 1000).toFixed(2)}µs/id)`)
    assert.isAtMost(collisionRate, collisionRateCriteria)
})

test("ID Gen Format", () => {
    const format = /^\d{3}[0-9A-Z][A-Z]{4}$/
    const tryCount = 1000
    
    for (let i = 0; i < tryCount; i++) {
        const id = idGen()
        assert.match(id, format, `Try nr ${tryCount}, RegEx Mismatch: ${id}`)
    }
})


test("Type Classifier Upload Classification", () => {
    assert.equal(typeClassify(["image/png"]), "album")
    assert.equal(typeClassify(["image/png", "image/jpeg"]), "album")
    assert.equal(typeClassify(["video/mp4", "video/webm"]), "album")
    assert.equal(typeClassify(["image/png", "video/mp4"]), "album")
    assert.equal(typeClassify(["image/gif", "video/webm"]), "album")
    assert.equal(typeClassify(["audio/mpeg", "audio/wav"]), "playlist")
    assert.equal(typeClassify(["application/pdf", "text/plain"]), "files")
    assert.equal(typeClassify(["image/png", "audio/mpeg"]), "files")
    assert.equal(typeClassify(["image/png", "video/mp4", "audio/mpeg"]), "files")
    assert.equal(typeClassify([]), "files")
})

test("notePreview keeps short notes whole and cuts long ones", () => {
    assert.equal(notePreview("hello"), "hello")
    assert.equal(notePreview("a".repeat(NOTE_PREVIEW_LENGTH + 50)).length, NOTE_PREVIEW_LENGTH)
})

test("notePreview never splits a surrogate pair", () => {
    const text = "a".repeat(NOTE_PREVIEW_LENGTH - 1) + "😀" + "tail"
    const preview = notePreview(text)
    assert.equal(preview, "a".repeat(NOTE_PREVIEW_LENGTH - 1))
})

test("NoteUploadSchema fills defaults and rejects blank or oversized notes", () => {
    const parsed = NoteUploadSchema.parse({ type: "note", text: "  hi\n" })
    assert.deepEqual(parsed, { type: "note", is_public: false, meta: { title: "" }, text: "  hi\n" })

    assert.isFalse(NoteUploadSchema.safeParse({ type: "note", text: " \n\t" }).success)
    assert.isTrue(NoteUploadSchema.safeParse({ type: "note", text: "x".repeat(100_000) }).success)
    assert.isFalse(NoteUploadSchema.safeParse({ type: "note", text: "x".repeat(100_001) }).success)
})
