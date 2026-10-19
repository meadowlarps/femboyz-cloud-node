import { createHmac, timingSafeEqual } from "node:crypto"
import type Provider from "oidc-provider"
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify"
import * as z from "zod"
import { envs, site_origin } from "./config.js"
import { authlimit_create } from "./authlimit.js"
import { errorFileLogger, scope } from "./logger.js"
import {
    AccountError,
    email_normalize,
    invite_create,
    invite_find_usable,
    invite_list,
    invite_revoke,
    me_email_remove,
    me_email_send,
    me_email_verify,
    me_redirect_update,
    me_view,
    new_senders_sync,
    redirect_bounce_register,
    request_approve,
    request_create,
    request_list,
    request_reject,
    signup,
    signup_email_code,
    user_delete,
    user_deletions_finish,
    user_list,
    user_login_verify,
    user_update,
    username_normalize,
    username_problem,
    username_taken
} from "./accounts.js"
import { OIDC_PREFIX, oidc_mount, oidc_provider_create, web_session_routes, web_session_user } from "./oidc.js"
import {
    AccountRequestCreateSchema,
    EmailAddressSchema,
    EmailVerifySchema,
    InviteCreateSchema,
    LoginSchema,
    PasswordConfirmSchema,
    RedirectUpdateSchema,
    SignupEmailCodeSchema,
    SignupSchema,
    UserUpdateSchema,
    type UserDB
} from "./schema.js"

const scopelog = scope("account-api")

declare module "fastify" {
    interface FastifyRequest {
        account_user?: UserDB
    }
}

// ---- RATE LIMITS ----
// authlimit counts failures; the "counter" limiters below count every call instead.

const minutes = (value: number) => value * 60_000

export const login_ip_limit = authlimit_create({
    max_fails: () => envs.ACCOUNT_LOGIN_MAX_FAILS,
    block_ms: () => minutes(envs.ACCOUNT_LOGIN_BLOCK_MINUTES)
})
// Per username, across IPs; set higher than the IP limit so one attacker can't lock someone out cheaply.
export const login_user_limit = authlimit_create({
    max_fails: () => envs.ACCOUNT_LOGIN_MAX_FAILS * 3,
    block_ms: () => minutes(envs.ACCOUNT_LOGIN_BLOCK_MINUTES)
})
export const invite_ip_limit = authlimit_create({ max_fails: () => 20, block_ms: () => minutes(15) })
export const request_ip_limit = authlimit_create({ max_fails: () => 5, block_ms: () => minutes(60) })
export const available_ip_limit = authlimit_create({ max_fails: () => 60, block_ms: () => minutes(1) })
export const code_ip_limit = authlimit_create({ max_fails: () => 10, block_ms: () => minutes(60) })

function limit_check(limit: ReturnType<typeof authlimit_create>, key: string, reply: FastifyReply) {
    const blocked_ms = limit.block_remaining_ms(key)
    if (blocked_ms <= 0) return
    reply.header("Retry-After", String(Math.ceil(blocked_ms / 1000)))
    throw new AccountError(429, "rate_limited", { retry_after_s: Math.ceil(blocked_ms / 1000) })
}

/** Counts one call; the call that reaches the limit is still served, the next is refused. */
function limit_count(limit: ReturnType<typeof authlimit_create>, key: string, reply: FastifyReply) {
    limit_check(limit, key, reply)
    limit.register_failure(key)
}

function log_block(what: string, key: string, blocked: { blocked: boolean, blockedUntil: number }, request: FastifyRequest) {
    if (!blocked.blocked) return
    const summary = `${what} blocked - "${key}" until ${new Date(blocked.blockedUntil).toISOString()} - ip "${request.ip}" - ua "${request.headers["user-agent"] ?? "unknown"}"`
    scopelog.warn(summary)
    errorFileLogger.error(summary)
}

// ---- HELPERS ----

function body_parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body)
    if (!result.success) throw new AccountError(400, "invalid_body", { issues: result.error.issues.map(issue => issue.path.join(".")) })
    return result.data
}

