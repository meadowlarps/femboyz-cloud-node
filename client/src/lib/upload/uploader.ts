export type UploadLimits = {
    maxsize?: number
    maxsizeperfile: number
    maxcount: number
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

export async function fetchUploadLimits(apiEndpoint: string, fetcher: typeof fetch = fetch) {
    const response = await fetcher(`${apiEndpoint.replace(/\/$/, '')}/api/v2/maxfsize`)

    if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`)
    }

    return await response.json() as UploadLimits
}

export function formatFileSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export async function sendUpload(
    apiEndpoint: string,
    files: File[],
    title: string,
    desc: string,
    is_public = false,
    onProgress?: UploadProgressHandler
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
        onProgress
    )
}

async function createFileEntry(file: File): Promise<_XMetaFile> {
    return {
        filename: file.name,
        sha256: await hashFileSha256(file),
        bytes: file.size
    }
}

async function hashFileSha256(file: File) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
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
    onProgress?: UploadProgressHandler
) {
    return new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const body = new Blob(files, { type: 'application/octet-stream' })

        xhr.open('POST', url)
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        xhr.setRequestHeader('X-Meta', encodeBase64Json(xmeta))

        xhr.upload.onprogress = (event) => {
            const total = event.lengthComputable ? event.total : body.size
            onProgress?.(createUploadProgress(files, event.loaded, total))
        }

        xhr.onload = () => {
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
