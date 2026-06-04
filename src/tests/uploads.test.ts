import { test, assert } from "vitest"
import { idGen } from "../uploads.js"
import { typeClassify } from "../uploads.js"
    

test("ID Gen", () => {
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
    assert.isBoolean(collisionRate > collisionRateCriteria, `Collision rate exceeds ${collisionRateCriteria}%: ${collisionRate}%`)
})


test("Type classifier should classify correctly", () => {
    assert.equal(typeClassify(["image/png", "image/jpeg"]), "album")
    assert.equal(typeClassify(["video/mp4", "video/webm"]), "album")
    assert.equal(typeClassify(["audio/mpeg", "audio/wav"]), "playlist")
    assert.equal(typeClassify(["application/pdf", "text/plain"]), "files")
    assert.equal(typeClassify(["image/png", "audio/mpeg"]), "files")
})