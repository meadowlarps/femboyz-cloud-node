import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { createHmac } from "node:crypto"
import { MongoMemoryServer } from "mongodb-memory-server"
import { Collection, MongoClient, type Db } from "mongodb"

// Mocked mail server and SMTP: every account test runs without Stalwart or a mail relay.
const stalwart = vi.hoisted(() => ({
    created: [] as string[],
    fail_create: false,
    before_create: null as (() => Promise<void>) | null,
    destroyed: [] as string[],
    redirects: new Map<string, string | null>(),
    updates: [] as { id: string, change: unknown }[]
}))
const sent = vi.hoisted(() => [] as { to: string, subject: string, text: string }[])
const db_holder = vi.hoisted(() => ({ db: undefined as Db | undefined }))

vi.mock("../database.js", async importOriginal => ({
    ...await importOriginal<typeof import("../database.js")>(),
    getDB: () => db_holder.db
}))
vi.mock("../stalwart.js", async importOriginal => {
    const original = await importOriginal<typeof import("../stalwart.js")>()
    return {
        ...original,
        stalwart_account_create: async ({ username }: { username: string }) => {
            await stalwart.before_create?.()
            if (stalwart.fail_create) throw new original.StalwartError("mail server down")
            stalwart.created.push(username)
            return `sw-${username}`
        },
        stalwart_account_update: async (id: string, change: unknown) => { stalwart.updates.push({ id, change }) },
        stalwart_account_destroy: async (id: string) => { stalwart.destroyed.push(id) },
        stalwart_account_usage: async () => ({ used_bytes: 10, quota_bytes: 1024 }),
        stalwart_redirect_apply: async (id: string, script: string | null) => { stalwart.redirects.set(id, script) }
    }
})
vi.mock("../mailer.js", async importOriginal => ({
    ...await importOriginal<typeof import("../mailer.js")>(),
    mail_send: async (message: { to: string, subject: string, text: string }) => { sent.push(message) }
}))

const { envs } = await import("../config.js")
Object.assign(envs, {
    OIDC_ISSUER: "https://femboyz.test/oidc",
    EMAIL_CODE_SECRET: "test-secret",
    MAIL_DOMAIN: "femboyz.cloud",
    EMAIL_CODE_MAX_ATTEMPTS: 5,
    EMAIL_CODE_TTL_MINUTES: 10,
    MAIL_REDIRECT_MAX_BOUNCES: 3,
    ACCOUNT_REQUESTS_MAX_PENDING: 3
})
const { account_indexes_ensure } = await import("../database.js")
const accounts = await import("../accounts.js")
const codes = await import("../emailcodes.js")
const { sieve_redirect_script } = await import("../stalwart.js")
const { webhook_bounces, webhook_signature_valid } = await import("../accountApi.js")
const { cookies_parse, _internal } = await import("../oidc.js")

let mongo: MongoMemoryServer
let client: MongoClient

beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    client = await MongoClient.connect(mongo.getUri())
}, 120_000)

afterAll(async () => {
    await client?.close()
    await mongo?.stop()
})

beforeEach(async () => {
    db_holder.db = client.db(`accounts_${Math.random().toString(36).slice(2)}`)
    await account_indexes_ensure(db_holder.db)
    stalwart.created.length = 0
    stalwart.fail_create = false
    stalwart.before_create = null
    stalwart.destroyed.length = 0
    stalwart.redirects.clear()
    stalwart.updates.length = 0
    sent.length = 0
})

const PASSWORD = "a long and unusual passphrase"
const last_code = (to: string) => sent.filter(mail => mail.to === to).at(-1)?.subject.slice(0, 4) ?? ""
const invite_code = (link: string) => new URL(link).searchParams.get("invite")!

async function user_create(username = "alice", external?: string) {
    const { link, invite } = await accounts.invite_create({ email: external ?? null })
    await accounts.signup({ invite: invite_code(link), username, password: PASSWORD, ...(external ? { external_email: { address: external } } : {}) })
    expect(invite.id).toBeTruthy()
    return (await accounts.user_find_by_username(username))!
}

