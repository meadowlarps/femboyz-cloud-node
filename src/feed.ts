import * as z from "zod"
import { envs } from "./config.js"
import { getDB } from "./database.js"
import { scope } from "./logger.js"
import { StorageDBUploadInstanceSchema, type StorageDBUploadInstance } from "./schema.js"
import { shutdownUnexpectedly } from "./utils.js"

const scopelog = scope("feed")
const FEED_DEFAULT_RANGE_SIZE = 20
const FEED_MAX_RANGE_SIZE = 100
const FEED_QUERY_SCHEMA = z.object({
    s: z.coerce.number().int().nonnegative().default(0),
    e: z.coerce.number().int().positive().optional()
}).transform(query => ({
    start: query.s,
    end: query.e ?? query.s + FEED_DEFAULT_RANGE_SIZE
})).refine(range =>
    Number.isSafeInteger(range.end)
    && range.end > range.start
    && range.end - range.start <= FEED_MAX_RANGE_SIZE
)

export type FeedQueryRange = z.infer<typeof FEED_QUERY_SCHEMA>
let uploads: StorageDBUploadInstance[] = []

export async function feed_init(): Promise<void> {
    try {
        const documents = await getDB()
            .collection(envs.MDB_COLLECTION_UPLOADS)
            .find({ public: true }, { projection: { _id: 0 } })
            .sort({ when: -1, id_pub: 1 })
            .toArray()

        uploads = documents.map(document => StorageDBUploadInstanceSchema.parse(document))
        scopelog.info(`Loaded ${uploads.length} public upload(s)`)
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        scopelog.error(`Failed to initialize public feed: ${message}`)
        shutdownUnexpectedly()
    }
}

export function feed_query_parse(value: unknown): FeedQueryRange {
    const result = FEED_QUERY_SCHEMA.safeParse(value)
    if (!result.success)
        throw Object.assign(new Error("Invalid feed query"), { statusCode: 400 })
    return result.data
}

export function feed_get_all_uploads(): readonly StorageDBUploadInstance[] {
    return uploads
}

export async function feed_update_upload(id: string): Promise<void> {
    const document = await getDB()
        .collection(envs.MDB_COLLECTION_UPLOADS)
        .findOne({ id_pub: id }, { projection: { _id: 0 } })
        .catch(err => {
            const message = err instanceof Error ? err.message : String(err)
            scopelog.error(`Failed to refresh upload ${id}: ${message}`)
            throw Object.assign(new Error("Database error"), { statusCode: 500 })
        })

    if (!document) {
        feed_upload_remove(id)
        return
    }

    const result = StorageDBUploadInstanceSchema.safeParse(document)
    if (!result.success) {
        scopelog.error(`Invalid document for ID ${id}: ${JSON.stringify(result.error.issues)}`)
        throw Object.assign(new Error("Corrupt upload document"), { statusCode: 500 })
    }

    feed_upload_remove(id)
    feed_upload_add(result.data)
}

export function feed_upload_add(upload: StorageDBUploadInstance): void {
    if (!upload.public) return

    const index = uploads.findIndex(existing =>
        existing.when < upload.when
        || (existing.when === upload.when && existing.id_pub > upload.id_pub)
    )
    if (index === -1) uploads.push(upload)
    else uploads.splice(index, 0, upload)
}

export function feed_upload_remove(id: string): void {
    const index = uploads.findIndex(upload => upload.id_pub === id)
    if (index !== -1) uploads.splice(index, 1)
}
