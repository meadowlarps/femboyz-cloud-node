import { Db, MongoClient } from "mongodb"
import { ACCOUNTS_ENABLED, envs } from "./config.js"
import { scope, errorFileLogger } from "./logger.js"
import { shutdownUnexpectedly } from "./utils.js"

const scopelog = scope("mongodb")
let DB: Db

async function run() {
    const uri = `${envs.MDB_URI}:${envs.MDB_PORT}`
    scopelog.info("Connecting to MongoDB...")
    
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
    await client.connect()
    DB = initDB(client, envs.MDB_NAME)
    const uploads = getDB().collection(envs.MDB_COLLECTION_UPLOADS)
    const comments = getDB().collection(envs.MDB_COLLECTION_COMMENTS)
    const tokens = getDB().collection(envs.MDB_COLLECTION_TOKENS)
    const token_uses = getDB().collection(envs.MDB_COLLECTION_TOKEN_USES)
    await Promise.all([
        uploads.createIndex({ id_pub: 1 }, { unique: true }),
        uploads.createIndex({ when: -1 }),
        comments.createIndex({ id_comment_pub: 1 }, { unique: true }),
        comments.createIndex({ id_upload_pub: 1, when: 1, id_comment_pub: 1 }),
        tokens.createIndex({ id_token: 1 }, { unique: true }),
        tokens.createIndex({ token: 1 }, { unique: true }),
        token_uses.createIndex({ id_token: 1, when: -1 })
    ]).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        scopelog.error(message)
        errorFileLogger.error({ err }, "Failed to create database indexes")
        shutdownUnexpectedly()
    })
    scopelog.info(`Ensured indexes on collections ${envs.MDB_COLLECTION_UPLOADS}, ${envs.MDB_COLLECTION_COMMENTS}, ${envs.MDB_COLLECTION_TOKENS} and ${envs.MDB_COLLECTION_TOKEN_USES}`)
    if (ACCOUNTS_ENABLED) await account_indexes_ensure(DB).catch(dbErrorHandler)
    scopelog.info("Connected")
}

// Exported for the database-backed account tests, which run against a throwaway server.
export async function account_indexes_ensure(db: Db) {
    const users = db.collection(envs.MDB_COLLECTION_USERS)
    const requests = db.collection(envs.MDB_COLLECTION_ACCOUNT_REQUESTS)
    const invites = db.collection(envs.MDB_COLLECTION_INVITES)
    const codes = db.collection(envs.MDB_COLLECTION_EMAIL_CODES)
    const sessions = db.collection(envs.MDB_COLLECTION_WEB_SESSIONS)
    const oidc = db.collection(envs.MDB_COLLECTION_OIDC)
    await Promise.all([
        users.createIndex({ id_user: 1 }, { unique: true }),
        users.createIndex({ username: 1 }, { unique: true }),
        users.createIndex({ status: 1, delete_after: 1 }),
        // one verified address per account, and an address on one account only
        users.createIndex({ "external_email.key": 1 }, {
            unique: true, partialFilterExpression: { "external_email.key": { $type: "string" } }
        }),
        requests.createIndex({ id: 1 }, { unique: true }),
        requests.createIndex({ status: 1, created: -1 }),
        requests.createIndex({ email_key: 1, status: 1 }),
        invites.createIndex({ id: 1 }, { unique: true }),
        invites.createIndex({ code_hash: 1 }, { unique: true }),
        codes.createIndex({ subject: 1, created: -1 }),
        codes.createIndex({ address_key: 1, created: -1 }),
        // codes stay a day after expiring so the per-day send limits can count them
        codes.createIndex({ purge_at: 1 }, { expireAfterSeconds: 0 }),
        sessions.createIndex({ token_hash: 1 }, { unique: true }),
        sessions.createIndex({ id_user: 1 }),
        sessions.createIndex({ sid: 1 }),
        sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
        oidc.createIndex({ model: 1, uid: 1 }, { sparse: true }),
        oidc.createIndex({ model: 1, userCode: 1 }, { sparse: true }),
        oidc.createIndex({ grantId: 1 }, { sparse: true }),
        oidc.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ])
    scopelog.info("Ensured account indexes")
}

function dbErrorHandler(err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    scopelog.error(message)
    errorFileLogger.error({ err }, message)
    shutdownUnexpectedly()
}

export async function runDB() {
    return run().catch(dbErrorHandler)
}

function initDB(client: MongoClient, dbName: string): Db {
    const db = client.db(dbName)
    if (!db) {
        const message = `Failed to initialize database: ${dbName}`
        scopelog.error(message)
        errorFileLogger.error(message)
        shutdownUnexpectedly()
    }
    return db
}

export function closeDB() {
    if (DB) {
        DB.client.close().catch(dbErrorHandler)
        scopelog.info("Database connection closed")
    } else {
        scopelog.warn("Database connection was not established, nothing to close")
    }
}

export function getDB() {
    return DB
}
