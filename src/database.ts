import { Db, MongoClient } from "mongodb"
import { envs } from "./config.js"
import { scope, errorFileLogger } from "./logger.js"
import { shutdownUnexpectedly } from "./utils.js"

const scopelog = scope("mongodb")
let DB: Db

async function run() {
    const uri = `${envs.MDB_URI}:${envs.MDB_PORT}`
    scopelog.info(`Connecting to ${uri}...`)
    
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
    await client.connect()
    DB = initDB(client, envs.MDB_NAME)
    getDB().collection(envs.MDB_COLLECTION_UPLOADS).createIndex({ id_pub: 1 }, { unique: true }).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        scopelog.error(message)
        errorFileLogger.error({ err }, `Failed to create index on collection ${envs.MDB_COLLECTION_UPLOADS}`)
        shutdownUnexpectedly()
    }).finally(() => {
        scopelog.info(`Ensured index "id_pub" on collection ${envs.MDB_COLLECTION_UPLOADS}`)
        scopelog.info("Connected")
    })
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