function issuer_of(request: FastifyRequest) {
    return { ip: request.ip, ua: request.headers["user-agent"] ?? "unknown" }
}

/**
 * CSRF guard for every state-changing account call: the browser's Origin must be our site.
 * The session cookies are SameSite=Lax as a second layer.
 */
const origin_check: preHandlerHookHandler = async (request) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return
    if (request.headers.origin !== site_origin()) throw new AccountError(403, "bad_origin")
}

const session_required: preHandlerHookHandler = async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const user = await web_session_user(request)
    if (!user) throw new AccountError(401, "not_signed_in")
    request.account_user = user
}

function account_error_handler(err: FastifyError | AccountError, request: FastifyRequest, reply: FastifyReply) {
    // the route pattern, not the URL: invite codes travel in paths and query strings
    const route = `${request.method} ${request.routeOptions.url ?? "?"}`
    if (err instanceof AccountError) {
        if (err.statusCode >= 500) scopelog.error(`${err.statusCode} ${err.code} on ${route}`)
        else scopelog.warn(`${err.statusCode} ${err.code} on ${route} from ${request.ip}`)
        return reply.status(err.statusCode).send({ error: err.code, ...err.extra })
    }
    const status = err.statusCode ?? 500
    if (status >= 500) {
        scopelog.error(`${status} — ${err.message} on ${route}`)
        errorFileLogger.error({ err }, `${err.message} - "${status}" on "${route}" from "${request.ip}"`)
        return reply.status(status === 502 || status === 503 ? status : 500).send({ error: "server_error" })
    }
    scopelog.warn(`${status} — ${err.message} on ${route} from ${request.ip}`)
    return reply.status(status === 415 || status === 413 ? status : 400).send({ error: "bad_request" })
}

// ---- REGISTRATION ----

/** Mounts the OIDC provider and every /api/v2/account route. `admin_auth` guards the admin ones. */
export async function account_routes_register(server: FastifyInstance, admin_auth: preHandlerHookHandler) {
    const provider = oidc_provider_create()
    oidc_mount(server, provider)
    const deletions = setInterval(() => { void user_deletions_finish().catch(err => errorFileLogger.error({ err }, "Account deletion worker failed")) }, 60_000)
    deletions.unref()
    // Keeps Stalwart's new-sender throttle tier in step with account age (DEPLOYMENT.md 16.1).
    const sync_new_senders = () => { void new_senders_sync().catch(err => errorFileLogger.error({ err }, "New-sender sync failed")) }
    const new_senders = setInterval(sync_new_senders, 10 * 60_000)
    new_senders.unref()
    server.addHook("onClose", async () => { clearInterval(deletions); clearInterval(new_senders) })
    await user_deletions_finish()
    sync_new_senders()

    await server.register(async app => {
        app.setErrorHandler(account_error_handler)
        app.addHook("preHandler", origin_check)

        interaction_routes(app, provider)
        web_session_routes(app)
        public_routes(app)

        app.register(async me => {
            me.addHook("preHandler", session_required)
            me_routes(me)
        })

        app.register(async admin => {
            admin.addHook("preHandler", admin_auth)
            admin_routes(admin)
        })
    })

    // Server-to-server, so outside the origin check; authenticated by HMAC over the raw body.
    await server.register(async hook => {
        hook.removeAllContentTypeParsers()
        hook.addContentTypeParser("*", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_request, body, done) => done(null, body))
        hook.post("/api/v2/account/stalwart/webhook", stalwart_webhook_handle)
    })

    scopelog.info(`Accounts enabled, issuer ${envs.OIDC_ISSUER}`)
}

// ---- OIDC INTERACTIONS (the /login page talks to these) ----

