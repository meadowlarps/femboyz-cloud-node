import * as z from "zod"

export const XMetaFilesSchema = z.object({
    type: z.literal("files"),
    is_public: z.boolean(),
    meta: z.object({
        title: z.string().max(255),             // Max title length
        desc: z.string().max(1024)              // Max description length
    }),
    files: z.array(z.object({
        filename: z.string().max(255),          // Max filename length for most filesystems
        sha256: z.string().length(64),          // SHA256 hash, 64 characters
        bytes: z.number().int().nonnegative()   // File size in bytes
    })).min(1).max(6)                           // 1 to 6 files allowed
})

export type XMetaFiles = z.infer<typeof XMetaFilesSchema>
