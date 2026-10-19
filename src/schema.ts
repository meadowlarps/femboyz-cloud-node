import * as z from "zod"
import { envs } from "./config.js"

const minFileSize  = envs.MIN_FILE_SIZE                 || 0
const maxTitle     = envs.MAX_TITLE_LENGTH_PER_UPLOAD   || 255
const maxDesc      = envs.MAX_DESC_LENGTH_PER_UPLOAD    || 1024
const maxComLen	   = envs.MAX_COMMENT_LENGTH						|| 500
const maxNote      = envs.MAX_NOTE_LENGTH               || 100_000

const COMMENT_ID_REGEX = /^\d{8}$/
const CLIENT_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const CommentIdSchema = z.string().regex(COMMENT_ID_REGEX)
export const ClientUuidSchema = z.string().regex(CLIENT_UUID_REGEX)

export const CommentReactionStateSchema = z.object({
	rating: z.enum(["up", "down"]).nullable(),
	eyes: z.boolean()
})

export const CommentReactionUpdateSchema = z.object({
	rating: z.enum(["up", "down"]).nullable(),
	eyes: z.boolean()
})

// schema/frontend_file_upload.md
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
    })).min(1)                                                  // count is checked against effective (token) limits in api preHandler
})

export type XMetaFiles = z.infer<typeof XMetaFilesSchema>

// schema/frontend_note_upload.md
export const NoteUploadSchema = z.object({
    type: z.literal("note"),
    is_public: z.boolean().default(false),
    meta: z.object({
        title: z.string().trim().max(maxTitle).default("")
    }).default({ title: "" }),
    text: z.string().max(maxNote).refine(text => text.trim() !== "", "Note is empty")
})

export type NoteUpload = z.infer<typeof NoteUploadSchema>

// schema/mongo_upload.md
const storageDBUploadInstanceSchemaCommon = z.object({
    id_pub: z.string().min(8).max(10),
    public: z.boolean().default(false),
    status: z.enum(["processing", "ready", "error", "removed"]).default("processing"),
    meta: z.object({ title: z.string().default(""), desc: z.string().default("") }),
    stat: z.object({ 
        views: z.number().int().nonnegative(), 
        up: z.number().int().nonnegative(), 
        down: z.number().int().nonnegative() }),
    issuer: z.object({ ip: z.string(), ua: z.string(), uuid: z.string(), token: z.string().optional() }),
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
    }),
    storageDBUploadInstanceSchemaCommon.extend({
        type: z.literal("note"),
        note: z.object({ text: z.string() })
    })
])

export const CommentInstanceSchemaDB = z.object({
    id_upload_pub:					z.string(),   										// pub id of the upload the comment connects to
    id_comment_pub:					CommentIdSchema,									// unique 8-digit comment id
		id_reply_to: 						CommentIdSchema.optional(),				// replies to id
		content: 								z.string().min(1).max(maxComLen),
		when:										z.iso.datetime(),
		stat:										z.object({
			up: 	z.int().nonnegative().default(0),
			down:	z.int().nonnegative().default(0),
			eyes: z.int().nonnegative().default(0)
		}),
		reactions:							z.record(ClientUuidSchema, CommentReactionStateSchema).optional(),
		issuer: 								z.object({
			ip: z.string(),
			ua: z.string(),
			uuid: ClientUuidSchema
		})
})

export const CommentCreateSchema = z.object({
    id_reply_to: CommentIdSchema.optional(),
    content:     z.string().trim().min(1).max(maxComLen)
})

export const CommentPublicSchema = z.object({
    id:          CommentIdSchema,                           // mapped from id_comment_pub
    id_reply_to: CommentIdSchema.optional(),
    content:     z.string(),
    when:        z.iso.datetime(),
    stat: z.object({
        up:   z.int().nonnegative(),
        down: z.int().nonnegative(),
				eyes: z.int().nonnegative()
    })
})

// schema/mongo_token.md
export const UPLOAD_TOKEN_REGEX = /^[A-Za-z0-9_-]{8,64}$/          // header-safe; generated tokens are 32-char base64url

export const UploadTokenLimitsSchema = z.object({
    max_files: z.int().positive().nullable(),                   // null = unlimited
    max_bytes: z.int().positive().nullable()                    // total bytes per upload, null = unlimited
})

export const UploadTokenSchemaDB = z.object({
    id_token:   z.string(),
    token:      z.string().regex(UPLOAD_TOKEN_REGEX),
    label:      z.string().max(100),
    limits:     UploadTokenLimitsSchema,
    uses_max:   z.int().positive().nullable(),                  // null = unlimited
    uses_count: z.int().nonnegative(),
    expires_at: z.iso.datetime().nullable(),
    revoked:    z.boolean(),
    when:       z.iso.datetime()
})

export const UploadTokenCreateSchema = z.object({
    token:      z.string().trim().regex(UPLOAD_TOKEN_REGEX).optional(),       // custom value, random when omitted
    label:      z.string().trim().max(100).default(""),
    limits:     UploadTokenLimitsSchema,
    uses_max:   z.int().positive().nullable().default(null),
    expires_at: z.iso.datetime().nullable().default(null)
})

export const UploadTokenUpdateSchema = z.object({
    label:      z.string().trim().max(100),
    limits:     UploadTokenLimitsSchema,
    uses_max:   z.int().positive().nullable(),
    expires_at: z.iso.datetime().nullable(),
    revoked:    z.boolean()
}).partial()