function interaction_routes(app: FastifyInstance, provider: Provider) {
    async function details(request: FastifyRequest, reply: FastifyReply) {
        const { uid } = request.params as { uid: string }
        const interaction = await provider.interactionDetails(request.raw, reply.raw).catch(() => null)
        if (!interaction || interaction.uid !== uid) throw new AccountError(400, "interaction_expired")
        return interaction
    }

    // The provider sends the browser here; the login form itself is the SvelteKit /login page.
    app.get(`${OIDC_PREFIX}/interaction/:uid`, async (request, reply) => {
        reply.header("Cache-Control", "no-store")
        const interaction = await provider.interactionDetails(request.raw, reply.raw).catch(() => null)
        if (!interaction) return reply.redirect("/login?error=expired")
        if (interaction.prompt.name === "login") return reply.redirect(`/login?uid=${encodeURIComponent(interaction.uid)}`)

        // consent: every client is ours, so grant what was asked (grant_load_or_create normally
        // makes this prompt unreachable)
        const grant = interaction.grantId
            ? await provider.Grant.find(interaction.grantId)
            : new provider.Grant({ accountId: interaction.session!.accountId, clientId: interaction.params.client_id as string })
        if (!grant) return reply.redirect("/login?error=expired")
        grant.addOIDCScope(typeof interaction.params.scope === "string" ? interaction.params.scope : "openid")
        const grantId = await grant.save()
        reply.hijack()
        await provider.interactionFinished(request.raw, reply.raw, { consent: { grantId } }, { mergeWithLastSubmission: true })
    })

    app.post(`${OIDC_PREFIX}/interaction/:uid/login`, async (request, reply) => {
        reply.header("Cache-Control", "no-store")
        const interaction = await details(request, reply)
        if (interaction.prompt.name !== "login") throw new AccountError(400, "interaction_expired")
        limit_check(login_ip_limit, request.ip, reply)

        const input = body_parse(LoginSchema, request.body)
        const user_key = `user:${username_normalize(input.username)}`
        limit_check(login_user_limit, user_key, reply)

        const user = await user_login_verify(input.username, input.password)
        if (!user) {
            log_block("Account login", request.ip, login_ip_limit.register_failure(request.ip), request)
            log_block("Account login", user_key, login_user_limit.register_failure(user_key), request)
            throw new AccountError(401, "credentials_invalid")
        }
        // the IP counter isn't cleared: one real account must not reset an attacker's guesses
        login_user_limit.clear(user_key)
        scopelog.info(`Login: ${user.username} from ${request.ip}`)
        const redirect = await provider.interactionResult(request.raw, reply.raw,
            { login: { accountId: user.id_user } }, { mergeWithLastSubmission: false })
        return { redirect }
    })

    app.post(`${OIDC_PREFIX}/interaction/:uid/abort`, async (request, reply) => {
        reply.header("Cache-Control", "no-store")
        await details(request, reply)
        const redirect = await provider.interactionResult(request.raw, reply.raw,
            { error: "access_denied", error_description: "The user cancelled the sign-in" }, { mergeWithLastSubmission: false })
        return { redirect }
    })
}

// ---- PUBLIC: requests, invites, signup ----

