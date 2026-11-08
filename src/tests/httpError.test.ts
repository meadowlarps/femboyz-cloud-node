import { expect, test } from "vitest"
import type { FastifyError } from "fastify"
import * as z from "zod"
import { clientStatus, httpError, issueMessage, publicErrorMessage } from "../httpError.js"

test("httpError keeps the detail in the log message only", () => {
    const err = httpError(400, "Invalid file index.", "fid=-1")
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe("Invalid file index.: fid=-1")
    expect(publicErrorMessage(err, 400)).toBe("Invalid file index.")
})

test("5xx internals never reach the client", () => {
    const err = Object.assign(new Error("Corrupt upload document"), { statusCode: 500 })
    expect(publicErrorMessage(err, 500)).toBe("Server error.")
})

test("Fastify validation and body errors become sentences", () => {
    const missingMeta = Object.assign(new Error("headers must have required property 'x-meta'"), {
        statusCode: 400, validationContext: "headers",
        validation: [{ keyword: "required", instancePath: "", params: { missingProperty: "x-meta" } }]
    }) as unknown as FastifyError
    expect(publicErrorMessage(missingMeta, 400)).toBe("Missing X-Meta header.")

    const badLink = Object.assign(new Error("body/link must match format \"uri\""), {
        statusCode: 400, validationContext: "body",
        validation: [{ keyword: "format", instancePath: "/link", params: {} }]
    }) as unknown as FastifyError
    expect(publicErrorMessage(badLink, 400)).toMatch(/Invalid link/)

    const tooLarge = Object.assign(new Error("Request body is too large"), { statusCode: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE" }) as FastifyError
    expect(publicErrorMessage(tooLarge, 413)).toBe("Request too large.")
})

test("issueMessage names the field and its limit", () => {
    const schema = z.object({ meta: z.object({ title: z.string().max(5) }), text: z.string().refine(t => t.trim() !== "", "Note is empty") })
    const long = schema.safeParse({ meta: { title: "too long" }, text: "x" })
    expect(issueMessage(long.error!.issues, { "meta.title": "Title" }, "fallback")).toBe("Title too long (max 5).")
    const empty = schema.safeParse({ meta: { title: "" }, text: " " })
    expect(issueMessage(empty.error!.issues, {}, "fallback")).toBe("Note is empty.")
    const unknown = schema.safeParse({ meta: {}, text: "x" })
    expect(issueMessage(unknown.error!.issues, {}, "fallback")).toBe("fallback")
})

test("clientStatus keeps 4xx and narrows 5xx", () => {
    expect(clientStatus(401)).toBe(401)
    expect(clientStatus(413)).toBe(413)
    expect(clientStatus(507)).toBe(507)
    expect(clientStatus(504)).toBe(500)
})