// ---- rules ----

test("username rules and the reserved list", () => {
    expect(accounts.username_problem("alice")).toBeNull()
    expect(accounts.username_problem("a.b-c_d9")).toBeNull()
    for (const bad of ["ab", "-alice", "alice.", "al..ice", "Alice", "al ice", "a".repeat(33), "alice+tag", "élise"])
        expect(accounts.username_problem(bad), bad).toBe("invalid")
    // every internal Stalwart account and alias must be unobtainable: Stalwart provisions on first OIDC login
    for (const name of ["admin", "noreply", "femboyz-api", "postmaster", "abuse", "dmarc", "hostmaster", "webmaster", "mailer-daemon", "root"])
        expect(accounts.username_problem(name), name).toBe("reserved")
    expect(accounts.username_problem("femboyzfan")).toBe("reserved")
    expect(accounts.username_problem("admin2")).toBe("reserved")
    expect(accounts.username_normalize("  Alice@FEMBOYZ.cloud ")).toBe("alice")
})

test("password policy", () => {
    expect(accounts.password_problem("short", "alice")).toBe("too_short")
    expect(accounts.password_problem("qwerty123456", "alice")).toBe("common")
    expect(accounts.password_problem("QWERTY123456", "alice")).toBe("common")
    expect(accounts.password_problem("aaaaaaaaaaaaaaa", "alice")).toBe("common")
    expect(accounts.password_problem("my alice password!", "alice")).toBe("contains_username")
    expect(accounts.password_problem(PASSWORD, "alice")).toBeNull()
    expect(accounts.password_problem("x".repeat(257), "alice")).toBe("too_long")
})

test("external addresses are normalised and our domain is refused", () => {
    expect(accounts.email_normalize("  Bob.Smith@Example.COM ")).toEqual({ address: "Bob.Smith@example.com", key: "bob.smith@example.com" })
    expect(() => accounts.email_normalize("bob@femboyz.cloud")).toThrow("own_domain")
    expect(() => accounts.email_normalize("bob@mail.femboyz.cloud")).toThrow("own_domain")
    for (const bad of ["bob", "bob@", "@example.com", "bo b@example.com", 'b"ob@example.com', "bob@example"])
        expect(() => accounts.email_normalize(bad), bad).toThrow("invalid_email")
})

test("redirect script with and without a copy, spam-guarded", () => {
    const copy = sieve_redirect_script("bob@example.com", true)
    expect(copy).toContain(`require ["copy"];`)
    expect(copy).toContain(`redirect :copy "bob@example.com";`)
    expect(copy).toContain(`if header :matches "X-Spam-Score" "spam*"`)
    const move = sieve_redirect_script("bob@example.com", false)
    expect(move).not.toContain("copy")
    expect(move).toContain(`redirect "bob@example.com";`)
    expect(() => sieve_redirect_script('bob"; discard; "@example.com', true)).toThrow()
})

test("webhook: signature and redirect bounces", () => {
    const body = JSON.stringify({ events: [
        { type: "delivery.dsn-perm-fail", data: { from: "alice@femboyz.cloud", to: "Bob@Example.com" } },
        { type: "delivery.dsn-perm-fail", data: { from: "someone@other.org", to: "bob@example.com" } },
        { type: "delivery.dsn-temp-fail", data: { from: "alice@femboyz.cloud", to: "bob@example.com" } }
    ] })
    const signature = createHmac("sha256", "k").update(body).digest("base64")
    expect(webhook_signature_valid(body, signature, "k")).toBe(true)
    expect(webhook_signature_valid(body + " ", signature, "k")).toBe(false)
    expect(webhook_signature_valid(body, undefined, "k")).toBe(false)
    expect(webhook_bounces(JSON.parse(body))).toEqual([{ username: "alice", recipient_key: "bob@example.com" }])
    expect(webhook_bounces({ nope: 1 })).toEqual([])
})

