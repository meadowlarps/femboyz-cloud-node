import { filesize } from "filesize"
import { envs } from "./config.js"
import { scope } from "./logger.js"
import { shutdownUnexpectedly } from "./utils.js"
import fs from "fs/promises"
import path from "path"

const scopelog = scope("storage")
const storageDir = envs.STORAGE_DIR || "./storage"
const storageLimit = envs.STORAGE_LIMIT_BYTES || 10 * 1024 * 1024 * 1024 // default to 10GB
const storageWarningBytes = (storageLimit * (envs.STORAGE_USAGE_WARNING_PERCENTAGE || 80)) / 100

let filesInStorage256: Set<string> = new Set()
let storageUsage = 0


export async function initStorage() {
    try {
        await fs.mkdir(storageDir, { recursive: true })
        storageUsage = await calculateStorageUsage()

        scopelog.info(`Directory initialized at ${storageDir}`)
        scopelog.info(`Current usage: ${filesize(storageUsage)} of ${filesize(storageLimit)}`)
        scopelog.info(`Files currently in storage: ${filesInStorage256.size} file(s)`)
        scopelog.info(`Average size per file: ${filesInStorage256.size > 0 ? filesize(storageUsage / filesInStorage256.size) : "N/A"}`)
        checkStorageUsageWarning()
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        scopelog.error(`Failed to initialize storage directory: ${message}`)
        shutdownUnexpectedly()
    }
}

export async function writeFile(filename: string, data: Buffer): Promise<void> {
    const filepath = path.join(storageDir, filename)
    if (filesInStorage256.has(filename)) {
        scopelog.debug(`Duplicate: (${filesize(data.length)}) ${filename}`)
        return
    }
    if (storageUsage + data.length > storageLimit) {
        const message = `Storage limit exceeded. Cannot write file '${filename}' of size ${filesize(data.length)}`
        throw Object.assign(new Error(message), { statusCode: 507 })
    }
    filesInStorage256.add(filename)     // add to set before writing to prevent race conditions
    storageUsage += data.length
    try {
        await fs.writeFile(filepath, data)
    } catch (err) {
        filesInStorage256.delete(filename)
        storageUsage -= data.length
        throw err
    }
    scopelog.debug(`Wrote file: Size: ${filesize(data.length)}. Updated storage usage: ${filesize(storageUsage)} of ${filesize(storageLimit)}.`)
    checkStorageUsageWarning()
}

export async function readFile(filename: string): Promise<Buffer> {
    const filepath = path.join(storageDir, filename)
    return await fs.readFile(filepath)
}

export async function deleteFile(filename: string): Promise<number> {
    const filepath = path.join(storageDir, filename)
    if (!filesInStorage256.has(filename)) {
        scopelog.warn(`Attempted to delete non-existent file: ${filename}`)
        return 0
    }
    const fsize = (await fs.stat(filepath)).size
    await fs.unlink(filepath)
    filesInStorage256.delete(filename)
    storageUsage -= fsize
    scopelog.debug(`Deleted file: Size: ${filesize(fsize)}. Updated storage usage: ${filesize(storageUsage)} of ${filesize(storageLimit)}.`)
    return fsize
}

export function getStorageUsage(): number {
    return storageUsage
}

export function getStorageLimit(): number {
    return storageLimit
}

export function isThereEnoughStorageFor(bytes: number): boolean {
    return storageUsage + bytes <= storageLimit
}

async function calculateStorageUsage(): Promise<number> {
    const files = await fs.readdir(storageDir)
    filesInStorage256 = new Set(files)
    const stats = await Promise.all(files.map(f => fs.stat(path.join(storageDir, f))))
    return stats.reduce((sum, s) => sum + s.size, 0)
}

function checkStorageUsageWarning() {
    if (storageUsage >= storageWarningBytes) {
        scopelog.warn(`Storage usage warning: Threshold: ${filesize(storageWarningBytes)} | Used: ${filesize(storageUsage)} | Limit: ${filesize(storageLimit)}`)
    }
}
