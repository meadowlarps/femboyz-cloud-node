import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import { MongoMemoryServer } from "mongodb-memory-server"
import { MongoClient, type Db } from "mongodb"

const db_holder = vi.hoisted(() => ({ db: undefined as Db | undefined }))
vi.mock("../database.js", async importOriginal => ({
    ...await importOriginal<typeof import("../database.js")>(),
    getDB: () => db_holder.db
}))
vi.mock("../stalwart.js", async importOriginal => ({
    ...await importOriginal<typeof import("../stalwart.js")>(),
    stalwart_account_create: async ({ username }: { username: string }) => `sw-${username}`,
    stalwart_account_usage: async () => null
}))
vi.mock("../mailer.js", async importOriginal => ({
    ...await importOriginal<typeof import("../mailer.js")>(),
    mail_send: async () => {}
}))

async function free_port(): Promise<number> {
    return new Promise(resolve => {
        const probe = createServer().listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as { port: number }
            probe.close(() => resolve(port))
        })
    })
}

const PORT = await free_port()
const SITE = `http://127.0.0.1:${PORT}`
const BULWARK_SECRET = randomBytes(16).toString("hex")
const BULWARK_REDIRECT = "https://mail.femboyz.test/callback"

const { envs } = await import("../config.js")
Object.assign(envs, {
    PORT,
    OIDC_ISSUER: `${SITE}/oidc`,
    OIDC_JWKS_FILE: join(mkdtempSync(join(tmpdir(), "oidc-")), "jwks.json"),
    OIDC_COOKIE_KEYS: [randomBytes(16).toString("hex")],
    OIDC_CLIENT_WEB_SECRET: randomBytes(16).toString("hex"),
    OIDC_CLIENT_BULWARK_SECRET: BULWARK_SECRET,
    OIDC_CLIENT_BULWARK_REDIRECT_URIS: [BULWARK_REDIRECT],
    OIDC_CLIENT_BULWARK_LOGOUT_URIS: [],
    STALWART_RESOURCE: "https://mx.femboyz.test",
    EMAIL_CODE_SECRET: "x",
    ACCOUNT_LOGIN_MAX_FAILS: 3
})
const { account_indexes_ensure } = await import("../database.js")
const { invite_create, signup } = await import("../accounts.js")
const { account_routes_register } = await import("../accountApi.js")

let mongo: MongoMemoryServer
let client: MongoClient
let server: FastifyInstance
const PASSWORD = "a long and unusual passphrase"

beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    client = await MongoClient.connect(mongo.getUri())
    db_holder.db = client.db("oidc_test")
    await account_indexes_ensure(db_holder.db)
    server = Fastify({ trustProxy: "loopback" })
    await account_routes_register(server, async () => {})
    await server.listen({ port: PORT, host: "127.0.0.1" })
    const { link } = await invite_create({})
    await signup({ invite: new URL(link).searchParams.get("invite")!, username: "alice", password: PASSWORD })
}, 120_000)

afterAll(async () => {
    await server?.close()
    await client?.close()
    await mongo?.stop()
})

// A minimal browser: follows nothing by itself, keeps cookies.
function browser() {
    const jar = new Map<string, string>()
    return async (url: string, init: { method?: string, body?: unknown, origin?: string } = {}) => {
        const response = await fetch(new URL(url, SITE), {
            method: init.method ?? "GET",
            redirect: "manual",
            headers: {
                cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
                ...(init.body === undefined ? {} : { "content-type": "application/json", origin: init.origin ?? SITE })
            },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
        })
        for (const cookie of response.headers.getSetCookie()) {
            const [pair] = cookie.split(";")
            const index = pair!.indexOf("=")
            const name = pair!.slice(0, index)
            const value = pair!.slice(index + 1)
            if (value === "" || /max-age=0/i.test(cookie)) jar.delete(name)
            else jar.set(name, value)
        }
        return response
    }
}

async function authorize(go: ReturnType<typeof browser>) {
    const verifier = randomBytes(32).toString("base64url")
    const url = new URL(`${SITE}/oidc/auth`)
    url.search = new URLSearchParams({
        client_id: "bulwark", response_type: "code", scope: "openid email profile offline_access",
        redirect_uri: BULWARK_REDIRECT, state: "s", nonce: "n",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256"
    }).toString()
    let response = await go(url.toString())
    response = await go(response.headers.get("location")!)
    const login = new URL(response.headers.get("location")!, SITE)
    expect(login.pathname).toBe("/login")
    return { uid: login.searchParams.get("uid")!, verifier }
}