export const TokenUseSchemaDB = z.object({
    id_token:       z.string(),
    outcome:        z.enum(["ok", "failed", "rejected"]),
    reason:         z.string().optional(),
    id_upload_pub:  z.string().optional(),
    files:          z.int().nonnegative(),
    bytes:          z.int().nonnegative(),
    issuer:         z.object({ ip: z.string(), ua: z.string(), uuid: z.string() }),
    route:          z.string().optional(),                      // "GET /api/v2/maxfsize" etc.
    supplied:       z.string().optional(),                      // masked hint of an unknown token, see token_supplied_hint
    when:           z.iso.datetime()
})

export type StorageDBUploadInstance = z.infer<typeof StorageDBUploadInstanceSchema>
export type CommentInstanceDB = z.infer<typeof CommentInstanceSchemaDB>
export type CommentCreate = z.infer<typeof CommentCreateSchema>
export type CommentPublic = z.infer<typeof CommentPublicSchema>
export type CommentReactionState = z.infer<typeof CommentReactionStateSchema>
export type CommentReactionUpdate = z.infer<typeof CommentReactionUpdateSchema>
export type UploadTokenLimits = z.infer<typeof UploadTokenLimitsSchema>
export type UploadTokenDB = z.infer<typeof UploadTokenSchemaDB>
export type UploadTokenCreate = z.infer<typeof UploadTokenCreateSchema>
export type UploadTokenUpdate = z.infer<typeof UploadTokenUpdateSchema>
export type TokenUseDB = z.infer<typeof TokenUseSchemaDB>

// ---- femboyz accounts (MAIL_PLAN.md section 2) ----

// schema/mongo_user.md
export const ExternalEmailSchema = z.object({
    address:     z.string(),                                    // normalised: trimmed, domain lowercased
    key:         z.string(),                                    // address lowercased, unique across users
    verified_at: z.iso.datetime()
})

export const UserSchemaDB = z.object({
    id_user:        z.uuid(),                                   // OIDC `sub`, never changes
    username:       z.string(),                                 // lowercase, also the mail local part, immutable
    password_hash:  z.string(),                                 // argon2id PHC string
    external_email: ExternalEmailSchema.nullable(),
    status:         z.enum(["active", "disabled"]),
    created:        z.iso.datetime(),
    invite_id:      z.string().nullable(),
    services: z.object({
        mail: z.object({
            enabled:     z.boolean(),
            stalwart_id: z.string().nullable(),
            quota_bytes: z.int().positive(),
            redirect: z.object({
                enabled:   z.boolean(),
                keep_copy: z.boolean(),
                bounces:   z.int().nonnegative()
            })
        })
    })
})

// schema/mongo_account_request.md
export const AccountRequestSchemaDB = z.object({
    id:        z.string(),
    email:     z.string(),
    email_key: z.string(),                                      // lowercased, finds an earlier pending request
    note:      z.string(),
    issuer:    z.object({ ip: z.string(), ua: z.string() }),
    created:   z.iso.datetime(),
    status:    z.enum(["pending", "approved", "rejected"]),
    decided:   z.iso.datetime().nullable(),
    invite_id: z.string().nullable()
})

// schema/mongo_invite.md
export const InviteSchemaDB = z.object({
    id:             z.string(),
    code_hash:      z.string(),                                 // sha256 hex of the code in the link
    label:          z.string(),
    email:          z.string().nullable(),                      // request address, pre-verified at signup
    request_id:     z.string().nullable(),
    quota_bytes:    z.int().positive(),
    created:        z.iso.datetime(),
    expires:        z.iso.datetime(),
    reserved_until: z.iso.datetime().nullable(),                // held by a signup in progress
    used:           z.boolean(),
    used_by:        z.string().nullable(),                      // id_user
    used_at:        z.iso.datetime().nullable(),
    revoked:        z.boolean()
})

export const AccountRequestCreateSchema = z.object({
    email:   z.string().trim().max(254),
    note:    z.string().trim().max(1000).default(""),
    website: z.string().max(200).default("")                    // honeypot, must stay empty
})

export const SignupSchema = z.object({
    invite:   z.string().trim().min(1).max(100),
    username: z.string().trim().max(64),
    password: z.string().max(256),
    external_email: z.object({
        address: z.string().trim().max(254),
        code:    z.string().trim().max(8).optional()
    }).optional()
})

export const SignupEmailCodeSchema = z.object({
    invite:  z.string().trim().min(1).max(100),
    address: z.string().trim().max(254)
})

export const LoginSchema = z.object({
    username: z.string().trim().max(320),
    password: z.string().max(256)
})

export const EmailAddressSchema = z.object({ address: z.string().trim().max(254) })
export const EmailVerifySchema = z.object({ address: z.string().trim().max(254), code: z.string().trim().max(8) })
export const PasswordConfirmSchema = z.object({ password: z.string().max(256) })
export const RedirectUpdateSchema = z.object({ enabled: z.boolean(), keep_copy: z.boolean().default(true) })

export const InviteCreateSchema = z.object({
    label:       z.string().trim().max(100).default(""),
    email:       z.string().trim().max(254).nullable().default(null),
    quota_bytes: z.int().positive().optional(),
    ttl_days:    z.int().min(1).max(90).optional()
})

export const UserUpdateSchema = z.object({
    status:      z.enum(["active", "disabled"]),
    quota_bytes: z.int().positive()
}).partial()

export type ExternalEmail = z.infer<typeof ExternalEmailSchema>
export type UserDB = z.infer<typeof UserSchemaDB>
export type AccountRequestDB = z.infer<typeof AccountRequestSchemaDB>
export type InviteDB = z.infer<typeof InviteSchemaDB>