test("site session helpers", () => {
    expect(cookies_parse("a=1; fbz_session=abc%3D; b")).toEqual({ a: "1", fbz_session: "abc=" })
    expect(_internal.safe_return("/account?embed=1")).toBe("/account?embed=1")
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "account", undefined])
        expect(_internal.safe_return(bad)).toBe("/account")
    Object.assign(envs, { OIDC_COOKIE_KEYS: ["k1"] })
    const signed = _internal.sign("payload")
    expect(_internal.unsign(signed)).toBe("payload")
    expect(_internal.unsign(signed.slice(0, -1) + (signed.endsWith("A") ? "B" : "A"))).toBeNull()
})

// ---- invites and signup ----

test("an invite works once, even when used in parallel", async () => {
    const { link } = await accounts.invite_create({})
    const code = invite_code(link)
    const results = await Promise.allSettled(["bob", "carol", "dave", "erin"].map(username =>
        accounts.signup({ invite: code, username, password: PASSWORD })))
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(stalwart.created).toHaveLength(1)
    expect(await accounts.invite_find_usable(code)).toBeNull()
})

test("signup rolls back when the mail server fails", async () => {
    const { link } = await accounts.invite_create({})
    stalwart.fail_create = true
    await expect(accounts.signup({ invite: invite_code(link), username: "bob", password: PASSWORD })).rejects.toMatchObject({ code: "mailbox_failed" })
    expect(await accounts.user_find_by_username("bob")).toBeNull()
    stalwart.fail_create = false
    // the invite and the username are free again
    await accounts.signup({ invite: invite_code(link), username: "bob", password: PASSWORD })
    expect((await accounts.user_find_by_username("bob"))?.services.mail.stalwart_id).toBe("sw-bob")
})

test("signup refuses taken usernames, weak passwords and spent invites", async () => {
    await user_create("bob")
    const { link } = await accounts.invite_create({})
    const code = invite_code(link)
    await expect(accounts.signup({ invite: code, username: "BOB", password: PASSWORD })).rejects.toMatchObject({ code: "username_taken" })
    await expect(accounts.signup({ invite: code, username: "admin", password: PASSWORD })).rejects.toMatchObject({ code: "username_reserved" })
    await expect(accounts.signup({ invite: code, username: "carol", password: "password1234" })).rejects.toMatchObject({ code: "password_common" })
    await expect(accounts.signup({ invite: "nope", username: "carol", password: PASSWORD })).rejects.toMatchObject({ code: "invite_invalid" })
    const user = await accounts.user_find_by_username("bob")
    expect(user?.password_hash).toMatch(/^\$argon2id\$/)
})

test("the invite's own address is pre-verified, another one needs a code", async () => {
    const { link, invite } = await accounts.invite_create({ email: "Friend@Example.org" })
    const code = invite_code(link)
    expect(await accounts.signup_email_code(code, "friend@example.org")).toEqual({ verified: true })

    await expect(accounts.signup({ invite: code, username: "bob", password: PASSWORD, external_email: { address: "other@example.org" } }))
        .rejects.toMatchObject({ code: "code_invalid" })
    expect(await accounts.signup_email_code(code, "other@example.org")).toMatchObject({ ok: true })
    const sent_code = last_code("other@example.org")
    await accounts.signup({ invite: code, username: "bob", password: PASSWORD, external_email: { address: "other@example.org", code: sent_code } })
    expect((await accounts.user_find_by_username("bob"))?.external_email?.address).toBe("other@example.org")
    expect(invite.email).toBe("Friend@example.org")
})

test("an external address can't be on two accounts or at our domain", async () => {
    await user_create("bob", "bob@example.org")
    const { link } = await accounts.invite_create({ email: "BOB@example.org" })
    await expect(accounts.signup({ invite: invite_code(link), username: "carol", password: PASSWORD, external_email: { address: "BOB@example.org" } }))
        .rejects.toMatchObject({ code: "email_taken" })
    const carol = await user_create("carol")
    await expect(accounts.me_email_send(carol, "bob@EXAMPLE.org")).rejects.toMatchObject({ code: "email_taken" })
    await expect(accounts.me_email_send(carol, "carol@femboyz.cloud")).rejects.toMatchObject({ code: "own_domain" })
})

