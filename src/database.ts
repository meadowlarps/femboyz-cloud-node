import { Db, MongoClient } from "mongodb"
import { envs } from "./config.js"
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
    scopelog.info("Connected")
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