function public_routes(app: FastifyInstance) {
    app.post("/api/v2/account/request", async (request, reply) => {
        const input = body_parse(AccountRequestCreateSchema, request.body)
        // honeypot: bots fill every field; answer like a success so they don't adapt
        if (input.website !== "") {
            scopelog.warn(`Access request honeypot hit from ${request.ip}`)
            return reply.status(202).send({ ok: true })
        }
        email_normalize(input.email)
        limit_count(request_ip_limit, request.ip, reply)
        await request_create({ email: input.email, note: input.note }, issuer_of(request))
        return reply.status(202).send({ ok: true })
    })

    async function invite_or_fail(code: string, request: FastifyRequest, reply: FastifyReply) {
        limit_check(invite_ip_limit, request.ip, reply)
        const invite = await invite_find_usable(code)
        if (!invite) {
            log_block("Invite guessing", request.ip, invite_ip_limit.register_failure(request.ip), request)
            throw new AccountError(404, "invite_invalid")
        }
        return invite
    }

    app.get("/api/v2/account/invite/:code", async (request, reply) => {
        reply.header("Cache-Control", "no-store")
        const { code } = request.params as { code: string }
        const invite = await invite_or_fail(code, request, reply)
        return { valid: true, email: invite.email, expires: invite.expires }
    })

    app.get("/api/v2/account/available", async (request, reply) => {
        reply.header("Cache-Control", "no-store")
        const { name, invite } = request.query as { name?: string, invite?: string }
        if (typeof name !== "string" || typeof invite !== "string") throw new AccountError(400, "invalid_query")
        await invite_or_fail(invite, request, reply)
        limit_count(available_ip_limit, request.ip, reply)
        const username = username_normalize(name)
        const problem = username_problem(username)
        if (problem) return { username, available: false, reason: problem }
        if (await username_taken(username)) return { username, available: false, reason: "taken" }
        return { username, available: true }
    })

    app.post("/api/v2/account/signup/email-code", async (request, reply) => {
        const input = body_parse(SignupEmailCodeSchema, request.body)
        await invite_or_fail(input.invite, request, reply)
        limit_count(code_ip_limit, request.ip, reply)
        const result = await signup_email_code(input.invite, input.address)
        return code_reply(result, reply)
    })

    app.post("/api/v2/account/signup", async (request, reply) => {
        const input = body_parse(SignupSchema, request.body)
        await invite_or_fail(input.invite, request, reply)
        const created = await signup(input)
        return reply.status(201).send(created)
    })
}

function code_reply(result: Awaited<ReturnType<typeof signup_email_code>>, reply: FastifyReply) {
    if ("verified" in result) return { verified: true }
    if (result.ok) return { sent: true, cooldown_s: result.cooldown_s }
    reply.header("Retry-After", String(result.retry_after_s))
    throw new AccountError(429, result.reason === "cooldown" ? "code_cooldown" : "code_limit", { retry_after_s: result.retry_after_s })
}

// ---- /account (femboyz-web session) ----

function me_routes(app: FastifyInstance) {
    const user_of = (request: FastifyRequest) => request.account_user!

    app.get("/api/v2/account/me", async request => me_view(user_of(request)))

    app.post("/api/v2/account/me/email", async (request, reply) => {
        const input = body_parse(EmailAddressSchema, request.body)
        limit_count(code_ip_limit, request.ip, reply)
        return code_reply(await me_email_send(user_of(request), input.address), reply)
    })

    app.post("/api/v2/account/me/email/verify", async request => {
        const input = body_parse(EmailVerifySchema, request.body)
        return me_email_verify(user_of(request), input.address, input.code)
    })

    app.delete("/api/v2/account/me/email", async (request, reply) => {
        const input = body_parse(PasswordConfirmSchema, request.body)
        limit_check(login_ip_limit, request.ip, reply)
        try {
            return await me_email_remove(user_of(request), input.password)
        } catch (err) {
            if (err instanceof AccountError && err.code === "password_wrong")
                log_block("Password confirm", request.ip, login_ip_limit.register_failure(request.ip), request)
            throw err
        }
    })

    app.patch("/api/v2/account/me/redirect", async request => {
        const input = body_parse(RedirectUpdateSchema, request.body)
        return me_redirect_update(user_of(request), input)
    })
}

// ---- ADMIN ----

