import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import Provider, { errors, type Adapter, type AdapterPayload, type ClientMetadata, type Configuration, type KoaContextWithOIDC } from "oidc-provider"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { envs, site_origin } from "./config.js"
import { getDB } from "./database.js"
import { errorFileLogger, scope } from "./logger.js"
import { user_find_by_id, user_mail_address } from "./accounts.js"
import { oidc_jwk_generate } from "./oidckeygen.js"
import type { UserDB } from "./schema.js"

const scopelog = scope("oidc")

// The provider is mounted under the issuer's path, e.g. https://femboyz.cloud/oidc.
export const OIDC_PREFIX = "/oidc"
export const WEB_CLIENT_ID = "femboyz-web"
export const BULWARK_CLIENT_ID = "bulwark"
const WEB_SESSION_COOKIE = "fbz_session"
const WEB_AUTH_COOKIE = "fbz_auth"
const WEB_SESSION_PATH = "/api/v2/account/session"
const WEB_SESSION_DAYS = 14

// ---- SIGNING KEYS ----

type JwksFile = { keys: Record<string, unknown>[] }

/**
 * Loads the provider's signing keys; the first one signs. Generates an RS256 key on first
 * start. Rotation: put a new key first, keep the old one until its tokens have expired.
 */
export function oidc_jwks_load(path = envs.OIDC_JWKS_FILE): JwksFile {
    if (existsSync(path)) {
        const jwks = JSON.parse(readFileSync(path, "utf8")) as JwksFile
        if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error(`${path} has no keys`)
        return jwks
    }
    const jwks = { keys: [oidc_jwk_generate()] }
    writeFileSync(path, JSON.stringify(jwks, null, 2), { mode: 0o600, flag: "wx" })
    scopelog.warn(`Generated a new OIDC signing key in ${path}; back it up`)
    return jwks
}

// ---- MONGO ADAPTER ----

type OidcDocument = {
    _id: string
    model: string
    payload: AdapterPayload
    expiresAt?: Date
    uid?: string
    userCode?: string
    grantId?: string
}

// One collection for every model; documents are keyed "<Model>:<id>" and expire by TTL index.
class MongoAdapter implements Adapter {
    constructor(private model: string) {}

    private collection() {
        return getDB().collection<OidcDocument>(envs.MDB_COLLECTION_OIDC)
    }

    private key(id: string) {
        return `${this.model}:${id}`
    }

    private static live(document: OidcDocument | null): AdapterPayload | undefined {
        if (!document) return undefined
        // the TTL monitor runs once a minute, so check expiry here too
        if (document.expiresAt && document.expiresAt.getTime() <= Date.now()) return undefined
        return document.payload
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
        const document: Omit<OidcDocument, "_id"> = {
            model: this.model,
            payload,
            ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000) } : {}),
            ...(payload.uid ? { uid: payload.uid } : {}),
            ...(payload.userCode ? { userCode: payload.userCode } : {}),
            ...(payload.grantId ? { grantId: payload.grantId } : {})
        }
        await this.collection().replaceOne({ _id: this.key(id) }, document, { upsert: true })
    }

    async find(id: string) {
        return MongoAdapter.live(await this.collection().findOne({ _id: this.key(id) }))
    }

    async findByUid(uid: string) {
        return MongoAdapter.live(await this.collection().findOne({ model: this.model, uid }))
    }

    async findByUserCode(userCode: string) {
        return MongoAdapter.live(await this.collection().findOne({ model: this.model, userCode }))
    }

    async consume(id: string) {
        await this.collection().updateOne({ _id: this.key(id) }, { $set: { "payload.consumed": Math.floor(Date.now() / 1000) } })
    }

    async destroy(id: string) {
        await this.collection().deleteOne({ _id: this.key(id) })
    }

    async revokeByGrantId(grantId: string) {
        await this.collection().deleteMany({ grantId })
    }
}

// ---- PROVIDER ----

