import { scope } from "./logger.js"
import { envs } from "./config.js"
import "./database.js"

const scopelog = scope("index")
scopelog.info(`The World is ${envs.CURR_ENV}`)
scopelog.info("BEGIN INIT")