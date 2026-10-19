import { envs } from "./config.js"
import { errorFileLogger, scope } from "./logger.js"

const scopelog = scope("stalwart")

// Management calls run as the femboyz-api service account (API key). It holds the
// `impersonate` permission, which lets it manage Sieve scripts on user accounts.
const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve", "urn:stalwart:jmap"]
const REDIRECT_SCRIPT = "femboyz-redirect"
const TIMEOUT_MS = 15_000

type MethodCall = [string, Record<string, unknown>, string]
type MethodResponse = [string, Record<string, any>, string]

export class StalwartError extends Error {
    statusCode = 502
}

function fail(action: string, detail: unknown): never {
    const message = `Stalwart ${action} failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
    scopelog.error(message)
    errorFileLogger.error(message)
    throw new StalwartError(message)
}

async function http(path: string, init: RequestInit): Promise<any> {
    if (!envs.STALWART_URL || !envs.STALWART_API_KEY) fail("request", "STALWART_URL / STALWART_API_KEY not configured")
    let response: Response
    try {
        response = await fetch(`${envs.STALWART_URL}${path}`, {
            ...init,
            headers: { ...init.headers, Authorization: `Bearer ${envs.STALWART_API_KEY}` },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        })
    } catch (err) {
        fail(`request ${path}`, err instanceof Error ? err.message : String(err))
    }
    const text = await response.text()
    if (!response.ok) fail(`request ${path}`, `HTTP ${response.status} ${text.slice(0, 300)}`)
    try { return JSON.parse(text) }
    catch { fail(`request ${path}`, `invalid JSON: ${text.slice(0, 300)}`) }
}

async function jmap(action: string, calls: MethodCall[]): Promise<MethodResponse[]> {
    const body = await http("/jmap/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ using: USING, methodCalls: calls })
    })
    const responses = body.methodResponses as MethodResponse[] | undefined
    if (!Array.isArray(responses)) fail(action, body)
    for (const [name, result] of responses) {
        if (name === "error") fail(action, result)
        for (const key of ["notCreated", "notUpdated", "notDestroyed"])
            if (result[key] && Object.keys(result[key]).length > 0) fail(action, result[key])
    }
    return responses
}

let domain_id: string | undefined

async function domain_id_get(): Promise<string> {
    if (domain_id) return domain_id
    const [[, result]] = await jmap("domain lookup", [["x:Domain/get", { properties: ["name"] }, "d"]]) as [MethodResponse]
    const domain = (result.list as { id: string, name: string }[]).find(item => item.name === envs.MAIL_DOMAIN)
    if (!domain) fail("domain lookup", `domain ${envs.MAIL_DOMAIN} not found`)
    domain_id = domain.id
    return domain_id
}

// ---- ACCOUNTS ----

/** Creates the mailbox for a new femboyz account and returns its Stalwart id. */
export async function stalwart_account_create(input: { username: string, id_user: string, quota_bytes: number }): Promise<string> {
    const [[, result]] = await jmap(`create account ${input.username}`, [["x:Account/set", {
        create: {
            u: {
                "@type": "User",
                name: input.username,
                domainId: await domain_id_get(),
                description: "femboyz account",
                externalId: input.id_user,
                roles: { "@type": "User" },
                permissions: { "@type": "Inherit" },
                encryptionAtRest: { "@type": "Disabled" },
                quotas: { maxDiskQuota: input.quota_bytes }
            }
        }
    }, "c"]]) as [MethodResponse]
    const id = result.created?.u?.id
    if (typeof id !== "string") fail(`create account ${input.username}`, result)
    scopelog.info(`Created mailbox ${input.username}@${envs.MAIL_DOMAIN} (${id})`)
    return id
}

export async function stalwart_account_update(id: string, change: { enabled?: boolean, quota_bytes?: number }): Promise<void> {
    const patch: Record<string, unknown> = {}
    if (change.quota_bytes !== undefined) patch["quotas/maxDiskQuota"] = change.quota_bytes
    // Disabling withdraws the authenticate permission: every login and token is refused at once.
    if (change.enabled !== undefined) patch.permissions = change.enabled
        ? { "@type": "Inherit" }
        : { "@type": "Merge", enabledPermissions: {}, disabledPermissions: { authenticate: true } }
    if (Object.keys(patch).length === 0) return
    await jmap(`update account ${id}`, [["x:Account/set", { update: { [id]: patch } }, "u"]])
}

export async function stalwart_account_destroy(id: string): Promise<void> {
    await jmap(`destroy account ${id}`, [["x:Account/set", { destroy: [id] }, "d"]])
    scopelog.info(`Destroyed mailbox ${id}`)
}

export async function stalwart_account_usage(id: string): Promise<{ used_bytes: number, quota_bytes: number | null } | null> {
    const [[, result]] = await jmap(`usage of ${id}`, [["x:Account/get", { ids: [id], properties: ["usedDiskQuota", "quotas"] }, "g"]]) as [MethodResponse]
    const account = result.list?.[0]
    if (!account) return null
    return { used_bytes: Number(account.usedDiskQuota) || 0, quota_bytes: account.quotas?.maxDiskQuota ?? null }
}

// ---- REDIRECT (Sieve) ----

// Strict on purpose: the address is pasted into a Sieve string literal.
const SIEVE_SAFE_ADDRESS = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

export function sieve_redirect_script(address: string, keep_copy: boolean): string {
    if (!SIEVE_SAFE_ADDRESS.test(address)) throw Object.assign(new Error("Address not usable for redirect"), { statusCode: 400 })
    return [
        ...(keep_copy ? [`require ["copy"];`] : []),
        `# femboyz: managed by femboyz-cloud-node, edits are overwritten.`,
        ``,
        `# Never forward what the spam filter flagged. X-Spam-Status is only added at`,
        `# mailbox ingest, after Sieve runs; X-Spam-Score is set during SMTP DATA.`,
        `if header :matches "X-Spam-Score" "spam*" {`,
        `    stop;`,
        `}`,
        ``,
        keep_copy ? `redirect :copy "${address}";` : `redirect "${address}";`,
        ``
    ].join("\n")
}

