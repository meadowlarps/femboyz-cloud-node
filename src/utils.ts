import path from "path";
import { envs } from "./config.js";
import { getDB } from "./database.js";
import { scope } from "./logger.js"
import fs from 'fs/promises';

const utilsLogger = scope("utils")

export function shutdownUnexpectedly() {
    utilsLogger.error("Shutting down unexpectedly...")
    process.exit(1)
}
export async function emptyStorageAndDB() {
    utilsLogger.warn("Emptying storage directory and database...")

    fs.readdir(envs.STORAGE_DIR!).then(files =>
        Promise.all(files.map(f => fs.unlink(path.join(envs.STORAGE_DIR!, f))))
    ).then(() => {
        utilsLogger.info("Storage directory emptied successfully.")
    }).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        utilsLogger.error(`Failed to empty storage directory: ${message}`)
    })
    getDB().collection(envs.MDB_COLLECTION_UPLOADS).deleteMany({}).then(() => {
        utilsLogger.info("Database collection emptied successfully.")
    }).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        utilsLogger.error(`Failed to empty database collection: ${message}`)
    })
}