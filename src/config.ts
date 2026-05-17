import dotenv from "dotenv"
import process from "process"
import { scope } from "./logger.js"

const env_type = process.env.NODE_ENV
const scopelog = scope(`config-${env_type}`)


scopelog.info(`Loading config for ${env_type} environment`)
dotenv.config({ path: `.env.${env_type}` })

export const envs = {
    CURR_ENV: process.env.CURR_ENV,
    MDB_URI: process.env.MDB_URI,
    MDB_PORT: process.env.MDB_PORT,
    MDB_NAME: process.env.MDB_NAME
}

for (const [key, value] of Object.entries(envs)) {
    scopelog.info(`ENV: ${key}=${value}`)
}

scopelog.info("Loaded")