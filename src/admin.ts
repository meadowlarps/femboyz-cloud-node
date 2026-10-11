import { createHash, timingSafeEqual } from "node:crypto"
import type { Document } from "mongodb"
import * as z from "zod"
import { envs } from "./config.js"
import { authlimit_create } from "./authlimit.js"

const AdminQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(200).default(""),
    type: z.enum(["all", "files", "album", "playlist", "link"]).default("all"),
    sort: z.enum(["newest", "oldest", "largest", "smallest"]).default("newest")
})

export type AdminQuery = z.infer<typeof AdminQuerySchema>

export function adminAuthStatus(authorization: string | undefined, expectedKey: string | undefined): 200 | 401 | 503 {
    if (!expectedKey) return 503
    if (!authorization?.startsWith("Bearer ")) return 401

    const suppliedHash = createHash("sha256").update(authorization.slice(7)).digest()
    const expectedHash = createHash("sha256").update(expectedKey).digest()
    return timingSafeEqual(suppliedHash, expectedHash) ? 200 : 401
}

const adminAuthLimit = authlimit_create({
    max_fails: () => envs.AUTH_ADMIN_MAX_FAILS,
    block_ms: () => envs.AUTH_ADMIN_BLOCK_MINUTES * 60_000
})

export function authBlockRemainingMs(ip: string, now = Date.now()): number {
    return adminAuthLimit.block_remaining_ms(ip, now)
}

export function registerAuthFailure(ip: string, now = Date.now()): { blocked: boolean, blockedUntil: number } {
    return adminAuthLimit.register_failure(ip, now)
}

export function clearAuthFailures(ip: string) {
    adminAuthLimit.clear(ip)
}

// test-only: drop all tracked IPs so cases start from a clean map
export function _resetAuthFailures() {
    adminAuthLimit._reset()
}

export function parseAdminQuery(value: unknown): AdminQuery {
    const result = AdminQuerySchema.safeParse(value)
    if (!result.success)
        throw Object.assign(new Error("Invalid admin query"), { statusCode: 400 })
    return result.data
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function buildAdminPipeline(query: AdminQuery): Document[] {
    const match: Document = {}
    if (query.type !== "all") match.type = query.type
    if (query.search) {
        const search = { $regex: escapeRegExp(query.search), $options: "i" }
        match.$or = [
            { "issuer.ip": search },
            { "issuer.uuid": search },
            { "issuer.ua": search },
            { "issuer.token": search },
            { id_pub: search },
            { "meta.title": search }
        ]
    }

    const sort: Document = query.sort === "oldest" ? { when: 1, id_pub: 1 }
        : query.sort === "largest" ? { totalSize: -1, id_pub: 1 }
        : query.sort === "smallest" ? { totalSize: 1, id_pub: 1 }
        : { when: -1, id_pub: 1 }

    return [
        {
            $set: {
                fileCount: { $size: { $ifNull: ["$files", []] } },
                totalSize: {
                    $sum: {
                        $map: {
                            input: { $ifNull: ["$files", []] },
                            as: "file",
                            in: { $ifNull: ["$$file.size", 0] }
                        }
                    }
                }
            }
        },
        {
            $facet: {
                items: [
                    { $match: match },
                    { $sort: sort },
                    { $skip: (query.page - 1) * query.limit },
                    { $limit: query.limit }
                ],
                matched: [{ $match: match }, { $count: "count" }],
                total: [{ $count: "count" }]
            }
        }
    ]
}

export async function cleanupUnreferencedFiles(
    hashes: Iterable<string>,
    isReferenced: (hash: string) => Promise<boolean>,
    deleteBlob: (hash: string) => Promise<number>
) {
    let reclaimedBytes = 0
    let sharedFilesKept = 0
    const failures: { hash: string, error: unknown }[] = []

    for (const hash of new Set(hashes)) {
        try {
            if (await isReferenced(hash)) sharedFilesKept++
            else reclaimedBytes += await deleteBlob(hash)
        } catch (error) {
            failures.push({ hash, error })
        }
    }

    return { reclaimedBytes, sharedFilesKept, failures }
}

let storageMutationQueue = Promise.resolve()

// ponytail: one process-wide lock matches today's single API process; use durable refcounts before horizontal scaling.
export function withStorageMutationLock<T>(work: () => Promise<T>): Promise<T> {
    const result = storageMutationQueue.then(work)
    storageMutationQueue = result.then(() => undefined, () => undefined)
    return result
}
