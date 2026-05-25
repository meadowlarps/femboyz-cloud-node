import { scope } from "./logger.js"
import { envs } from "./config.js"
import { runDB } from "./database.js"
import { startServer } from "./api.js"
import { initStorage } from "./storage.js"
import { shutdownUnexpectedly } from "./utils.js"
import { createInterface } from "node:readline/promises"

const scopelog = scope("index")
scopelog.info(`The World is ${envs.CURR_ENV}`)
scopelog.info("BEGIN INIT")
// app
await runDB()
await initStorage()
await startServer()

if (envs.EMPTY_STORAGE_DIR_ON_STARTUP) {
    scopelog.error("EMPTY_STORAGE_DIR_ON_STARTUP is enabled")
    scopelog.error("Enter YES to proceed")

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const userInput = await rl.question("")
    rl.close()

    if (userInput !== "YES") {
        scopelog.info("Aborting emptying storage and database")
        shutdownUnexpectedly()
    }

    const { emptyStorageAndDB } = await import("./utils.js")
    await emptyStorageAndDB()
    await initStorage()
}