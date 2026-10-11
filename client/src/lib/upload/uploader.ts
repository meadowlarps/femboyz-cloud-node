import { createSHA256 } from 'hash-wasm'

export type UploadTokenInfo = {
    label: string
    max_files: number | null
    max_bytes: number | null
    uses_left: number | null
    expires_at: string | null
}

export type UploadLimits = {
    maxsize?: number
    maxsizeperfile: number
    maxcount: number
    max_title_length: number
    max_desc_length: number
    token?: UploadTokenInfo
}

export const UPLOAD_TOKEN_MIN_LENGTH = 8

export class UploadTokenError extends Error {}

function tokenBlockedMessage(retryAfter: string | null) {
    const seconds = Number(retryAfter)
    const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 15
    return `Too many wrong tokens. Try again in ~${minutes}m.`
}

export type UploadResult = {
    id: string
    type: string
}

export type UploadProgress = {
    loaded: number
    total: number
    files: FileUploadProgress[]
}

export type FileUploadProgress = {
    index: number
    filename: string
    loaded: number
    total: number
}

export type UploadProgressHandler = (progress: UploadProgress) => void

type XMetaFiles = {
    type: 'files'
    is_public: boolean
    meta: {
        title: string
        desc: string
    }
    files: _XMetaFile[]
}

type _XMetaFile = {
    filename: string
    sha256: string
    bytes: number
}

export async function fetchUploadLimits(
    apiEndpoint: string,
    fetcher: typeof fetch = fetch,
    forwarded: Record<string, string> = {},
    token?: string
) {
    const response = await fetcher(`${apiEndpoint.replace(/\/$/, '')}/api/v2/maxfsize`, {
        headers: token ? { ...forwarded, 'X-Upload-Token': token } : forwarded
    })

    if (response.status === 429) {
        throw new UploadTokenError(tokenBlockedMessage(response.headers.get('Retry-After')))
    }

    if (response.status === 403) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        throw new UploadTokenError(body?.error ?? 'Token rejected')
    }

    if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`)
    }

    return await response.json() as UploadLimits
}

export function formatFileSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export async function sendUpload(
    apiEndpoint: string,
    files: File[],
    title: string,
    desc: string,
    is_public = false,
    onProgress?: UploadProgressHandler,
    token?: string
) {
    if (files.length === 0) {
        throw new Error('Select at least one file')
    }

    const xmeta: XMetaFiles = {
        type: 'files',
        is_public,
        meta: { title, desc },
        files: await Promise.all(files.map(createFileEntry))
    }

    return await uploadWithProgress(
        `${apiEndpoint.replace(/\/$/, '')}/api/v2/udstream`,
        files,
        xmeta,
        onProgress,
        token
    )
}

async function createFileEntry(file: File): Promise<_XMetaFile> {
    return {
        filename: file.name,
        sha256: await hashFileSha256(file),
        bytes: file.size
    }
}

// Chrome can't read Blobs over ~2 GB into one ArrayBuffer (NotReadableError), so hash in chunks
const HASH_CHUNK_BYTES = 64 * 1024 * 1024

async function hashFileSha256(file: File) {
    const hasher = await createSHA256()
    for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
        const chunk = await file.slice(offset, offset + HASH_CHUNK_BYTES).arrayBuffer()
        hasher.update(new Uint8Array(chunk))
    }
    return hasher.digest('hex')
}

function encodeBase64Json(value: unknown) {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    let binary = ''

    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }

    return btoa(binary)
}

function uploadWithProgress(
    url: string,
    files: File[],
    xmeta: XMetaFiles,
    onProgress?: UploadProgressHandler,
    token?: string
) {
    return new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const body = new Blob(files, { type: 'application/octet-stream' })

        xhr.open('POST', url)
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        xhr.setRequestHeader('X-Meta', encodeBase64Json(xmeta))
        if (token) xhr.setRequestHeader('X-Upload-Token', token)

        xhr.upload.onprogress = (event) => {
            const total = event.lengthComputable ? event.total : body.size
            onProgress?.(createUploadProgress(files, event.loaded, total))
        }

        xhr.onload = () => {
            if (xhr.status === 429) {
                reject(new UploadTokenError(tokenBlockedMessage(xhr.getResponseHeader('Retry-After'))))
                return
            }
            if (xhr.status === 403) {
                reject(new UploadTokenError(parseErrorMessage(xhr.responseText) ?? 'Token rejected'))
                return
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                reject(new Error(`Upload failed with ${xhr.status}`))
                return
            }

            try {
                resolve(JSON.parse(xhr.responseText) as UploadResult)
            } catch {
                reject(new Error('Upload response was not valid JSON'))
            }
        }

        xhr.onerror = () => reject(new Error('Upload network error'))
        xhr.onabort = () => reject(new Error('Upload aborted'))
        xhr.send(body)
    })
}

export async function sendLinkUpload(apiEndpoint: string, link: string): Promise<UploadResult> {
    const response = await fetch(`${apiEndpoint.replace(/\/$/, '')}/api/v2/ulink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'link', link })
    })

    if (!response.ok) {
        throw new Error(`Upload failed with ${response.status}`)
    }

    return await response.json() as UploadResult
}

function parseErrorMessage(text: string) {
    try {
        const body = JSON.parse(text) as { error?: unknown }
        return typeof body.error === 'string' ? body.error : undefined
    } catch {
        return undefined
    }
}

function createUploadProgress(files: File[], loaded: number, total: number): UploadProgress {
    let offset = 0

    return {
        loaded,
        total,
        files: files.map((file, index) => {
            const fileLoaded = Math.max(0, Math.min(file.size, loaded - offset))
            offset += file.size

            return {
                index,
                filename: file.name,
                loaded: fileLoaded,
                total: file.size
            }
        })
    }
}