async function follow_to_client(go: ReturnType<typeof browser>, start: string) {
    let next = start
    for (let i = 0; i < 6 && !next.startsWith(BULWARK_REDIRECT); i++)
        next = (await go(next)).headers.get("location")!
    return new URL(next)
}

test("the bulwark client gets a Stalwart JWT with the username claims", async () => {
    const go = browser()
    const { uid, verifier } = await authorize(go)

    const bad = await go(`/oidc/interaction/${uid}/login`, { method: "POST", body: { username: "alice", password: "wrong wrong wrong" } })
    expect(bad.status).toBe(401)
    const foreign = await go(`/oidc/interaction/${uid}/login`, { method: "POST", body: { username: "alice", password: PASSWORD }, origin: "https://evil.test" })
    expect(foreign.status).toBe(403)

    const ok = await go(`/oidc/interaction/${uid}/login`, { method: "POST", body: { username: "Alice@femboyz.cloud", password: PASSWORD } })
    expect(ok.status).toBe(200)
    const callback = await follow_to_client(go, ((await ok.json()) as { redirect: string }).redirect)
    expect(callback.searchParams.get("state")).toBe("s")

    const token = await fetch(`${SITE}/oidc/token`, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(`bulwark:${BULWARK_SECRET}`).toString("base64")}`
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: BULWARK_REDIRECT, code_verifier: verifier })
    })
    expect(token.status).toBe(200)
    const tokens = await token.json() as { access_token: string, id_token: string, refresh_token?: string }
    const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1]!, "base64url").toString())
    expect(claims).toMatchObject({
        iss: `${SITE}/oidc`,
        aud: "stalwart",
        client_id: "bulwark",
        preferred_username: "alice",
        email: "alice@femboyz.cloud"
    })
    expect(claims.scope.split(" ")).toEqual(expect.arrayContaining(["openid", "email"]))
    expect(claims.exp - claims.iat).toBe(600)
    expect(tokens.refresh_token).toBeTruthy()

    const jwks = await (await fetch(`${SITE}/oidc/jwks`)).json() as { keys: Record<string, unknown>[] }
    expect(jwks.keys[0]).not.toHaveProperty("d")                   // public halves only
})

test("logins are rate limited per IP", async () => {
    const { login_ip_limit } = await import("../accountApi.js")
    login_ip_limit._reset()
    const go = browser()
    const { uid } = await authorize(go)
    const statuses = []
    for (let i = 0; i < 4; i++)
        statuses.push((await go(`/oidc/interaction/${uid}/login`, { method: "POST", body: { username: "nobody", password: "wrong wrong wrong" } })).status)
    // 3 failures allowed in this test config, the 4th attempt is refused before checking
    expect(statuses).toEqual([401, 401, 401, 429])
    const blocked = await go(`/oidc/interaction/${uid}/login`, { method: "POST", body: { username: "alice", password: PASSWORD } })
    expect(blocked.status).toBe(429)
    login_ip_limit._reset()
})

test("femboyz-web session: SSO into /account, then sign out", async () => {
    const go = browser()
    const { uid } = await authorize(go)
    const login = await go(`/oidc/interaction/${uid}/login`, { method: "POST", body: { username: "alice", password: PASSWORD } })
    await follow_to_client(go, ((await login.json()) as { redirect: string }).redirect)

    // signed in at the provider (as webmail would be), but no site session yet
    expect((await go("/api/v2/account/me")).status).toBe(401)
    let next = (await go("/api/v2/account/session/start?return=/account")).headers.get("location")!
    for (let i = 0; i < 8 && next !== "/account"; i++) next = (await go(next)).headers.get("location")!
    expect(next).toBe("/account")

    const me = await go("/api/v2/account/me")
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ username: "alice", email: "alice@femboyz.cloud", external_email: null })

    const logout = await go("/api/v2/account/session/logout", { method: "POST", body: {} })
    expect(((await logout.json()) as { redirect: string }).redirect).toContain("/oidc/session/end")
    expect((await go("/api/v2/account/me")).status).toBe(401)
})

test("a tampered session start state is refused", async () => {
    const go = browser()
    const response = await go("/api/v2/account/session/callback?code=x&state=forged")
    expect(response.headers.get("location")).toBe("/login?error=session")
})
