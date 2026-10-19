import dotenv from "dotenv"
import process from "process"
import { scope } from "./logger.js"

const env_type = process.env.NODE_ENV
const scopelog = scope(`config-${env_type}`)


scopelog.info(`Loading config for ${env_type} environment`)
dotenv.config({ path: `.env.${env_type}` })

export const envs = {
    CURR_ENV:   												process.env.CURR_ENV!,
    MDB_URI:    												process.env.MDB_URI!,
    MDB_PORT:   												Number(process.env.MDB_PORT)!,
    MDB_NAME:   												process.env.MDB_NAME!,
    MDB_COLLECTION_UPLOADS: 						process.env.MDB_COLLECTION_UPLOADS!,
		MDB_COLLECTION_COMMENTS:						process.env.MDB_COLLECTION_COMMENTS!,
    MDB_COLLECTION_TOKENS:              process.env.MDB_COLLECTION_TOKENS || "tokens",
    MDB_COLLECTION_TOKEN_USES:          process.env.MDB_COLLECTION_TOKEN_USES || "token_uses",
    PORT:       												Number(process.env.WEBSRV_PORT!),
    MAX_FILE_SIZE:                      Number(process.env.MAX_FILE_SIZE),
    MIN_FILE_SIZE:                      Number(process.env.MIN_FILE_SIZE),
    MAX_FILE_COUNT_PER_UPLOAD:          Number(process.env.MAX_FILE_COUNT_PER_UPLOAD),
    MAX_TITLE_LENGTH_PER_UPLOAD:        Number(process.env.MAX_TITLE_LENGTH_PER_UPLOAD),
    MAX_DESC_LENGTH_PER_UPLOAD:         Number(process.env.MAX_DESC_LENGTH_PER_UPLOAD),
    MAX_NOTE_LENGTH:                    Number(process.env.MAX_NOTE_LENGTH) || 100_000,
		MAX_COMMENT_LENGTH:									Number(process.env.MAX_COMMENT_LENGTH) || 600,
    STORAGE_DIR:                        process.env.STORAGE_DIR,
    STORAGE_LIMIT_BYTES:                Number(process.env.STORAGE_LIMIT_BYTES),
    STORAGE_USAGE_WARNING_PERCENTAGE:   Number(process.env.STORAGE_USAGE_WARNING_PERCENTAGE),
    EMPTY_STORAGE_DIR_ON_STARTUP:       process.env.EMPTY_STORAGE_DIR_ON_STARTUP === "true",
    BASE_URL:                           process.env.BASE_URL,
    SITE_NAME:                          process.env.SITE_NAME || "set site name in .env",
    CORS_ORIGIN:                        process.env.CORS_ORIGIN,
    AUTH_ADMIN_KEY:                     process.env.AUTH_ADMIN_KEY,
    AUTH_ADMIN_MAX_FAILS:               Number(process.env.AUTH_ADMIN_MAX_FAILS) || 5,
    AUTH_ADMIN_BLOCK_MINUTES:           Number(process.env.AUTH_ADMIN_BLOCK_MINUTES) || 15,
    UPLOAD_TOKEN_MAX_FAILS:             Number(process.env.UPLOAD_TOKEN_MAX_FAILS) || 20,
    UPLOAD_TOKEN_BLOCK_MINUTES:         Number(process.env.UPLOAD_TOKEN_BLOCK_MINUTES) || 15,

    // ---- femboyz accounts + mail (MAIL_PLAN.md). Off unless OIDC_ISSUER is set. ----
    OIDC_ISSUER:                        process.env.OIDC_ISSUER?.replace(/\/$/, ""),     // https://femboyz.cloud/oidc
    OIDC_JWKS_FILE:                     process.env.OIDC_JWKS_FILE || "./oidc-jwks.json",
    OIDC_COOKIE_KEYS:                   list(process.env.OIDC_COOKIE_KEYS),
    OIDC_CLIENT_WEB_SECRET:             process.env.OIDC_CLIENT_WEB_SECRET,
    OIDC_CLIENT_BULWARK_SECRET:         process.env.OIDC_CLIENT_BULWARK_SECRET,
    OIDC_CLIENT_BULWARK_REDIRECT_URIS:  list(process.env.OIDC_CLIENT_BULWARK_REDIRECT_URIS),
    OIDC_CLIENT_BULWARK_LOGOUT_URIS:    list(process.env.OIDC_CLIENT_BULWARK_LOGOUT_URIS),
    STALWART_URL:                       process.env.STALWART_URL?.replace(/\/$/, ""),    // https://mx.femboyz.cloud
    STALWART_RESOURCE:                  process.env.STALWART_RESOURCE || "https://mx.femboyz.cloud",
    STALWART_API_KEY:                   process.env.STALWART_API_KEY,
    STALWART_WEBHOOK_SECRET:            process.env.STALWART_WEBHOOK_SECRET,
    MAIL_DOMAIN:                        process.env.MAIL_DOMAIN || "femboyz.cloud",
    MAIL_DEFAULT_QUOTA_BYTES:           Number(process.env.MAIL_DEFAULT_QUOTA_BYTES) || 1024 ** 3,
    MAIL_REDIRECT_MAX_BOUNCES:          Number(process.env.MAIL_REDIRECT_MAX_BOUNCES) || 3,
    INVITE_TTL_DAYS:                    Number(process.env.INVITE_TTL_DAYS) || 7,
    SMTP_HOST:                          process.env.SMTP_HOST,                            // unset = log mail instead of sending
    SMTP_PORT:                          Number(process.env.SMTP_PORT) || 465,
    SMTP_SECURE:                        process.env.SMTP_SECURE !== "false",              // implicit TLS (465); false = STARTTLS
    SMTP_TLS_SERVERNAME:                process.env.SMTP_TLS_SERVERNAME,
    SMTP_TLS_INSECURE:                  process.env.SMTP_TLS_INSECURE === "true",         // dev only: self-signed Stalwart
    SMTP_USER:                          process.env.SMTP_USER,
    SMTP_PASS:                          process.env.SMTP_PASS,
    MAIL_FROM:                          process.env.MAIL_FROM || "femboyz.cloud <noreply@femboyz.cloud>",
    ADMIN_NOTIFY_EMAIL:                 process.env.ADMIN_NOTIFY_EMAIL || "admin@femboyz.cloud",
    EMAIL_CODE_SECRET:                  process.env.EMAIL_CODE_SECRET,
    EMAIL_CODE_TTL_MINUTES:             Number(process.env.EMAIL_CODE_TTL_MINUTES) || 10,
    EMAIL_CODE_MAX_ATTEMPTS:            Number(process.env.EMAIL_CODE_MAX_ATTEMPTS) || 5,
    ACCOUNT_LOGIN_MAX_FAILS:            Number(process.env.ACCOUNT_LOGIN_MAX_FAILS) || 10,
    ACCOUNT_LOGIN_BLOCK_MINUTES:        Number(process.env.ACCOUNT_LOGIN_BLOCK_MINUTES) || 15,
    ACCOUNT_REQUESTS_MAX_PENDING:       Number(process.env.ACCOUNT_REQUESTS_MAX_PENDING) || 100,
    MDB_COLLECTION_USERS:               process.env.MDB_COLLECTION_USERS || "users",
    MDB_COLLECTION_ACCOUNT_REQUESTS:    process.env.MDB_COLLECTION_ACCOUNT_REQUESTS || "account_requests",
    MDB_COLLECTION_INVITES:             process.env.MDB_COLLECTION_INVITES || "invites",
    MDB_COLLECTION_EMAIL_CODES:         process.env.MDB_COLLECTION_EMAIL_CODES || "email_codes",
    MDB_COLLECTION_WEB_SESSIONS:        process.env.MDB_COLLECTION_WEB_SESSIONS || "web_sessions",
    MDB_COLLECTION_OIDC:                process.env.MDB_COLLECTION_OIDC || "oidc",
}

function list(value: string | undefined): string[] {
    return (value ?? "").split(",").map(item => item.trim()).filter(Boolean)
}

export const ACCOUNTS_ENABLED = envs.OIDC_ISSUER !== undefined && envs.OIDC_ISSUER !== ""

/** The site that hosts /login, /signup and /account: the issuer's origin. */
export function site_origin(): string {
    return envs.OIDC_ISSUER ? new URL(envs.OIDC_ISSUER).origin : ""
}

const SECRET_ENVS = new Set([
    "AUTH_ADMIN_KEY", "MDB_URI", "OIDC_COOKIE_KEYS", "OIDC_CLIENT_WEB_SECRET", "OIDC_CLIENT_BULWARK_SECRET",
    "STALWART_API_KEY", "STALWART_WEBHOOK_SECRET", "SMTP_PASS", "EMAIL_CODE_SECRET"
])

for (const [key, value] of Object.entries(envs)) {
    const set = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""
    const loggedValue = SECRET_ENVS.has(key) && set ? "[REDACTED]" : value
    scopelog.info(`ENV: ${key}=${loggedValue}`)
}

scopelog.info("Loaded")
