import { test, assert } from "vitest"
import { idGen } from "../uploads.js"
import { typeClassify } from "../uploads.js"
    

test("ID Gen should look as intended and have enough entropy", () => {
    const tryCount = 100000
    const ids = new Set<string>()
    for (let index = 0; index < tryCount; index++) {
        ids.add(idGen())
    }

    console.log("Generated IDs:", ids)
    assert.equal(ids.size, tryCount, `ID generator has collisions. Collision rate: ${(tryCount - ids.size) / tryCount * 100}%`)
})

test("Type classifier should classify correctly", () => {
    assert.equal(typeClassify(["image/png", "image/jpeg"]), "album")
    assert.equal(typeClassify(["video/mp4", "video/webm"]), "album")
    assert.equal(typeClassify(["audio/mpeg", "audio/wav"]), "playlist")
    assert.equal(typeClassify(["application/pdf", "text/plain"]), "files")
    assert.equal(typeClassify(["image/png", "audio/mpeg"]), "files")
})