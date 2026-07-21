import { describe, expect, test } from "vitest"
import { validateHeaderValue } from "node:http"
import { inlineContentDisposition } from "../httpHeaders.js"

describe("inlineContentDisposition", () => {
    test("formats an ASCII filename", () => {
        expect(inlineContentDisposition("video.mp4"))
            .toBe("inline; filename=\"video.mp4\"; filename*=UTF-8''video.mp4")
    })

    test("keeps Unicode out of the raw header and encodes it as UTF-8", () => {
        expect(inlineContentDisposition("résumé 🎬.mp4"))
            .toBe("inline; filename=\"r_sum_ _.mp4\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%F0%9F%8E%AC.mp4")
    })

    test("neutralizes control characters and path separators", () => {
        const value = inlineContentDisposition("clips\\bad\r\nInjected: yes.mp4")

        expect(value).toBe("inline; filename=\"clips_bad__Injected: yes.mp4\"; filename*=UTF-8''clips_bad__Injected%3A%20yes.mp4")
        expect(value).not.toMatch(/[\r\n]/)
    })

    test("escapes quotes in the fallback filename", () => {
        expect(inlineContentDisposition('my "video".mp4'))
            .toBe("inline; filename=\"my \\\"video\\\".mp4\"; filename*=UTF-8''my%20%22video%22.mp4")
    })

    test("always produces a value accepted by Node's HTTP implementation", () => {
        const problematicNames = ["line\nbreak.mp4", "фильм.mp4", "emoji-🎬.mp4", "broken-\ud800.mp4"]

        for (const filename of problematicNames) {
            expect(() => validateHeaderValue("Content-Disposition", inlineContentDisposition(filename))).not.toThrow()
        }
    })
})
