import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { hash as argon2_hash, verify as argon2_verify } from "@node-rs/argon2"
import { envs, MAIL_ACCESS_TOKEN_TTL_SECONDS, site_origin } from "./config.js"
import { getDB } from "./database.js"
import { errorFileLogger, scope } from "./logger.js"
import { code_check, code_send, type CodeSendResult, type CodeSubject } from "./emailcodes.js"
import {
    mail_external_email_changed,
    mail_invite,
    mail_redirect_disabled,
    mail_request_notification,
    mail_send
} from "./mailer.js"
import {
    sieve_redirect_script,
    stalwart_account_create,
    stalwart_account_destroy,
    stalwart_account_update,
    stalwart_account_usage,
    stalwart_new_senders_change,
    stalwart_new_senders_get,
    stalwart_redirect_apply,
    stalwart_signature_default
} from "./stalwart.js"
import {
    AccountRequestSchemaDB,
    InviteSchemaDB,
    UserSchemaDB,
    type AccountRequestDB,
    type ExternalEmail,
    type InviteDB,
    type UserDB
} from "./schema.js"

import { account_lock } from "./accountLock.js"

const scopelog = scope("accounts")

/** A failure the client is told about by `code`; the account routes send it as `{ error: code }`. */
export class AccountError extends Error {
    constructor(public statusCode: number, public code: string, public extra: Record<string, unknown> = {}) {
        super(code)
    }
}

const INVITE_RESERVE_MS = 2 * 60_000

// ---- USERNAMES ----

const USERNAME_REGEX = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/

// Stalwart creates an account on first OIDC login (just-in-time), and a token for `admin`
// would map onto the internal admin mailbox. Every internal account and alias must be here.
const RESERVED_USERNAMES = new Set([
    // Stalwart internal accounts and aliases (DEPLOYMENT.md 13.7)
    "admin", "noreply", "femboyz-api", "postmaster", "abuse", "dmarc", "hostmaster", "webmaster",
    // RFC 2142 and common system names
    "administrator", "root", "no-reply", "mailer-daemon", "daemon", "security", "support", "info",
    "sales", "marketing", "billing", "noc", "usenet", "news", "uucp", "ftp", "www", "nobody", "system",
    "mail", "mx", "smtp", "imap", "pop", "pop3", "jmap", "dns", "ssl", "tls", "autoconfig", "autodiscover",
    "mta-sts", "dkim", "spf", "bounce", "bounces", "notifications", "notification", "alerts",
    // impersonation
    "femboyz", "staff", "team", "official", "moderator", "mod", "mods", "help", "contact", "owner",
    "account", "accounts", "login", "signup", "register", "verify", "verification", "password", "reset",
    "api", "oidc", "auth", "oauth", "sso", "test", "null", "undefined", "anonymous", "everyone", "all",
    "paypal", "google", "apple", "microsoft", "discord", "steam", "telegram", "twitter", "github"
])
const RESERVED_PREFIXES = ["femboyz", "admin", "postmaster", "noreply", "no-reply", "mailer-daemon", "hostmaster", "webmaster", "abuse"]

export type UsernameProblem = "invalid" | "reserved"

export function username_normalize(value: string): string {
    const trimmed = value.trim().toLowerCase()
    const suffix = `@${envs.MAIL_DOMAIN}`
    return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed
}

export function username_problem(username: string): UsernameProblem | null {
    if (!USERNAME_REGEX.test(username) || username.includes("..")) return "invalid"
    if (RESERVED_USERNAMES.has(username)) return "reserved"
    if (RESERVED_PREFIXES.some(prefix => username.startsWith(prefix))) return "reserved"
    return null
}

// ---- PASSWORDS ----

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 256

// The 10,000 most common passwords of 12+ characters, from SecLists (MIT), lowercased.
let common_passwords: Set<string> | undefined
function common_passwords_get(): Set<string> {
    common_passwords ??= new Set(
        readFileSync(new URL("../data/common-passwords.txt", import.meta.url), "utf8").split("\n").filter(Boolean))
    return common_passwords
}

export type PasswordProblem = "too_short" | "too_long" | "common" | "contains_username"