// ---- email codes ----

test("codes are stored as HMACs, expire, and are single use", async () => {
    const bob = await user_create("bob")
    const t0 = Date.parse("2026-10-19T12:00:00Z")
    expect(await codes.code_send(`user:${bob.id_user}`, "b@example.org", "b@example.org", t0)).toMatchObject({ ok: true })
    const code = last_code("b@example.org")
    const stored = await db_holder.db!.collection(envs.MDB_COLLECTION_EMAIL_CODES).findOne({})
    expect(JSON.stringify(stored)).not.toContain(`"${code}"`)
    expect(stored?.code_hmac).toBe(codes.code_hmac(code, "b@example.org", `user:${bob.id_user}`))

    // the code is bound to its subject and address
    expect(await codes.code_check(`user:${bob.id_user}`, "other@example.org", code, t0)).toMatchObject({ ok: false })
    expect(await codes.code_check(`user:${bob.id_user}`, "b@example.org", code, t0 + 11 * 60_000)).toEqual({ ok: false, reason: "expired" })
    const checked = await codes.code_check(`user:${bob.id_user}`, "b@example.org", code, t0)
    expect(checked.ok).toBe(true)
    expect(await codes.code_check(`user:${bob.id_user}`, "b@example.org", code, t0)).toEqual({ ok: false, reason: "invalid" })
})

test("five wrong guesses burn a code, and a new code replaces the old one", async () => {
    const subject = "user:x" as const
    const t0 = Date.parse("2026-10-19T12:00:00Z")
    await codes.code_send(subject, "b@example.org", "b@example.org", t0)
    const code = last_code("b@example.org")
    const wrong = code === "0000" ? "1111" : "0000"
    const results = []
    for (let i = 0; i < 5; i++) results.push((await codes.code_check(subject, "b@example.org", wrong, t0)) as { reason?: string })
    expect(results.map(result => result.reason)).toEqual(["invalid", "invalid", "invalid", "invalid", "burned"])
    expect(await codes.code_check(subject, "b@example.org", code, t0)).toMatchObject({ ok: false })

    await codes.code_send(subject, "b@example.org", "b@example.org", t0 + 61_000)
    const first = last_code("b@example.org")
    await codes.code_send(subject, "b@example.org", "b@example.org", t0 + 122_000)
    const second = last_code("b@example.org")
    if (first !== second) expect(await codes.code_check(subject, "b@example.org", first, t0 + 123_000)).toMatchObject({ ok: false })
    expect(await codes.code_check(subject, "b@example.org", second, t0 + 123_000)).toMatchObject({ ok: true })
})

test("code limits: cooldown, per subject per hour, per address per day", async () => {
    const t0 = Date.parse("2026-10-19T12:00:00Z")
    expect(await codes.code_send("user:a", "x@example.org", "x@example.org", t0)).toMatchObject({ ok: true })
    expect(await codes.code_send("user:a", "x@example.org", "x@example.org", t0 + 30_000)).toMatchObject({ ok: false, reason: "cooldown" })
    for (let i = 1; i < 5; i++)
        expect(await codes.code_send("user:a", `y${i}@example.org`, `y${i}@example.org`, t0 + i * 61_000)).toMatchObject({ ok: true })
    expect(await codes.code_send("user:a", "z@example.org", "z@example.org", t0 + 6 * 61_000)).toMatchObject({ ok: false, reason: "limit" })

    // one destination can't be flooded from many subjects
    for (let i = 0; i < 5; i++)
        expect(await codes.code_send(`user:s${i}`, "victim@example.org", "victim@example.org", t0)).toMatchObject({ ok: true })
    expect(await codes.code_send("user:s9", "victim@example.org", "victim@example.org", t0)).toMatchObject({ ok: false, reason: "limit" })
})

// ---- external email and redirect ----

