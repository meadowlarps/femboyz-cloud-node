import { beforeEach, expect, test, vi } from "vitest"
import type { UploadTokenDB } from "../schema.js"

vi.mock("../database.js", () => ({ getDB: () => { throw new Error("database not expected in unit tests") } }))

const { envs } = await import("../config.js")
const {
    TOKEN_FILES_HARD_CAP,
    token_authlimit,
    token_guess_register,
    token_is_usable,
    token_limits_effective,
    token_limits_info,
    upload_limits_check
} = await import("../tokens.js")

const NOW = Date.parse("2026-09-24T12:00:00.000Z")
const GB = 1024 ** 3

function token_make(overrides: Partial<UploadTokenDB> = {}): UploadTokenDB {
    return {
        id_token: "ABCD1234",
        token: "x".repeat(32),
        label: "friend",
        limits: { max_files: 10, max_bytes: 10 * GB },
        uses_max: 3,
        uses_count: 0,
        expires_at: null,
        revoked: false,
        when: "2026-09-01T00:00:00.000Z",
        ...overrides
    }
}

test("token usability reports why a token can't be used", () => {
    expect(token_is_usable(token_make(), NOW)).toBeNull()
    expect(token_is_usable(token_make({ revoked: true }), NOW)).toBe("revoked")
    expect(token_is_usable(token_make({ expires_at: "2026-09-24T11:59:59.000Z" }), NOW)).toBe("expired")
    expect(token_is_usable(token_make({ expires_at: "2026-09-25T00:00:00.000Z" }), NOW)).toBeNull()
    expect(token_is_usable(token_make({ uses_count: 3 }), NOW)).toBe("exhausted")
    expect(token_is_usable(token_make({ uses_max: null, uses_count: 999 }), NOW)).toBeNull()
})

test("no token falls back to env limits capped by free storage", () => {
    const max_files = envs.MAX_FILE_COUNT_PER_UPLOAD || 6
    const per_file = envs.MAX_FILE_SIZE || Infinity
    expect(token_limits_effective(null, Infinity)).toEqual({
        max_files, max_bytes_per_file: per_file, max_bytes_total: per_file * max_files
    })
    expect(token_limits_effective(null, 5).max_bytes_total).toBe(5)
    expect(token_limits_effective(null, -10).max_bytes_per_file).toBe(0)
})

test("token limits override env, unlimited is capped by hard cap and free storage", () => {
    expect(token_limits_effective(token_make(), 100 * GB))
        .toEqual({ max_files: 10, max_bytes_per_file: 10 * GB, max_bytes_total: 10 * GB })
    expect(token_limits_effective(token_make({ limits: { max_files: null, max_bytes: null } }), 42 * GB))
        .toEqual({ max_files: TOKEN_FILES_HARD_CAP, max_bytes_per_file: 42 * GB, max_bytes_total: 42 * GB })
    expect(token_limits_effective(token_make(), 1 * GB).max_bytes_total).toBe(1 * GB)
})

test("upload limit check enforces count, per-file and total size", () => {
    const limits = { max_files: 2, max_bytes_per_file: 100, max_bytes_total: 150 }
    const file = (bytes: number, filename = "a.bin") => ({ filename, sha256: "0".repeat(64), bytes })

    expect(upload_limits_check([file(100), file(50)], limits)).toBeNull()
    expect(upload_limits_check([file(1), file(1), file(1)], limits)).toMatch(/Too many files/)
    expect(upload_limits_check([file(101, "big.bin")], limits)).toMatch(/big\.bin/)
    expect(upload_limits_check([file(100), file(100)], limits)).toMatch(/total limit/)
})

test("limits info exposes remaining uses and raw nullable limits", () => {
    expect(token_limits_info(token_make({ uses_count: 1 }))).toEqual({
        label: "friend", max_files: 10, max_bytes: 10 * GB, uses_left: 2, expires_at: null
    })
    expect(token_limits_info(token_make({ uses_max: null })).uses_left).toBeNull()
})

test("custom token values must be 8-64 header-safe characters", async () => {
    const { UploadTokenCreateSchema } = await import("../schema.js")
    const create = (token?: string) => UploadTokenCreateSchema.safeParse({
        ...(token === undefined ? {} : { token }),
        limits: { max_files: null, max_bytes: null }
    })

    expect(create().success).toBe(true)
    expect(create("party-2026_token").data?.token).toBe("party-2026_token")
    expect(create("  padded-token  ").data?.token).toBe("padded-token")
    expect(create("short").success).toBe(false)
    expect(create("x".repeat(65)).success).toBe(false)
    expect(create("has space in it").success).toBe(false)
    expect(create("ünïcode-token").success).toBe(false)
})

beforeEach(() => token_authlimit._reset())

test("unknown-token guesses block an ip once the threshold is crossed", () => {
    const issuer = { ip: "6.6.6.6", ua: "bot", uuid: "none" }
    for (let i = 1; i < envs.UPLOAD_TOKEN_MAX_FAILS; i++) {
        token_guess_register(issuer, "unknown", NOW + i)
        expect(token_authlimit.block_remaining_ms("6.6.6.6", NOW + i)).toBe(0)
    }
    token_guess_register(issuer, "unknown", NOW + 100)
    expect(token_authlimit.block_remaining_ms("6.6.6.6", NOW + 100)).toBe(envs.UPLOAD_TOKEN_BLOCK_MINUTES * 60_000)
    expect(token_authlimit.block_remaining_ms("7.7.7.7", NOW + 100)).toBe(0)
})

test("real but unusable tokens never count as guesses", () => {
    const issuer = { ip: "8.8.8.8", ua: "friend", uuid: "none" }
    for (let i = 0; i < envs.UPLOAD_TOKEN_MAX_FAILS * 2; i++) {
        token_guess_register(issuer, "revoked", NOW)
        token_guess_register(issuer, "expired", NOW)
        token_guess_register(issuer, "exhausted", NOW)
    }
    expect(token_authlimit.block_remaining_ms("8.8.8.8", NOW)).toBe(0)
})