function admin_routes(app: FastifyInstance) {
    app.get("/api/v2/admin/account/requests", async request => {
        const { status = "all" } = request.query as { status?: string }
        const parsed = z.enum(["pending", "approved", "rejected", "all"]).safeParse(status)
        if (!parsed.success) throw new AccountError(400, "invalid_query")
        return request_list(parsed.data)
    })

    app.post("/api/v2/admin/account/requests/:id/approve", async request => {
        const { id } = request.params as { id: string }
        return request_approve(id)
    })

    app.post("/api/v2/admin/account/requests/:id/reject", async request => {
        const { id } = request.params as { id: string }
        return request_reject(id)
    })

    app.get("/api/v2/admin/account/invites", async () => invite_list())

    app.post("/api/v2/admin/account/invites", async (request, reply) => {
        const input = body_parse(InviteCreateSchema, request.body)
        const { invite, link } = await invite_create({
            label: input.label,
            email: input.email,
            ...(input.quota_bytes !== undefined ? { quota_bytes: input.quota_bytes } : {}),
            ...(input.ttl_days !== undefined ? { ttl_days: input.ttl_days } : {})
        })
        const { code_hash: _, ...view } = invite
        return reply.status(201).send({ invite: { ...view, status: "active" }, link })
    })

    app.delete("/api/v2/admin/account/invites/:id", async request => {
        const { id } = request.params as { id: string }
        if (!await invite_revoke(id)) throw new AccountError(404, "not_found")
        return { revoked: true, id }
    })

    app.get("/api/v2/admin/account/users", async request => {
        const { search = "" } = request.query as { search?: string }
        return user_list(String(search).trim().slice(0, 100))
    })

    app.patch("/api/v2/admin/account/users/:id", async request => {
        const { id } = request.params as { id: string }
        return user_update(id, body_parse(UserUpdateSchema, request.body))
    })

    app.delete("/api/v2/admin/account/users/:id", async request => {
        const { id } = request.params as { id: string }
        if (!await user_delete(id)) throw new AccountError(404, "not_found")
        return { deleted: true, id }
    })
}

// ---- STALWART WEBHOOK (redirect bounces) ----

const BOUNCE_EVENTS = new Set(["delivery.dsn-perm-fail"])

export function webhook_signature_valid(body: string, signature: string | undefined, secret: string): boolean {
    if (!signature) return false
    const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64"))
    const supplied = Buffer.from(signature)
    return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

/** The local part of a femboyz.cloud address, or null for anything else. */
function local_part(address: unknown): string | null {
    if (typeof address !== "string") return null
    const lower = address.trim().replace(/^<|>$/g, "").toLowerCase()
    const suffix = `@${envs.MAIL_DOMAIN}`
    return lower.endsWith(suffix) ? lower.slice(0, -suffix.length) : null
}

function strings(value: unknown): string[] {
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
    return []
}

/** Bounces for redirected mail: envelope sender is the user's address, recipient their external one. */
export function webhook_bounces(payload: unknown): { username: string, recipient_key: string }[] {
    const events = (payload as { events?: unknown })?.events
    if (!Array.isArray(events)) return []
    const found: { username: string, recipient_key: string }[] = []
    for (const event of events as { type?: unknown, data?: Record<string, unknown> }[]) {
        if (typeof event?.type !== "string" || !BOUNCE_EVENTS.has(event.type) || !event.data) continue
        const username = local_part(event.data.from)
        if (!username) continue
        for (const recipient of strings(event.data.to)) found.push({ username, recipient_key: recipient.trim().replace(/^<|>$/g, "").toLowerCase() })
    }
    return found
}

async function stalwart_webhook_handle(request: FastifyRequest, reply: FastifyReply) {
    const secret = envs.STALWART_WEBHOOK_SECRET
    const body = typeof request.body === "string" ? request.body : ""
    const signature = request.headers["x-signature"]
    if (!secret || !webhook_signature_valid(body, typeof signature === "string" ? signature : undefined, secret)) {
        scopelog.warn(`Stalwart webhook with a bad signature from ${request.ip}`)
        return reply.status(401).send({ error: "bad_signature" })
    }
    scopelog.debug(`Stalwart webhook: ${body.slice(0, 4000)}`)
    let payload: unknown
    try { payload = JSON.parse(body) } catch { return reply.status(400).send({ error: "bad_request" }) }
    for (const bounce of webhook_bounces(payload))
        await redirect_bounce_register(bounce.username, bounce.recipient_key)
            .catch(err => errorFileLogger.error({ err }, `Failed to register a redirect bounce for ${bounce.username}`))
    return reply.status(204).send()
}