export function password_problem(password: string, username: string): PasswordProblem | null {
    if ([...password].length < PASSWORD_MIN) return "too_short"
    if (password.length > PASSWORD_MAX) return "too_long"
    const lower = password.toLowerCase()
    if (common_passwords_get().has(lower) || /^(.)\1+$/.test(password)) return "common"
    if (username.length >= 3 && lower.includes(username)) return "contains_username"
    return null
}

export function password_hash(password: string): Promise<string> {
    return argon2_hash(password)                                    // argon2id, 19 MiB, t=2, p=1 (OWASP)
}

// Verified against when the username doesn't exist, so the response time doesn't say so.
let dummy_hash: Promise<string> | undefined

export async function password_verify(hash: string | null, password: string): Promise<boolean> {
    if (hash === null) {
        dummy_hash ??= password_hash(randomBytes(16).toString("hex"))
        await argon2_verify(await dummy_hash, password).catch(() => false)
        return false
    }
    return argon2_verify(hash, password).catch(() => false)
}

// ---- EXTERNAL EMAIL ADDRESSES ----

const ADDRESS_REGEX = /^[^\s@"\\<>()[\],;:]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export type NormalizedAddress = { address: string, key: string }

/** Trims, lowercases the domain, and refuses our own domain. Throws AccountError("invalid_email"). */
export function email_normalize(value: string): NormalizedAddress {
    const trimmed = value.trim()
    const at = trimmed.lastIndexOf("@")
    if (at <= 0) throw new AccountError(400, "invalid_email")
    const domain = trimmed.slice(at + 1).toLowerCase()
    const address = `${trimmed.slice(0, at)}@${domain}`
    if (address.length > 254 || !ADDRESS_REGEX.test(address)) throw new AccountError(400, "invalid_email")
    if (domain === envs.MAIL_DOMAIN || domain.endsWith(`.${envs.MAIL_DOMAIN}`)) throw new AccountError(400, "own_domain")
    return { address, key: address.toLowerCase() }
}

// ---- COLLECTIONS ----

function users() { return getDB().collection<UserDB>(envs.MDB_COLLECTION_USERS) }
function requests() { return getDB().collection<AccountRequestDB>(envs.MDB_COLLECTION_ACCOUNT_REQUESTS) }
function invites() { return getDB().collection<InviteDB>(envs.MDB_COLLECTION_INVITES) }

function parse_or_throw<T>(schema: { safeParse(value: unknown): { success: true, data: T } | { success: false, error: { issues: unknown } } }, document: unknown, what: string): T {
    const result = schema.safeParse(document)
    if (!result.success) {
        scopelog.error(`Invalid ${what} document: ${JSON.stringify(result.error.issues)}`)
        throw Object.assign(new Error(`Corrupt ${what} document`), { statusCode: 500 })
    }
    return result.data
}

const user_parse = (document: unknown) => parse_or_throw<UserDB>(UserSchemaDB, document, "user")
const invite_parse = (document: unknown) => parse_or_throw<InviteDB>(InviteSchemaDB, document, "invite")
const request_parse = (document: unknown) => parse_or_throw<AccountRequestDB>(AccountRequestSchemaDB, document, "account request")

function is_duplicate_key(err: unknown, field?: string): boolean {
    if (typeof err !== "object" || err === null || !("code" in err) || err.code !== 11000) return false
    if (field === undefined) return true
    const pattern = "keyPattern" in err && typeof err.keyPattern === "object" && err.keyPattern !== null ? err.keyPattern : {}
    return field in pattern
}

function short_id(): string {
    return randomBytes(6).toString("base64url")
}

function now_iso(now = Date.now()): string {
    return new Date(now).toISOString()
}

// ---- USERS ----

export async function user_find_by_id(id_user: string): Promise<UserDB | null> {
    const document = await users().findOne({ id_user }, { projection: { _id: 0 } })
    return document ? user_parse(document) : null
}

export async function user_find_by_username(username: string): Promise<UserDB | null> {
    const document = await users().findOne({ username }, { projection: { _id: 0 } })
    return document ? user_parse(document) : null
}

export async function username_taken(username: string): Promise<boolean> {
    return await users().countDocuments({ username }, { limit: 1 }) > 0
}

/** Login check: the active user for these credentials, or null. Constant work either way. */
export async function user_login_verify(username_input: string, password: string): Promise<UserDB | null> {
    const username = username_normalize(username_input)
    const user = username_problem(username) === "invalid" ? null : await user_find_by_username(username)
    const valid = await password_verify(user?.password_hash ?? null, password)
    return valid && user?.status === "active" ? user : null
}

export function user_mail_address(user: Pick<UserDB, "username">): string {
    return `${user.username}@${envs.MAIL_DOMAIN}`
}

// ---- ACCESS REQUESTS ----

export type RequestIssuer = AccountRequestDB["issuer"]

/**
 * Stores a request and notifies the admin. A repeat request from an address that already
 * has one pending is accepted silently, so the form can't be used to flood the admin.
 */
export async function request_create(input: { email: string, note: string }, issuer: RequestIssuer): Promise<void> {
    const { address, key } = email_normalize(input.email)
    if (await requests().countDocuments({ email_key: key, status: "pending" }, { limit: 1 }) > 0) {
        scopelog.info(`Repeat pending request from ${address}, ignored`)
        return
    }
    if (await requests().countDocuments({ status: "pending" }) >= envs.ACCOUNT_REQUESTS_MAX_PENDING)
        throw new AccountError(429, "requests_full")

    const request: AccountRequestDB = {
        id: short_id(),
        email: address,
        email_key: key,
        note: input.note,
        issuer,
        created: now_iso(),
        status: "pending",
        decided: null,
        invite_id: null
    }
    await requests().insertOne({ ...request })
    scopelog.info(`Access request ${request.id} from ${address} (${issuer.ip})`)
    // The request is saved either way; a failed notification only shows up in the error log.
    await mail_send(mail_request_notification(request)).catch(() => {})
}

export async function request_list(status: AccountRequestDB["status"] | "all") {
    const documents = await requests()
        .find(status === "all" ? {} : { status }, { projection: { _id: 0 } })
        .sort({ created: -1 })
        .limit(500)
        .toArray()
    const items = documents.map(request_parse)
    // pending first, then newest
    items.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"))
    return { items }
}

export async function request_approve(id: string) {
    const request = await requests().findOneAndUpdate(
        { id, status: "pending" },
        { $set: { status: "approved", decided: now_iso() } },
        { returnDocument: "after", projection: { _id: 0 } })
    if (!request) {
        const exists = await requests().countDocuments({ id }, { limit: 1 })
        throw new AccountError(exists ? 409 : 404, exists ? "already_decided" : "not_found")
    }
    const { invite, link } = await invite_create({ label: `request ${id}`, email: request.email, request_id: id })
    await requests().updateOne({ id }, { $set: { invite_id: invite.id } })
    const mailed = await mail_send(mail_invite(request.email, link, invite.expires)).then(() => true, () => false)
    scopelog.info(`Admin approved request ${id}; invite ${invite.id} ${mailed ? "emailed" : "NOT emailed"} to ${request.email}`)
    return { request: { ...request_parse(request), invite_id: invite.id }, invite: invite_view(invite), link, mailed }
}

export async function request_reject(id: string) {
    const request = await requests().findOneAndUpdate(
        { id, status: "pending" },
        { $set: { status: "rejected", decided: now_iso() } },
        { returnDocument: "after", projection: { _id: 0 } })
    if (!request) {
        const exists = await requests().countDocuments({ id }, { limit: 1 })
        throw new AccountError(exists ? 409 : 404, exists ? "already_decided" : "not_found")
    }
    scopelog.info(`Admin rejected request ${id}`)
    return request_parse(request)
}

// ---- INVITES ----

export function invite_code_hash(code: string): string {
    return createHash("sha256").update(code).digest("hex")
}

export function invite_link(code: string): string {
    return `${site_origin()}/signup?invite=${encodeURIComponent(code)}`
}

export type InviteStatus = "active" | "used" | "expired" | "revoked"

export function invite_status(invite: InviteDB, now = Date.now()): InviteStatus {
    if (invite.used) return "used"
    if (invite.revoked) return "revoked"
    if (Date.parse(invite.expires) <= now) return "expired"
    return "active"
}

function invite_view(invite: InviteDB) {
    const { code_hash: _, ...rest } = invite
    return { ...rest, status: invite_status(invite) }
}

/** Creates an invite. The code exists only in the returned link; the database keeps its hash. */
export async function invite_create(input: { label?: string, email?: string | null, request_id?: string, quota_bytes?: number, ttl_days?: number }) {
    const email = input.email ? email_normalize(input.email).address : null
    const code = randomBytes(24).toString("base64url")
    const now = Date.now()
    const invite: InviteDB = {
        id: short_id(),
        code_hash: invite_code_hash(code),
        label: input.label ?? "",
        email,
        request_id: input.request_id ?? null,
        quota_bytes: input.quota_bytes ?? envs.MAIL_DEFAULT_QUOTA_BYTES,
        created: now_iso(now),
        expires: now_iso(now + (input.ttl_days ?? envs.INVITE_TTL_DAYS) * 86_400_000),
        reserved_until: null,
        used: false,
        used_by: null,
        used_at: null,
        revoked: false
    }
    await invites().insertOne({ ...invite })
    scopelog.info(`Invite ${invite.id} created (${invite.label || "no label"})`)
    return { invite, link: invite_link(code) }
}

export async function invite_list() {
    const documents = await invites().find({}, { projection: { _id: 0 } }).sort({ created: -1 }).limit(500).toArray()
    return { items: documents.map(document => invite_view(invite_parse(document))) }
}

export async function invite_revoke(id: string): Promise<boolean> {
    const result = await invites().updateOne({ id, used: false }, { $set: { revoked: true } })
    if (result.modifiedCount > 0) scopelog.info(`Admin revoked invite ${id}`)
    return result.modifiedCount > 0
}

/** The usable invite for a code from a link, or null. Doesn't spend it. */
export async function invite_find_usable(code: string, now = Date.now()): Promise<InviteDB | null> {
    if (code.length > 100) return null
    const document = await invites().findOne({ code_hash: invite_code_hash(code) }, { projection: { _id: 0 } })
    if (!document) return null
    const invite = invite_parse(document)
    return invite_status(invite, now) === "active" ? invite : null
}

/** Holds an invite for one signup attempt, so two parallel signups can't both use it. */
async function invite_reserve(code: string, now = Date.now()): Promise<InviteDB | null> {
    const document = await invites().findOneAndUpdate(
        {
            code_hash: invite_code_hash(code),
            used: false,
            revoked: false,
            expires: { $gt: now_iso(now) },
            $or: [{ reserved_until: null }, { reserved_until: { $lte: now_iso(now) } }]
        },
        { $set: { reserved_until: now_iso(now + INVITE_RESERVE_MS) } },
        { returnDocument: "after", projection: { _id: 0 } })
    return document ? invite_parse(document) : null
}

async function invite_release(id: string) {
    await invites().updateOne({ id, used: false }, { $set: { reserved_until: null } })
        .catch(err => errorFileLogger.error({ err }, `Failed to release invite ${id}`))
}

// ---- SIGNUP ----

export type SignupInput = {
    invite: string
    username: string
    password: string
    external_email?: { address: string, code?: string | undefined } | undefined
}

/** True when the invite was sent to this address, which proves the signer owns it. */
function invite_preverifies(invite: InviteDB, key: string): boolean {
    return invite.email !== null && invite.email.toLowerCase() === key
}

async function external_email_free(key: string, except_id_user?: string): Promise<boolean> {
    const filter = except_id_user === undefined
        ? { "external_email.key": key }
        : { "external_email.key": key, id_user: { $ne: except_id_user } }
    return await users().countDocuments(filter, { limit: 1 }) === 0
}

/** Signup step 2: sends a code to an external address, unless the invite already proves it. */
export async function signup_email_code(invite_code: string, address_input: string): Promise<{ verified: true } | CodeSendResult> {
    const invite = await invite_find_usable(invite_code)
    if (!invite) throw new AccountError(404, "invite_invalid")
    const { address, key } = email_normalize(address_input)
    if (invite_preverifies(invite, key)) return { verified: true }
    if (!await external_email_free(key)) throw new AccountError(409, "email_taken")
    return code_send(`invite:${invite.id}`, address, key)
}

export async function signup(input: SignupInput) {
    const username = username_normalize(input.username)
    const problem = username_problem(username)
    if (problem) throw new AccountError(400, `username_${problem}`)
    const weak = password_problem(input.password, username)
    if (weak) throw new AccountError(400, `password_${weak}`)

    const preview = await invite_find_usable(input.invite)
    if (!preview) throw new AccountError(404, "invite_invalid")
    if (await username_taken(username)) throw new AccountError(409, "username_taken")

    let external: ExternalEmail | null = null
    if (input.external_email) {
        const { address, key } = email_normalize(input.external_email.address)
        if (!await external_email_free(key)) throw new AccountError(409, "email_taken")
        if (!invite_preverifies(preview, key)) {
            const checked = await code_check(`invite:${preview.id}`, key, input.external_email.code ?? "")
            if (!checked.ok) throw new AccountError(400, `code_${checked.reason}`)
        }
        external = { address, key, verified_at: now_iso() }
    }

    const password_hash_value = await password_hash(input.password)
    const invite = await invite_reserve(input.invite)
    if (!invite) throw new AccountError(409, "invite_busy")

    const user: UserDB = {
        id_user: randomUUID(),
        username,
        password_hash: password_hash_value,
        external_email: external,
        status: "disabled",
        created: now_iso(),
        invite_id: invite.id,
        services: {
            mail: {
                enabled: true,
                stalwart_id: null,
                quota_bytes: invite.quota_bytes,
                redirect: { enabled: false, keep_copy: true, bounces: 0 }
            }
        }
    }

    try {
        await users().insertOne({ ...user })
    } catch (err) {
        await invite_release(invite.id)
        if (is_duplicate_key(err, "username")) throw new AccountError(409, "username_taken")
        if (is_duplicate_key(err, "external_email.key")) throw new AccountError(409, "email_taken")
        throw err
    }

    try {
        user.services.mail.stalwart_id = await stalwart_account_create({
            username, id_user: user.id_user, quota_bytes: user.services.mail.quota_bytes
        })
        const finalized = await invites().updateOne(
            { id: invite.id, used: false, revoked: false, reserved_until: invite.reserved_until },
            { $set: { used: true, used_by: user.id_user, used_at: now_iso(), reserved_until: null } })
        if (finalized.modifiedCount !== 1) throw new AccountError(409, "invite_invalid")
        await users().updateOne({ id_user: user.id_user }, { $set: { status: "active", "services.mail.stalwart_id": user.services.mail.stalwart_id } })
    } catch (err) {
        // Remove an already-created mailbox before releasing its username and invite.
        if (user.services.mail.stalwart_id) {
            try { await stalwart_account_destroy(user.services.mail.stalwart_id) }
            catch (cleanup) {
                errorFileLogger.error({ err: cleanup }, `Signup mailbox rollback failed for ${username}; keeping the disabled reservation`)
                throw new AccountError(502, "mailbox_failed")
            }
        }
        await invites().updateOne({ id: invite.id, used_by: user.id_user }, {
            $set: { used: false, used_by: null, used_at: null }
        })
        await users().deleteOne({ id_user: user.id_user })
            .catch(cleanup => errorFileLogger.error({ err: cleanup }, `Signup rollback failed for ${username}`))
        await invite_release(invite.id)
        scopelog.error(`Signup of ${username} rolled back: ${err instanceof Error ? err.message : String(err)}`)
        throw new AccountError(502, "mailbox_failed")
    }

    scopelog.info(`Signup: ${username} (${user.id_user}) with invite ${invite.id}${external ? ", external email verified" : ""}`)
    // Until the next periodic sync puts them on the list, the account only has the regular limits.
    void new_senders_sync().catch(err => errorFileLogger.error({ err }, `New-sender sync after signup of ${username} failed`))
    void stalwart_signature_default(user.services.mail.stalwart_id!)
        .catch(err => errorFileLogger.error({ err }, `Default signature for ${username} failed`))
    return { username, email: user_mail_address(user) }
}

// ---- ACCOUNT SETTINGS (/account) ----

export async function me_view(user: UserDB) {
    const mail = user.services.mail
    const usage = mail.stalwart_id
        ? await stalwart_account_usage(mail.stalwart_id).catch(() => null)
        : null
    return {
        username: user.username,
        email: user_mail_address(user),
        created: user.created,
        external_email: user.external_email ? { address: user.external_email.address, verified_at: user.external_email.verified_at } : null,
        redirect: { enabled: mail.redirect.enabled, keep_copy: mail.redirect.keep_copy },
        quota: { used_bytes: usage?.used_bytes ?? null, limit_bytes: mail.quota_bytes }
    }
}

const user_subject = (user: UserDB): CodeSubject => `user:${user.id_user}`

async function with_current_user<T>(id_user: string, work: (user: UserDB) => Promise<T>, active = true): Promise<T> {
    return account_lock([`account:${id_user}`], async () => {
        const user = await user_find_by_id(id_user)
        if (!user || user.status === "deleting") throw new AccountError(404, "not_found")
        if (active && user.status !== "active") throw new AccountError(401, "not_signed_in")
        return work(user)
    })
}

export async function me_email_send(user: UserDB, address_input: string): Promise<CodeSendResult> {
    return with_current_user(user.id_user, current => me_email_send_locked(current, address_input))
}

async function me_email_send_locked(user: UserDB, address_input: string): Promise<CodeSendResult> {
    const { address, key } = email_normalize(address_input)
    if (user.external_email?.key === key) throw new AccountError(409, "email_unchanged")
    if (!await external_email_free(key, user.id_user)) throw new AccountError(409, "email_taken")
    return code_send(user_subject(user), address, key)
}

async function redirect_sync(user: UserDB, redirect: UserDB["services"]["mail"]["redirect"], external: ExternalEmail | null) {
    const stalwart_id = user.services.mail.stalwart_id
    if (!stalwart_id) throw new AccountError(409, "no_mailbox")
    const script = redirect.enabled && external ? sieve_redirect_script(external.address, redirect.keep_copy) : null
    await stalwart_redirect_apply(stalwart_id, script).catch(() => { throw new AccountError(502, "mailbox_failed") })
}

/** Verifies the code and makes the address the account's external email. */
export async function me_email_verify(user: UserDB, address_input: string, code: string) {
    return with_current_user(user.id_user, current => me_email_verify_locked(current, address_input, code))
}

async function me_email_verify_locked(user: UserDB, address_input: string, code: string) {
    const { address, key } = email_normalize(address_input)
    const checked = await code_check(user_subject(user), key, code)
    if (!checked.ok) throw new AccountError(400, `code_${checked.reason}`)
    if (!await external_email_free(key, user.id_user)) throw new AccountError(409, "email_taken")

    const external: ExternalEmail = { address, key, verified_at: now_iso() }
    const redirect = { ...user.services.mail.redirect, bounces: 0 }
    // the redirect follows the new address before the database says so, so mail never goes to a stale one
    if (redirect.enabled) await redirect_sync(user, redirect, external)
    try {
        await users().updateOne({ id_user: user.id_user }, { $set: { external_email: external, "services.mail.redirect": redirect } })
    } catch (err) {
        if (redirect.enabled) await redirect_sync(user, user.services.mail.redirect, user.external_email)
        if (is_duplicate_key(err, "external_email.key")) throw new AccountError(409, "email_taken")
        throw err
    }

    const old = user.external_email
    if (old) await mail_send(mail_external_email_changed(old.address, user.username, address)).catch(() => {})
    scopelog.info(`${user.username} verified external email${old ? " (replaced the old one)" : ""}`)
    return me_view({ ...user, external_email: external, services: { mail: { ...user.services.mail, redirect } } })
}

export async function me_email_remove(user: UserDB, password: string) {
    return with_current_user(user.id_user, current => me_email_remove_locked(current, password))
}

async function me_email_remove_locked(user: UserDB, password: string) {
    if (!await password_verify(user.password_hash, password)) throw new AccountError(403, "password_wrong")
    const old = user.external_email
    if (!old) throw new AccountError(409, "no_external_email")
    const redirect = { ...user.services.mail.redirect, enabled: false, bounces: 0 }
    if (user.services.mail.redirect.enabled) await redirect_sync(user, redirect, null)
    try {
        await users().updateOne({ id_user: user.id_user }, { $set: { external_email: null, "services.mail.redirect": redirect } })
    } catch (err) {
        await redirect_sync(user, user.services.mail.redirect, user.external_email)
        throw err
    }
    await mail_send(mail_external_email_changed(old.address, user.username, null)).catch(() => {})
    scopelog.info(`${user.username} removed their external email`)
    return me_view({ ...user, external_email: null, services: { mail: { ...user.services.mail, redirect } } })
}

export async function me_redirect_update(user: UserDB, change: { enabled: boolean, keep_copy: boolean }) {
    return with_current_user(user.id_user, current => me_redirect_update_locked(current, change))
}

async function me_redirect_update_locked(user: UserDB, change: { enabled: boolean, keep_copy: boolean }) {
    if (change.enabled && !user.external_email) throw new AccountError(409, "no_external_email")
    const redirect = { enabled: change.enabled, keep_copy: change.keep_copy, bounces: 0 }
    await redirect_sync(user, redirect, user.external_email)
    try {
        await users().updateOne({ id_user: user.id_user }, { $set: { "services.mail.redirect": redirect } })
    } catch (err) {
        await redirect_sync(user, user.services.mail.redirect, user.external_email)
        throw err
    }
    scopelog.info(`${user.username} turned redirect ${change.enabled ? `on (${change.keep_copy ? "keep copy" : "no copy"})` : "off"}`)
    return me_view({ ...user, services: { mail: { ...user.services.mail, redirect } } })
}

/**
 * Counts a hard bounce of a redirected message. After MAIL_REDIRECT_MAX_BOUNCES the redirect
 * is turned off and the user is told in their femboyz mailbox, which now keeps everything.
 */
export async function redirect_bounce_register(username: string, recipient_key: string): Promise<void> {
    const user = await user_find_by_username(username)
    if (!user || user.status !== "active") return
    return with_current_user(user.id_user, () => redirect_bounce_register_locked(username, recipient_key))
}

async function redirect_bounce_register_locked(username: string, recipient_key: string): Promise<void> {
    const document = await users().findOneAndUpdate(
        { username, "external_email.key": recipient_key, "services.mail.redirect.enabled": true },
        { $inc: { "services.mail.redirect.bounces": 1 } },
        { returnDocument: "after", projection: { _id: 0 } })
    if (!document) return
    const user = user_parse(document)
    const { bounces } = user.services.mail.redirect
    scopelog.warn(`Redirect of ${username} bounced (${bounces}/${envs.MAIL_REDIRECT_MAX_BOUNCES})`)
    if (bounces < envs.MAIL_REDIRECT_MAX_BOUNCES) return

    const redirect = { ...user.services.mail.redirect, enabled: false }
    await redirect_sync(user, redirect, null)
    await users().updateOne({ id_user: user.id_user }, { $set: { "services.mail.redirect.enabled": false } })
    await mail_send(mail_redirect_disabled(user_mail_address(user), user.external_email!.address)).catch(() => {})
    scopelog.warn(`Redirect of ${username} turned off after ${bounces} bounces`)
}

// ---- ADMIN: USERS ----

function user_admin_view(user: UserDB) {
    const { password_hash: _, ...rest } = user
    return { ...rest, email: user_mail_address(user), new_sender_until: new_sender_until(user) }
}

export async function user_list(search: string) {
    const filter = search
        ? { $or: [
            { username: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
            { "external_email.key": { $regex: search.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } }
        ] }
        : {}
    const documents = await users().find({ $and: [filter, { status: { $ne: "deleting" } }] }, { projection: { _id: 0 } }).sort({ created: -1 }).limit(500).toArray()
    return { items: documents.map(document => user_admin_view(user_parse(document))) }
}

/** Ends every femboyz.cloud and OIDC session of a user (their refresh tokens included). */
async function user_sessions_end(id_user: string) {
    await Promise.all([
        getDB().collection(envs.MDB_COLLECTION_WEB_SESSIONS).deleteMany({ id_user }),
        getDB().collection(envs.MDB_COLLECTION_OIDC).deleteMany({ "payload.accountId": id_user })
    ])
}

export async function user_update(id_user: string, change: { status?: "active" | "disabled" | undefined, quota_bytes?: number | undefined }) {
    return with_current_user(id_user, user => user_update_locked(user, change), false)
}

async function user_update_locked(user: UserDB, change: { status?: "active" | "disabled" | undefined, quota_bytes?: number | undefined }) {
    const id_user = user.id_user
    const stalwart_id = user.services.mail.stalwart_id
    if (stalwart_id) {
        const stalwart_change = {
            ...(change.status !== undefined ? { enabled: change.status === "active" } : {}),
            ...(change.quota_bytes !== undefined ? { quota_bytes: change.quota_bytes } : {})
        }
        await stalwart_account_update(stalwart_id, stalwart_change).catch(() => { throw new AccountError(502, "mailbox_failed") })
    }
    const set: Record<string, unknown> = {}
    if (change.status !== undefined) set.status = change.status
    if (change.quota_bytes !== undefined) set["services.mail.quota_bytes"] = change.quota_bytes
    if (Object.keys(set).length === 0) throw new AccountError(400, "empty_update")
    const document = await users().findOneAndUpdate({ id_user }, { $set: set }, { returnDocument: "after", projection: { _id: 0 } })
    if (change.status === "disabled") await user_sessions_end(id_user)
    scopelog.info(`Admin updated user ${user.username}: ${JSON.stringify(change)}`)
    return user_admin_view(user_parse(document))
}

/** Disable immediately, then destroy after every previously issued mail JWT has expired.
 * Stalwart otherwise provisions the deleted username again from an old, valid JWT.
 * The deletion deadline is persistent so restarts cannot lose queued deletions.
 */
export async function user_delete(id_user: string): Promise<boolean> {
    return account_lock([`account:${id_user}`], async () => {
        const user = await user_find_by_id(id_user)
        if (!user) return false
        if (user.status === "deleting") return true
        if (user.services.mail.stalwart_id)
            await stalwart_account_update(user.services.mail.stalwart_id, { enabled: false })
                .catch(() => { throw new AccountError(502, "mailbox_failed") })
        await users().updateOne({ id_user }, { $set: {
            status: "deleting",
            delete_after: now_iso(Date.now() + (MAIL_ACCESS_TOKEN_TTL_SECONDS + 60) * 1000)
        } })
        await user_sessions_end(id_user)
        scopelog.warn(`Admin queued deletion of ${user.username} (${id_user}); authentication disabled`)
        return true
    })
}

// ---- NEW SENDERS ----

/** When the stricter outbound throttles stop applying, or null once they have. */
export function new_sender_until(user: Pick<UserDB, "created">, now = Date.now()): string | null {
    const until = Date.parse(user.created) + envs.MAIL_NEW_SENDER_DAYS * 24 * 3600 * 1000
    return until > now ? new Date(until).toISOString() : null
}

let new_senders_running: Promise<void> = Promise.resolve()

/** Makes Stalwart's new-sender list match the accounts younger than MAIL_NEW_SENDER_DAYS.
 * Runs at startup, every few minutes and after signups; calls are serialized. */
export function new_senders_sync(now = Date.now()): Promise<void> {
    const run = new_senders_running.then(() => new_senders_sync_now(now))
    new_senders_running = run.catch(() => {})
    return run
}

async function new_senders_sync_now(now: number) {
    const cutoff = now_iso(now - envs.MAIL_NEW_SENDER_DAYS * 24 * 3600 * 1000)
    const young = await users().find(
        { created: { $gt: cutoff }, status: { $ne: "deleting" }, "services.mail.stalwart_id": { $ne: null } },
        { projection: { _id: 0, username: 1 } }).toArray()
    const wanted = new Set(young.map(user => user_mail_address(user as Pick<UserDB, "username">)))
    const current = await stalwart_new_senders_get()
    const add = [...wanted].filter(address => !current.has(address))
    const remove = [...current].filter(([address]) => !wanted.has(address)).map(([, id]) => id)
    await stalwart_new_senders_change(add, remove)
}

/** Called at startup and once a minute. Failures stay queued for the next attempt. */
export async function user_deletions_finish(now = Date.now()): Promise<void> {
    const due = await users().find({ status: "deleting", delete_after: { $lte: now_iso(now) } }).toArray()
    for (const entry of due) await account_lock([`account:${entry.id_user}`], async () => {
        const user = await user_find_by_id(entry.id_user)
        if (!user || user.status !== "deleting") return
        if (user.services.mail.stalwart_id) await stalwart_account_destroy(user.services.mail.stalwart_id)
        await users().deleteOne({ id_user: user.id_user, status: "deleting" })
        scopelog.warn(`Finished deletion of ${user.username} (${user.id_user})`)
    }).catch(err => errorFileLogger.error({ err }, `Failed to finish deletion of ${entry.id_user}`))
}