/** Installs and activates the redirect script, or removes it when `script` is null. */
export async function stalwart_redirect_apply(account_id: string, script: string | null): Promise<void> {
    const [[, existing]] = await jmap(`list sieve of ${account_id}`, [["SieveScript/get", { accountId: account_id, properties: ["name", "isActive"] }, "g"]]) as [MethodResponse]
    const current = (existing.list as { id: string, name: string, isActive: boolean }[]).find(item => item.name === REDIRECT_SCRIPT)

    if (script === null) {
        if (!current) return
        await jmap(`remove redirect of ${account_id}`, [
            ["SieveScript/set", { accountId: account_id, ...(current.isActive ? { onSuccessDeactivateScript: true } : {}) }, "a"],
            ["SieveScript/set", { accountId: account_id, destroy: [current.id] }, "d"]
        ])
        scopelog.info(`Removed redirect of ${account_id}`)
        return
    }

    const blob = await http(`/jmap/upload/${encodeURIComponent(account_id)}/`, {
        method: "POST",
        headers: { "Content-Type": "application/sieve" },
        body: script
    })
    if (typeof blob.blobId !== "string") fail(`upload sieve of ${account_id}`, blob)

    const [[, validated]] = await jmap(`validate sieve of ${account_id}`, [["SieveScript/validate", { accountId: account_id, blobId: blob.blobId }, "v"]]) as [MethodResponse]
    if (validated.error) fail(`validate sieve of ${account_id}`, validated.error)

    const change = current
        ? { update: { [current.id]: { blobId: blob.blobId } }, onSuccessActivateScript: current.id }
        : { create: { s: { name: REDIRECT_SCRIPT, blobId: blob.blobId } }, onSuccessActivateScript: "#s" }
    await jmap(`set redirect of ${account_id}`, [["SieveScript/set", { accountId: account_id, ...change }, "s"]])
    scopelog.info(`Installed redirect for ${account_id}`)
}

// test-only: forget the cached domain id
export function _reset_stalwart_cache() {
    domain_id = undefined
}
