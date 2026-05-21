import { filesize } from "filesize"
import { envs } from "./config.js"
import { scope, errorFileLogger } from "./logger.js"
import { shutdownUnexpectedly } from "./utils.js"
import fs from "fs/promises"
import path from "path"

const scopelog = scope("storage")
const storageDir = envs.STORAGE_DIR || "./storage"
const storageLimit = envs.STORAGE_LIMIT_BYTES || 10 * 1024 * 1024 * 1024 // default to 10GB
const storageWarningBytes = (storageLimit * (envs.STORAGE_USAGE_WARNING_PERCENTAGE || 80)) / 100
let storageUsage = 0


export async function initStorage() {
    try {
        await fs.mkdir(storageDir, { recursive: true })
        storageUsage = await calculateStorageUsage()

        scopelog.info(`Storage directory initialized at ${storageDir}`)
        scopelog.info(`Current storage usage: ${filesize(storageUsage)} of ${filesize(storageLimit)}`)
        checkStorageUsageWarning()
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        scopelog.error(`Failed to initialize storage directory: ${message}`)
        errorFileLogger.error({ err }, "Failed to initialize storage directory")
        shutdownUnexpectedly()
    }
}

export async function writeFile(filename: string, data: Buffer): Promise<void> {
    if (storageUsage + data.length > storageLimit) {
        const message = `Storage limit exceeded. Cannot write file '${filename}' of size ${filesize(data.length)}. Current usage: ${filesize(storageUsage)} of ${filesize(storageLimit)}.`
        scopelog.error(message)
        errorFileLogger.error(message)
        throw Object.assign(new Error("Storage limit exceeded"), { statusCode: 507 })
    }
    const filepath = path.join(storageDir, filename)
    await fs.writeFile(filepath, data)
    storageUsage += data.length
    checkStorageUsageWarning()
}

export async function readFile(filename: string): Promise<Buffer> {
    const filepath = path.join(storageDir, filename)
    return await fs.readFile(filepath)
}

export async function deleteFile(filename: string): Promise<void> {
    const filepath = path.join(storageDir, filename)
    storageUsage -= (await fs.stat(filepath)).size
    await fs.unlink(filepath)
}

export async function getStorageUsage(): Promise<number> {
    return storageUsage
}

async function calculateStorageUsage(): Promise<number> {
    const files = await fs.readdir(storageDir)
    const stats = await Promise.all(
        files.map(f => fs.stat(path.join(storageDir, f)))
    )
    return stats.reduce((sum, s) => sum + s.size, 0)
}

function checkStorageUsageWarning() {
    if (storageUsage >= storageWarningBytes) {
        scopelog.warn(`Storage usage warning: Threshold: ${filesize(storageWarningBytes)} | Used: ${filesize(storageUsage)} | Limit: ${filesize(storageLimit)}`)
    }
}