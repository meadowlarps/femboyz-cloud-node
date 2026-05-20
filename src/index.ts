import { scope } from "./logger.js"
import { envs } from "./config.js"
import { runDB } from "./database.js"
import { startServer } from "./api.js"

const scopelog = scope("index")
scopelog.info(`The World is ${envs.CURR_ENV}`)
scopelog.info("BEGIN INIT")
// app
await runDB()
await startServer()