import dotenv from "dotenv"
import process from "process"
import { scope } from "./logger.js"

const env_type = process.env.NODE_ENV
const scopelog = scope(`config-${env_type}`)


scopelog.info(`Loading config for ${env_type} environment`)
dotenv.config({ path: `.env.${env_type}` })

export const envs = {
    CURR_ENV:   process.env.CURR_ENV!,
    MDB_URI:    process.env.MDB_URI!,
    MDB_PORT:   Number(process.env.MDB_PORT)!,
    MDB_NAME:   process.env.MDB_NAME!,
    MDB_COLLECTION_UPLOADS: process.env.MDB_COLLECTION_UPLOADS!,
    PORT:       Number(process.env.WEBSRV_PORT!),
    MAX_FILE_SIZE:                      Number(process.env.MAX_FILE_SIZE),
    MIN_FILE_SIZE:                      Number(process.env.MIN_FILE_SIZE),
    MAX_FILE_COUNT_PER_UPLOAD:          Number(process.env.MAX_FILE_COUNT_PER_UPLOAD),
    MAX_TITLE_LENGTH_PER_UPLOAD:        Number(process.env.MAX_TITLE_LENGTH_PER_UPLOAD),
    MAX_DESC_LENGTH_PER_UPLOAD:         Number(process.env.MAX_DESC_LENGTH_PER_UPLOAD),
    STORAGE_DIR:                        process.env.STORAGE_DIR,
    STORAGE_LIMIT_BYTES:                Number(process.env.STORAGE_LIMIT_BYTES),
    STORAGE_USAGE_WARNING_PERCENTAGE:   Number(process.env.STORAGE_USAGE_WARNING_PERCENTAGE),
    EMPTY_STORAGE_DIR_ON_STARTUP:       process.env.EMPTY_STORAGE_DIR_ON_STARTUP === "true",
    BASE_URL:                           process.env.BASE_URL,
    SITE_NAME:                          process.env.SITE_NAME || "set site name in .env"
}

for (const [key, value] of Object.entries(envs)) {
    scopelog.info(`ENV: ${key}=${value}`)
}

scopelog.info("Loaded")