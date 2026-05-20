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
    DB = client.db(envs.MDB_NAME)
    
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

export function closeDB() {
    if (DB) {
        DB.client.close().catch(dbErrorHandler)
        scopelog.info("Database connection closed")
    } else {
        scopelog.warn("Database connection was not established, nothing to close")
    }
}

export function getDB() {
    if (!DB) {
        const message = "Database not initialized"
        scopelog.error(message)
        errorFileLogger.error(message)
        shutdownUnexpectedly()
    }
    return DB
}