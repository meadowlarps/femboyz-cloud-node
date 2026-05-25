import * as z from "zod"
import { envs } from "./config.js"

const maxFiles     = envs.MAX_FILE_COUNT_PER_UPLOAD     || 6
const minFileSize  = envs.MIN_FILE_SIZE                 || 0
const maxTitle     = envs.MAX_TITLE_LENGTH_PER_UPLOAD   || 255
const maxDesc      = envs.MAX_DESC_LENGTH_PER_UPLOAD    || 1024

// schema/frontend_file_upload.info
export const XMetaFilesSchema = z.object({
    type: z.literal("files"),
    is_public: z.boolean(),
    meta: z.object({
        title: z.string().max(maxTitle),
        desc: z.string().max(maxDesc)
    }),
    files: z.array(z.object({
        filename: z.string().max(255).nonempty(),
        sha256: z.string().length(64),
        bytes: z.number().int().nonnegative().min(minFileSize)
    })).min(1).max(maxFiles)
})

export type XMetaFiles = z.infer<typeof XMetaFilesSchema>

// schema/mongo_upload.info
const storageDBUploadInstanceSchemaCommon = z.object({
    id_pub: z.string().min(8).max(10),
    public: z.boolean().default(false),
    status: z.enum(["processing", "ready", "error", "removed"]).default("processing"),
    meta: z.object({ title: z.string().default(""), desc: z.string().default("") }),
    stat: z.object({ 
        views: z.number().int().nonnegative(), 
        up: z.number().int().nonnegative(), 
        down: z.number().int().nonnegative() }),
    issuer: z.object({ ip: z.string(), ua: z.string(), uuid: z.string() }),
    when: z.iso.datetime()
})

export const StorageDBUploadInstanceSchema = z.union([
    storageDBUploadInstanceSchemaCommon.extend({
        type: z.enum(["files", "album", "playlist"]),
        files: z.array(z.object({
            filename: z.string(),
            size: z.number().int().nonnegative(),
            mime: z.string(),
            hashkey256: z.string().length(64),
            stat_dl: z.number().int().nonnegative()
        })).min(1)
    }),
    storageDBUploadInstanceSchemaCommon.extend({
        type: z.literal("link"),
        link: z.object({ redir: z.url().nonoptional() })
    })
])

export type StorageDBUploadInstance = z.infer<typeof StorageDBUploadInstanceSchema>