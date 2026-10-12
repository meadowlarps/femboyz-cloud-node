import { filesize } from "filesize"
import { envs } from "./config.js"
import { scope } from "./logger.js"
import { shutdownUnexpectedly } from "./utils.js"
import { createReadStream } from "node:fs"
import fs from "fs/promises"
import path from "path"

const scopelog = scope("storage")
const storageDir = envs.STORAGE_DIR || "./storage"
const storageLimit = envs.STORAGE_LIMIT_BYTES || 10 * 1024 * 1024 * 1024 // default to 10GB
const storageWarningBytes = (storageLimit * (envs.STORAGE_USAGE_WARNING_PERCENTAGE || 80)) / 100
const incomingDir = path.join(storageDir, ".incoming")     // in-flight upload temp files; same fs → atomic rename

let filesInStorage256: Set<string> = new Set()
let storageUsage = 0
let reservedBytes = 0       // claimed by uploads still streaming to incomingDir


export async function initStorage() {
    try {
        await fs.mkdir(storageDir, { recursive: true })
        await fs.rm(incomingDir, { recursive: true, force: true })     // partial uploads left by a crash
        await fs.mkdir(incomingDir, { recursive: true })
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

export function getIncomingDir(): string {
    return incomingDir
}

/** Moves a verified temp file from incomingDir into storage as `filename`; drops it if that blob already exists. */
export async function commitFile(tmpPath: string, filename: string, bytes: number): Promise<void> {
    const filepath = path.join(storageDir, filename)
    if (filesInStorage256.has(filename)) {
        scopelog.debug(`Duplicate: (${filesize(bytes)}) ${filename}`)
        await fs.unlink(tmpPath)
        return
    }
    if (storageUsage + bytes > storageLimit) {
        const message = `Storage limit exceeded. Cannot write file '${filename}' of size ${filesize(bytes)}`
        throw Object.assign(new Error(message), { statusCode: 507 })
    }
    filesInStorage256.add(filename)     // add to set before renaming to prevent race conditions
    storageUsage += bytes
    try {
        await fs.rename(tmpPath, filepath)
    } catch (err) {
        filesInStorage256.delete(filename)
        storageUsage -= bytes
        throw err
    }
    scopelog.debug(`Wrote file: Size: ${filesize(bytes)}. Updated storage usage: ${filesize(storageUsage)} of ${filesize(storageLimit)}.`)
    checkStorageUsageWarning()
}

/** Claims space for an upload before it streams to disk; false if it wouldn't fit. */
export function storage_reserve(bytes: number): boolean {
    if (!isThereEnoughStorageFor(bytes)) return false
    reservedBytes += bytes
    return true
}

export function storage_release(bytes: number) {
    reservedBytes = Math.max(0, reservedBytes - bytes)
}

export function createFileReadStream(filename: string, range?: { start: number, end: number }) {
    const filepath = path.join(storageDir, filename)
    return range ? createReadStream(filepath, range) : createReadStream(filepath)
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

export function getStorageFree(): number {
    return Math.max(0, storageLimit - storageUsage - reservedBytes)
}

export function isThereEnoughStorageFor(bytes: number): boolean {
    return storageUsage + reservedBytes + bytes <= storageLimit
}

async function calculateStorageUsage(): Promise<number> {
    const files = (await fs.readdir(storageDir)).filter(f => !f.startsWith("."))    // skips incomingDir, .DS_Store
    filesInStorage256 = new Set(files)
    const stats = await Promise.all(files.map(f => fs.stat(path.join(storageDir, f))))
    return stats.reduce((sum, s) => sum + s.size, 0)
}

function checkStorageUsageWarning() {
    if (storageUsage >= storageWarningBytes) {
        scopelog.warn(`Storage usage warning: Threshold: ${filesize(storageWarningBytes)} | Used: ${filesize(storageUsage)} | Limit: ${filesize(storageLimit)}`)
    }
}
