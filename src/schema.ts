import * as z from "zod"
import { envs } from "./config.js"

const maxFiles     = envs.MAX_FILE_COUNT_PER_UPLOAD     || 6
const maxFileSize  = envs.MAX_FILE_SIZE                 || Infinity
const minFileSize  = envs.MIN_FILE_SIZE                 || 0
const maxTitle     = envs.MAX_TITLE_LENGTH_PER_UPLOAD   || 255
const maxDesc      = envs.MAX_DESC_LENGTH_PER_UPLOAD    || 1024

export const XMetaFilesSchema = z.object({
    type: z.literal("files"),
    is_public: z.boolean(),
    meta: z.object({
        title: z.string().max(maxTitle),
        desc: z.string().max(maxDesc)
    }),
    files: z.array(z.object({
        filename: z.string().max(255),
        sha256: z.string().length(64),
        bytes: z.number().int().nonnegative().min(minFileSize).max(maxFileSize)
    })).min(1).max(maxFiles)
})

export type XMetaFiles = z.infer<typeof XMetaFilesSchema>