function account_claims(user: UserDB) {
    return {
        sub: user.id_user,
        preferred_username: user.username,
        name: user.username,
        email: user_mail_address(user),
        email_verified: true
    }
}

function html_page(title: string, body: string): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
        + `<title>${title} · femboyz.cloud</title><style>body{margin:0;padding:3rem 1.5rem;background:#060606;color:#fff0f3;`
        + `font-family:Inter,system-ui,sans-serif}main{max-width:28rem;margin:0 auto}a{color:#c30f45}`
        + `button{padding:.75rem 1rem;color:#fff;background:#c30f45;border:0;font:inherit;font-weight:700;cursor:pointer}</style></head>`
        + `<body><main>${body}</main></body></html>`
}

function escape_html(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function clients(): ClientMetadata[] {
    const list: ClientMetadata[] = []
    if (envs.OIDC_CLIENT_WEB_SECRET) list.push({
        client_id: WEB_CLIENT_ID,
        client_secret: envs.OIDC_CLIENT_WEB_SECRET,
        redirect_uris: [`${site_origin()}${WEB_SESSION_PATH}/callback`],
        post_logout_redirect_uris: [`${site_origin()}/`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic"
    })
    if (envs.OIDC_CLIENT_BULWARK_SECRET) list.push({
        client_id: BULWARK_CLIENT_ID,
        client_secret: envs.OIDC_CLIENT_BULWARK_SECRET,
        redirect_uris: envs.OIDC_CLIENT_BULWARK_REDIRECT_URIS,
        post_logout_redirect_uris: envs.OIDC_CLIENT_BULWARK_LOGOUT_URIS.length > 0 ? envs.OIDC_CLIENT_BULWARK_LOGOUT_URIS : [`${site_origin()}/`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic"
    })
    return list
}

// Every client is first-party, so nobody is asked for consent: the grant is written here.
async function grant_load_or_create(ctx: KoaContextWithOIDC) {
    const { client, session, params } = ctx.oidc
    const account_id = session?.accountId
    if (!client || !session || !account_id) return undefined
    const existing_id = ctx.oidc.result?.consent?.grantId ?? session.grantIdFor(client.clientId)
    const grant = (existing_id ? await ctx.oidc.provider.Grant.find(existing_id) : undefined)
        ?? new ctx.oidc.provider.Grant({ clientId: client.clientId, accountId: account_id })
    const requested = typeof params?.scope === "string" ? params.scope : "openid"
    grant.addOIDCScope(requested)
    if (client.clientId === BULWARK_CLIENT_ID) grant.addResourceScope(envs.STALWART_RESOURCE, requested)
    await grant.save()
    return grant
}

export function oidc_provider_create(): Provider {
    if (!envs.OIDC_ISSUER) throw new Error("OIDC_ISSUER is not configured")
    if (envs.OIDC_COOKIE_KEYS.length === 0) throw new Error("OIDC_COOKIE_KEYS is not configured")

    const configuration: Configuration = {
        adapter: MongoAdapter,
        clients: clients(),
        jwks: oidc_jwks_load() as Configuration["jwks"],
        cookies: {
            keys: envs.OIDC_COOKIE_KEYS,
            long: { signed: true, httpOnly: true, sameSite: "lax" },
            short: { signed: true, httpOnly: true, sameSite: "lax" }
        },
        async findAccount(_ctx, sub) {
            const user = await user_find_by_id(sub)
            if (!user || user.status !== "active") return undefined
            return { accountId: sub, claims: async () => account_claims(user) }
        },
        claims: {
            openid: ["sub"],
            email: ["email", "email_verified"],
            profile: ["preferred_username", "name"]
        },
        scopes: ["openid", "email", "profile", "offline_access"],
        pkce: { required: () => true },
        interactions: { url: (_ctx, interaction) => `${OIDC_PREFIX}/interaction/${interaction.uid}` },
        loadExistingGrant: grant_load_or_create,
        features: {
            devInteractions: { enabled: false },
            revocation: { enabled: true },
            rpInitiatedLogout: {
                enabled: true,
                async logoutSource(ctx, form) {
                    // one click less: the confirm form submits itself
                    ctx.body = html_page("Signing out", `<p>Signing out…</p>${form.replace("<form", `<form id="op.logoutForm"`)}`
                        + `<noscript><button form="op.logoutForm" name="logout" value="yes">Sign out</button></noscript>`
                        + `<script>var f=document.getElementById("op.logoutForm");var i=document.createElement("input");`
                        + `i.type="hidden";i.name="logout";i.value="yes";f.appendChild(i);f.submit()</script>`)
                },
                async postLogoutSuccessSource(ctx) {
                    ctx.body = html_page("Signed out", `<h1>Signed out</h1><p><a href="${escape_html(site_origin())}/">Back to femboyz.cloud</a></p>`)
                }
            },
            resourceIndicators: {
                enabled: true,
                defaultResource: (ctx, client) => client.clientId === BULWARK_CLIENT_ID ? envs.STALWART_RESOURCE : undefined,
                useGrantedResource: () => true,
                getResourceServerInfo(_ctx, resource, client) {
                    if (resource !== envs.STALWART_RESOURCE || client.clientId !== BULWARK_CLIENT_ID)
                        throw new errors.InvalidTarget()
                    // Stalwart's OIDC directory checks aud=stalwart and the openid + email scopes
                    return {
                        scope: "openid email profile offline_access",
                        audience: "stalwart",
                        accessTokenFormat: "jwt",
                        accessTokenTTL: 10 * 60,
                        jwt: { sign: { alg: "RS256" } }
                    }
                }
            }
        },
        // Stalwart reads the username from the token, so it never has to call userinfo.
        async extraTokenClaims(_ctx, token) {
            if (!("accountId" in token) || typeof token.accountId !== "string") return undefined
            const user = await user_find_by_id(token.accountId)
            if (!user) return undefined
            const { sub: _, ...claims } = account_claims(user)
            return claims
        },
        // offline_access only survives with prompt=consent, which clients don't send to a provider
        // that never asks. Refresh tokens still end with the provider session (expiresWithSession).
        issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
        ttl: {
            AccessToken: 10 * 60,
            AuthorizationCode: 60,
            IdToken: 60 * 60,
            Interaction: 60 * 60,
            Session: 30 * 86_400,
            Grant: 30 * 86_400,
            RefreshToken: 30 * 86_400
        },
        clientBasedCORS: () => false,
        async renderError(ctx, out) {
            ctx.type = "html"
            const reason = typeof out.error_description === "string" ? out.error_description : String(out.error)
            ctx.body = html_page("Sign-in error", `<h1>Something went wrong</h1><p>${escape_html(reason)}</p>`
                + `<p><a href="${escape_html(site_origin())}/login">Try signing in again</a></p>`)
        }
    }

    const provider = new Provider(envs.OIDC_ISSUER, configuration)
    provider.proxy = true                                   // nginx sets X-Forwarded-Proto
    provider.on("server_error", (_ctx, err) => {
        scopelog.error(`OIDC server error: ${err.message}`)
        errorFileLogger.error({ err }, "OIDC server error")
    })
    return provider
}

/**
 * Hands every /oidc/* request except our interaction routes to oidc-provider. Runs in
 * onRequest, before Fastify reads the body, so the provider gets the untouched stream.
 */
export function oidc_mount(server: FastifyInstance, provider: Provider) {
    const callback = provider.callback()
    const issuer = new URL(envs.OIDC_ISSUER!)
    server.addHook("onRequest", async (request, reply) => {
        const url = request.raw.url ?? "/"
        if (url !== OIDC_PREFIX && !url.startsWith(`${OIDC_PREFIX}/`) && !url.startsWith(`${OIDC_PREFIX}?`)) return
        if (url.startsWith(`${OIDC_PREFIX}/interaction/`)) return
        reply.hijack()
        // The provider builds endpoint URLs from the request (provider.proxy trusts X-Forwarded-*).
        // Nginx passes a client's X-Forwarded-Host through, so pin both to the issuer.
        request.raw.headers["x-forwarded-host"] = issuer.host
        request.raw.headers["x-forwarded-proto"] = issuer.protocol.slice(0, -1)
        // like Express's app.use("/oidc", ...): the provider derives its mount path from originalUrl
        Object.assign(request.raw, { originalUrl: url })
        request.raw.url = url.slice(OIDC_PREFIX.length) || "/"
        callback(request.raw, reply.raw)
    })
}

// ---- femboyz-web: the site's own session (an ordinary OIDC client of the provider) ----

export type WebSessionDB = {
    token_hash: string
    id_user: string
    sid: string | null
    created: Date
    expires: Date
}

function web_sessions() {
    return getDB().collection<WebSessionDB>(envs.MDB_COLLECTION_WEB_SESSIONS)
}

export function cookies_parse(header: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {}
    for (const part of (header ?? "").split(";")) {
        const index = part.indexOf("=")
        if (index <= 0) continue
        const name = part.slice(0, index).trim()
        const value = part.slice(index + 1).trim()
        try { cookies[name] ??= decodeURIComponent(value) } catch { /* malformed, skip */ }
    }
    return cookies
}

function cookie(name: string, value: string, options: { path: string, max_age: number }): string {
    const secure = site_origin().startsWith("https:") ? "; Secure" : ""
    return `${name}=${encodeURIComponent(value)}; Path=${options.path}; Max-Age=${options.max_age}; HttpOnly; SameSite=Lax${secure}`
}

function sign(value: string): string {
    const mac = createHmac("sha256", envs.OIDC_COOKIE_KEYS[0]!).update(value).digest("base64url")
    return `${value}.${mac}`
}

function unsign(signed: string): string | null {
    const index = signed.lastIndexOf(".")
    if (index <= 0) return null
    const value = signed.slice(0, index)
    const expected = Buffer.from(sign(value))
    const supplied = Buffer.from(signed)
    return expected.length === supplied.length && timingSafeEqual(expected, supplied) ? value : null
}

function token_hash(token: string): string {
    return createHash("sha256").update(token).digest("hex")
}

/** The active user behind the request's femboyz.cloud session cookie, or null. */
export async function web_session_user(request: FastifyRequest): Promise<UserDB | null> {
    const token = cookies_parse(request.headers.cookie)[WEB_SESSION_COOKIE]
    if (!token) return null
    const session = await web_sessions().findOne({ token_hash: token_hash(token), expires: { $gt: new Date() } })
    if (!session) return null
    const user = await user_find_by_id(session.id_user)
    return user?.status === "active" ? user : null
}

function safe_return(value: unknown): string {
    // only same-site paths, never "//host" or "/\host"
    return typeof value === "string" && /^\/(?![\/\\])[\x21-\x7e]*$/.test(value) ? value : "/account"
}

async function session_start(request: FastifyRequest, reply: FastifyReply) {
    const { return: return_to } = request.query as { return?: string }
    const state = randomBytes(16).toString("base64url")
    const nonce = randomBytes(16).toString("base64url")
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const pending = JSON.stringify({ state, nonce, verifier, return: safe_return(return_to) })

    const url = new URL(`${envs.OIDC_ISSUER}/auth`)
    url.search = new URLSearchParams({
        client_id: WEB_CLIENT_ID,
        response_type: "code",
        scope: "openid",
        redirect_uri: `${site_origin()}${WEB_SESSION_PATH}/callback`,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256"
    }).toString()

    reply
        .header("Cache-Control", "no-store")
        .header("Set-Cookie", cookie(WEB_AUTH_COOKIE, sign(Buffer.from(pending).toString("base64url")), { path: WEB_SESSION_PATH, max_age: 600 }))
        .redirect(url.toString())
}

function jwt_payload(jwt: string): Record<string, unknown> | null {
    try { return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) }
    catch { return null }
}

async function session_callback(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store")
    const query = request.query as { code?: string, state?: string, error?: string }
    const signed = cookies_parse(request.headers.cookie)[WEB_AUTH_COOKIE]
    const raw = signed ? unsign(signed) : null
    const pending = raw ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { state: string, nonce: string, verifier: string, return: string } : null
    const clear = cookie(WEB_AUTH_COOKIE, "", { path: WEB_SESSION_PATH, max_age: 0 })

    if (!pending || !query.state || query.state !== pending.state || !query.code)
        return reply.header("Set-Cookie", clear).redirect(query.error === "access_denied" ? "/" : "/login?error=session")

    // The code goes straight back to our own token endpoint over loopback, so the ID token in the
    // answer is trusted as is (OIDC Core 3.1.3.7: TLS-protected direct channel).
    let token_response: Response
    try {
        token_response = await fetch(`http://127.0.0.1:${envs.PORT}${OIDC_PREFIX}/token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization: `Basic ${Buffer.from(`${WEB_CLIENT_ID}:${envs.OIDC_CLIENT_WEB_SECRET}`).toString("base64")}`,
                "X-Forwarded-Proto": new URL(site_origin()).protocol.replace(":", "")
            },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: query.code,
                redirect_uri: `${site_origin()}${WEB_SESSION_PATH}/callback`,
                code_verifier: pending.verifier
            }),
            signal: AbortSignal.timeout(10_000)
        })
    } catch (err) {
        errorFileLogger.error({ err }, "femboyz-web token exchange failed")
        return reply.header("Set-Cookie", clear).redirect("/login?error=session")
    }
    const tokens = await token_response.json().catch(() => ({})) as { id_token?: string }
    const claims = token_response.ok && tokens.id_token ? jwt_payload(tokens.id_token) : null
    if (!claims || claims.nonce !== pending.nonce || claims.aud !== WEB_CLIENT_ID || claims.iss !== envs.OIDC_ISSUER || typeof claims.sub !== "string") {
        scopelog.warn(`femboyz-web callback rejected (${token_response.status})`)
        return reply.header("Set-Cookie", clear).redirect("/login?error=session")
    }

    const token = randomBytes(32).toString("base64url")
    const now = Date.now()
    await web_sessions().insertOne({
        token_hash: token_hash(token),
        id_user: claims.sub,
        sid: typeof claims.sid === "string" ? claims.sid : null,
        created: new Date(now),
        expires: new Date(now + WEB_SESSION_DAYS * 86_400_000)
    })
    reply.header("Set-Cookie", [
        clear,
        cookie(WEB_SESSION_COOKIE, token, { path: "/", max_age: WEB_SESSION_DAYS * 86_400 })
    ])
    return reply.redirect(pending.return)
}

/** Ends the site session; the client then follows `redirect` to end the provider session too. */
async function session_logout(request: FastifyRequest, reply: FastifyReply) {
    const token = cookies_parse(request.headers.cookie)[WEB_SESSION_COOKIE]
    if (token) await web_sessions().deleteOne({ token_hash: token_hash(token) })
    const end = new URL(`${envs.OIDC_ISSUER}/session/end`)
    end.search = new URLSearchParams({ client_id: WEB_CLIENT_ID, post_logout_redirect_uri: `${site_origin()}/` }).toString()
    reply
        .header("Cache-Control", "no-store")
        .header("Set-Cookie", cookie(WEB_SESSION_COOKIE, "", { path: "/", max_age: 0 }))
        .send({ redirect: end.toString() })
}

export function web_session_routes(server: FastifyInstance) {
    server.get(`${WEB_SESSION_PATH}/start`, session_start)
    server.get(`${WEB_SESSION_PATH}/callback`, session_callback)
    server.post(`${WEB_SESSION_PATH}/logout`, session_logout)
}

// exported for tests
export const _internal = { safe_return, sign, unsign }