test("redirect needs a verified address, follows changes and stops on removal", async () => {
    let bob = await user_create("bob")
    await expect(accounts.me_redirect_update(bob, { enabled: true, keep_copy: true })).rejects.toMatchObject({ code: "no_external_email" })

    await accounts.me_email_send(bob, "bob@example.org")
    await accounts.me_email_verify(bob, "bob@example.org", last_code("bob@example.org"))
    bob = (await accounts.user_find_by_id(bob.id_user))!
    await accounts.me_redirect_update(bob, { enabled: true, keep_copy: false })
    expect(stalwart.redirects.get("sw-bob")).toContain(`redirect "bob@example.org";`)

    // change: the redirect moves to the new address and the old one is told
    bob = (await accounts.user_find_by_id(bob.id_user))!
    // step past the 60 s resend cooldown
    await db_holder.db!.collection(envs.MDB_COLLECTION_EMAIL_CODES).updateMany({}, { $set: { created: new Date(Date.now() - 120_000) } })
    expect(await accounts.me_email_send(bob, "new@example.org")).toMatchObject({ ok: true })
    await accounts.me_email_verify(bob, "new@example.org", last_code("new@example.org"))
    expect(stalwart.redirects.get("sw-bob")).toContain(`"new@example.org"`)
    expect(sent.some(mail => mail.to === "bob@example.org" && /changed/.test(mail.subject))).toBe(true)

    bob = (await accounts.user_find_by_id(bob.id_user))!
    await expect(accounts.me_email_remove(bob, "wrong password")).rejects.toMatchObject({ code: "password_wrong" })
    await accounts.me_email_remove(bob, PASSWORD)
    expect(stalwart.redirects.get("sw-bob")).toBeNull()
    bob = (await accounts.user_find_by_id(bob.id_user))!
    expect(bob.external_email).toBeNull()
    expect(bob.services.mail.redirect.enabled).toBe(false)
})

test("repeated bounces turn the redirect off", async () => {
    let bob = await user_create("bob", "bob@example.org")
    await accounts.me_redirect_update(bob, { enabled: true, keep_copy: true })
    for (let i = 0; i < 2; i++) await accounts.redirect_bounce_register("bob", "bob@example.org")
    // a bounce for a different recipient isn't ours to count
    await accounts.redirect_bounce_register("bob", "someone@else.org")
    bob = (await accounts.user_find_by_id(bob.id_user))!
    expect(bob.services.mail.redirect).toMatchObject({ enabled: true, bounces: 2 })
    await accounts.redirect_bounce_register("bob", "bob@example.org")
    bob = (await accounts.user_find_by_id(bob.id_user))!
    expect(bob.services.mail.redirect.enabled).toBe(false)
    expect(stalwart.redirects.get("sw-bob")).toBeNull()
    expect(sent.some(mail => mail.to === "bob@femboyz.cloud" && /turned off/.test(mail.subject))).toBe(true)
})

// ---- requests, admin ----

test("access requests: repeats are ignored and pending requests are capped", async () => {
    const issuer = { ip: "1.2.3.4", ua: "test" }
    await accounts.request_create({ email: "a@example.org", note: "hi" }, issuer)
    await accounts.request_create({ email: "A@EXAMPLE.org", note: "again" }, issuer)
    expect((await accounts.request_list("pending")).items).toHaveLength(1)
    expect(sent.filter(mail => mail.to === envs.ADMIN_NOTIFY_EMAIL)).toHaveLength(1)
    await accounts.request_create({ email: "b@example.org", note: "" }, issuer)
    await accounts.request_create({ email: "c@example.org", note: "" }, issuer)
    await expect(accounts.request_create({ email: "d@example.org", note: "" }, issuer)).rejects.toMatchObject({ code: "requests_full" })
})

