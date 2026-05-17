import { MongoClient } from "mongodb"
import { envs } from "./config.js"
import { scope } from "./logger.js";

const scopelog = scope("mongodb")

async function runDB() {
    scopelog.info("Starting up database...")
    const uri = `${envs.MDB_URI}:${envs.MDB_PORT}`
    const client = new MongoClient(uri)

    try {
        const database = client.db(envs.MDB_NAME)
    } 
    finally {
        scopelog.info("Closing database...")
        await client.close()
    }
}

runDB().catch(err => scopelog.error(err))