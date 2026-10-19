import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto"
import { envs } from "./config.js"
import { getDB } from "./database.js"
import { scope } from "./logger.js"
import { mail_email_code, mail_send } from "./mailer.js"
import { account_lock } from "./accountLock.js"

const scopelog = scope("emailcodes")

// A 4-digit code has 10,000 values, so these limits do the security work (MAIL_PLAN.md 2.1).
export const CODE_COOLDOWN_MS = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const PER_SUBJECT_HOUR = 5
const PER_SUBJECT_DAY = 10
const PER_ADDRESS_DAY = 5

/** `user:<id_user>` for account changes, `invite:<id>` during signup. */
export type CodeSubject = `user:${string}` | `invite:${string}`

export type EmailCodeDB = {
    id: string
    subject: CodeSubject
    address: string
    address_key: string
    code_hmac: string
    attempts: number
    created: Date
    expires: Date
    purge_at: Date
    used: boolean
}

export type CodeSendResult =
    | { ok: true, cooldown_s: number }
    | { ok: false, reason: "cooldown" | "limit", retry_after_s: number }

export type CodeCheckResult = { ok: true, id: string } | { ok: false, reason: "invalid" | "expired" | "burned" }

function codes_collection() {
    return getDB().collection<EmailCodeDB>(envs.MDB_COLLECTION_EMAIL_CODES)
}

// The subject and address are part of the MAC, so a code only ever proves that one pairing.
export function code_hmac(code: string, address_key: string, subject: CodeSubject): string {
    if (!envs.EMAIL_CODE_SECRET) throw Object.assign(new Error("EMAIL_CODE_SECRET is not configured"), { statusCode: 503 })
    return createHmac("sha256", envs.EMAIL_CODE_SECRET).update(`${code}\n${address_key}\n${subject}`).digest("hex")
}

export function code_generate(): string {
    return String(randomInt(0, 10_000)).padStart(4, "0")
}

function hmac_equal(a: string, b: string): boolean {
    const left = Buffer.from(a, "hex")
    const right = Buffer.from(b, "hex")
    return left.length === right.length && timingSafeEqual(left, right)
}

function retry_after(oldest: Date | undefined, window_ms: number, now: number): number {
    return Math.max(1, Math.ceil(((oldest?.getTime() ?? now) + window_ms - now) / 1000))
}

/**
 * Sends a fresh code to `address` for `subject`, invalidating earlier ones. Enforces the
 * cooldown and the per-subject and per-address limits; per-IP limits live in the routes.
 */
export async function code_send(subject: CodeSubject, address: string, address_key: string, now = Date.now()): Promise<CodeSendResult> {
    return account_lock([`code-subject:${subject}`, `code-address:${address_key}`], () => code_send_locked(subject, address, address_key, now))
}

async function code_send_locked(subject: CodeSubject, address: string, address_key: string, now: number): Promise<CodeSendResult> {
    const collection = codes_collection()
    const recent = await collection
        .find({ subject, created: { $gt: new Date(now - DAY) } }, { projection: { created: 1 } })
        .sort({ created: -1 })
        .toArray()

    const latest = recent[0]?.created
    if (latest && latest.getTime() + CODE_COOLDOWN_MS > now)
        return { ok: false, reason: "cooldown", retry_after_s: retry_after(latest, CODE_COOLDOWN_MS, now) }
    const last_hour = recent.filter(item => item.created.getTime() > now - HOUR)
    if (last_hour.length >= PER_SUBJECT_HOUR)
        return { ok: false, reason: "limit", retry_after_s: retry_after(last_hour.at(-1)?.created, HOUR, now) }
    if (recent.length >= PER_SUBJECT_DAY)
        return { ok: false, reason: "limit", retry_after_s: retry_after(recent.at(-1)?.created, DAY, now) }

    const to_address = await collection
        .find({ address_key, created: { $gt: new Date(now - DAY) } }, { projection: { created: 1 } })
        .sort({ created: 1 })
        .toArray()
    if (to_address.length >= PER_ADDRESS_DAY)
        return { ok: false, reason: "limit", retry_after_s: retry_after(to_address[0]?.created, DAY, now) }

    const code = code_generate()
    await collection.updateMany({ subject, used: false }, { $set: { used: true } })
    await collection.insertOne({
        id: randomUUID(),
        subject,
        address,
        address_key,
        code_hmac: code_hmac(code, address_key, subject),
        attempts: 0,
        created: new Date(now),
        expires: new Date(now + envs.EMAIL_CODE_TTL_MINUTES * 60_000),
        purge_at: new Date(now + envs.EMAIL_CODE_TTL_MINUTES * 60_000 + DAY),
        used: false
    })
    scopelog.info(`Code sent for ${subject}`)
    await mail_send(mail_email_code(address, code))
    return { ok: true, cooldown_s: CODE_COOLDOWN_MS / 1000 }
}

/**
 * Atomically reserves an attempt before comparing, then consumes a matching code before
 * returning success. Parallel guesses cannot bypass the budget or reuse a match.
 */
export async function code_check(subject: CodeSubject, address_key: string, code: string, now = Date.now()): Promise<CodeCheckResult> {
    const collection = codes_collection()
    const live = await collection.findOne({ subject, address_key, used: false }, { sort: { created: -1 } })
    if (!live) return { ok: false, reason: "invalid" }
    if (live.expires.getTime() <= now) return { ok: false, reason: "expired" }
    if (live.attempts >= envs.EMAIL_CODE_MAX_ATTEMPTS) return { ok: false, reason: "burned" }

    const spent = await collection.findOneAndUpdate(
        { id: live.id, used: false, expires: { $gt: new Date(now) }, attempts: { $lt: envs.EMAIL_CODE_MAX_ATTEMPTS } },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" })
    if (!spent) return { ok: false, reason: "burned" }
    if (/^\d{4}$/.test(code) && hmac_equal(code_hmac(code, address_key, subject), spent.code_hmac)) {
        const claimed = await collection.updateOne({ id: spent.id, used: false }, { $set: { used: true } })
        return claimed.modifiedCount === 1 ? { ok: true, id: spent.id } : { ok: false, reason: "invalid" }
    }
    if (spent.attempts >= envs.EMAIL_CODE_MAX_ATTEMPTS) {
        await collection.updateOne({ id: live.id }, { $set: { used: true } })
        return { ok: false, reason: "burned" }
    }
    return { ok: false, reason: "invalid" }
}