test("approving mails an invite tied to the request address; rejecting is silent", async () => {
    const issuer = { ip: "1.2.3.4", ua: "test" }
    await accounts.request_create({ email: "a@example.org", note: "" }, issuer)
    await accounts.request_create({ email: "b@example.org", note: "" }, issuer)
    const pending = (await accounts.request_list("pending")).items
    const a = pending.find(request => request.email === "a@example.org")
    const b = pending.find(request => request.email === "b@example.org")
    const approved = await accounts.request_approve(a!.id)
    expect(approved.invite.email).toBe("a@example.org")
    expect(sent.at(-1)).toMatchObject({ to: "a@example.org" })
    await expect(accounts.request_approve(a!.id)).rejects.toMatchObject({ code: "already_decided" })
    const mails = sent.length
    await accounts.request_reject(b!.id)
    expect(sent.length).toBe(mails)
})

test("disabling a user disables the mailbox and ends their sessions", async () => {
    const bob = await user_create("bob")
    await db_holder.db!.collection(envs.MDB_COLLECTION_WEB_SESSIONS).insertOne({ id_user: bob.id_user, token_hash: "x", expires: new Date(Date.now() + 1e6) })
    await db_holder.db!.collection(envs.MDB_COLLECTION_OIDC).insertOne({ _id: "Session:1" as never, payload: { accountId: bob.id_user } })
    await accounts.user_update(bob.id_user, { status: "disabled" })
    expect(stalwart.updates).toEqual([{ id: "sw-bob", change: { enabled: false } }])
    expect(await db_holder.db!.collection(envs.MDB_COLLECTION_WEB_SESSIONS).countDocuments()).toBe(0)
    expect(await db_holder.db!.collection(envs.MDB_COLLECTION_OIDC).countDocuments()).toBe(0)
    expect(await accounts.user_login_verify("bob", PASSWORD)).toBeNull()
    await accounts.user_update(bob.id_user, { status: "active" })
    expect((await accounts.user_login_verify("BOB@femboyz.cloud", PASSWORD))?.username).toBe("bob")
})

test("parallel code sends honor subject cooldown and destination limits", async () => {
    const now = Date.now()
    const same = await Promise.all(Array.from({ length: 10 }, () => codes.code_send("user:parallel", "same@example.org", "same@example.org", now)))
    expect(same.filter(result => result.ok)).toHaveLength(1)
    expect(await db_holder.db!.collection(envs.MDB_COLLECTION_EMAIL_CODES).countDocuments({ subject: "user:parallel", used: false })).toBe(1)
    const destination = await Promise.all(Array.from({ length: 12 }, (_, i) => codes.code_send(`user:sender${i}`, "destination@example.org", "destination@example.org", now)))
    expect(destination.filter(result => result.ok)).toHaveLength(5)
})

test("parallel guesses reserve attempts before comparison and a match works once", async () => {
    const subject = "user:guess-race" as const
    await codes.code_send(subject, "race@example.org", "race@example.org")
    const code = last_code("race@example.org")
    const wrong = code === "0000" ? "1111" : "0000"
    const attempts = await Promise.all([...Array.from({ length: 20 }, () => wrong), code].map(value => codes.code_check(subject, "race@example.org", value)))
    expect(attempts.filter(result => result.ok)).toHaveLength(0)
    expect((await db_holder.db!.collection(envs.MDB_COLLECTION_EMAIL_CODES).findOne({ subject }))?.attempts).toBe(5)

    await codes.code_send("user:one-use", "once@example.org", "once@example.org")
    const matches = await Promise.all(Array.from({ length: 5 }, () => codes.code_check("user:one-use", "once@example.org", last_code("once@example.org"))))
    expect(matches.filter(result => result.ok)).toHaveLength(1)
})

test("signup stays inactive until provisioning finishes and revocation rolls it back", async () => {
    const { link, invite } = await accounts.invite_create({})
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { finish = resolve })
    stalwart.before_create = async () => { entered(); await gate }
    const signup = accounts.signup({ invite: invite_code(link), username: "pendinguser", password: PASSWORD })
    await started
    expect(await accounts.user_login_verify("pendinguser", PASSWORD)).toBeNull()
    await accounts.invite_revoke(invite.id)
    finish()
    await expect(signup).rejects.toMatchObject({ code: "mailbox_failed" })
    expect(stalwart.destroyed).toEqual(["sw-pendinguser"])
    expect(await accounts.user_find_by_username("pendinguser")).toBeNull()
})

