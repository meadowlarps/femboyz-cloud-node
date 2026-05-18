import { MongoClient } from "mongodb"
import { envs } from "./config.js"
import { scope, errorFileLogger } from "./logger.js"
import { shutdownUnexpectedly } from "./utils.js"

const scopelog = scope("mongodb")

async function run() {
    scopelog.info("Starting up...")
    const uri = `${envs.MDB_URI}:${envs.MDB_PORT}`

    scopelog.info(`Connecting to ${uri}...`)
    const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000
    })

    try {
        const database = client.db(envs.MDB_NAME)
        await database.command({ ping: 1 })
        scopelog.info("Connected")
    } finally {
        scopelog.info("Closing...")
        await client.close()
    }
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