test("signup removes an already-created mailbox if final database activation fails", async () => {
    const { link } = await accounts.invite_create({})
    const original = Collection.prototype.updateOne
    let failed = false
    const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(async function (this: Collection, filter, update, options) {
        if (!failed && this.collectionName === envs.MDB_COLLECTION_USERS && !Array.isArray(update) && update.$set?.status === "active") {
            failed = true
            throw new Error("activation write failed")
        }
        return original.call(this, filter, update, options ?? {})
    })
    try {
        await expect(accounts.signup({ invite: invite_code(link), username: "rollbackuser", password: PASSWORD })).rejects.toMatchObject({ code: "mailbox_failed" })
        expect(stalwart.destroyed).toEqual(["sw-rollbackuser"])
        expect(await accounts.user_find_by_username("rollbackuser")).toBeNull()
        expect(await accounts.invite_find_usable(invite_code(link))).not.toBeNull()
    } finally { spy.mockRestore() }
})

test("overlapping email removal and redirect update cannot restore an old address", async () => {
    const stale = await user_create("staleuser", "old@example.org")
    await accounts.me_redirect_update(stale, { enabled: true, keep_copy: true })
    const results = await Promise.allSettled([
        accounts.me_email_remove(stale, PASSWORD),
        accounts.me_redirect_update(stale, { enabled: true, keep_copy: true })
    ])
    expect(results[0]?.status).toBe("fulfilled")
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "no_external_email" } })
    const current = (await accounts.user_find_by_id(stale.id_user))!
    expect(current.external_email).toBeNull()
    expect(current.services.mail.redirect.enabled).toBe(false)
    expect(stalwart.redirects.get("sw-staleuser")).toBeNull()
})

test("deletion blocks authentication until old JWTs expire, then removes the mailbox", async () => {
    const user = await user_create("deleteuser")
    await accounts.user_delete(user.id_user)
    expect(stalwart.updates).toContainEqual({ id: "sw-deleteuser", change: { enabled: false } })
    expect(await accounts.user_login_verify("deleteuser", PASSWORD)).toBeNull()
    expect((await accounts.user_list("")).items).toHaveLength(0)
    await expect(accounts.user_update(user.id_user, { status: "active" })).rejects.toMatchObject({ code: "not_found" })
    await accounts.user_deletions_finish()
    expect(stalwart.destroyed).toHaveLength(0)
    expect(await accounts.username_taken("deleteuser")).toBe(true)
    await accounts.user_deletions_finish(Date.now() + 12 * 60_000)
    expect(stalwart.destroyed).toEqual(["sw-deleteuser"])
    expect(await accounts.user_find_by_id(user.id_user)).toBeNull()
})

test("a failed external-email database write restores the previous forwarding script", async () => {
    const user = await user_create("restoreuser", "previous@example.org")
    await accounts.me_redirect_update(user, { enabled: true, keep_copy: true })
    await accounts.me_email_send(user, "replacement@example.org")
    const original = Collection.prototype.updateOne
    let failed = false
    const spy = vi.spyOn(Collection.prototype, "updateOne").mockImplementation(async function (this: Collection, filter, update, options) {
        if (!failed && this.collectionName === envs.MDB_COLLECTION_USERS && !Array.isArray(update) && update.$set?.external_email?.key === "replacement@example.org") {
            failed = true
            throw new Error("email update failed")
        }
        return original.call(this, filter, update, options ?? {})
    })
    try {
        await expect(accounts.me_email_verify(user, "replacement@example.org", last_code("replacement@example.org"))).rejects.toThrow("email update failed")
        expect((await accounts.user_find_by_id(user.id_user))?.external_email?.address).toBe("previous@example.org")
        expect(stalwart.redirects.get("sw-restoreuser")).toContain('"previous@example.org"')
    } finally { spy.mockRestore() }
})
