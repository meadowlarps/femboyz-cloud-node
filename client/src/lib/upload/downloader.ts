export type UploadData = {
    id: string
    type: 'files' | 'album' | 'playlist' | 'link'
    public: boolean
    meta: { title: string; desc: string }
    views: number
    files: FileData[]
    link?: string
    when: string
}

export type FileData = {
    index: number
    filename: string
    size: number
    mime: string
    url: string
    stat_dl: number
}

/**
 * Same file, but asking the API for `Content-Disposition: attachment` so the browser
 * saves it instead of playing it. `file.url` itself must stay inline for <audio>/<img>.
 */
export function fileDownloadUrl(file: FileData): string {
    return `${file.url}${file.url.includes('?') ? '&' : '?'}dl=1`
}

export async function fetchUpload(
    id: string,
    apiEndpoint: string,
    fetcher: typeof fetch = fetch,
    forwarded: Record<string, string> = {}
): Promise<UploadData> {
    const response = await fetcher(`${apiEndpoint.replace(/\/$/, '')}/${id}`, {
        headers: { Accept: 'application/json', ...forwarded }
    })

    if (!response.ok) {
        throw new Error(`${response.status}`)
    }

    return await response.json() as UploadData
}

export type UploadsBatch = {
    items: UploadData[]
    /** Requested IDs that no longer exist. */
    missing: string[]
}

/** Server-side cap on IDs per `GET /api/v2/uploads` request. */
export const UPLOADS_BATCH_MAX_IDS = 100

/** Fetches several uploads at once, chunked into requests of at most 100 IDs. */
export async function fetchUploads(
    ids: string[],
    apiEndpoint: string,
    fetcher: typeof fetch = fetch
): Promise<UploadsBatch> {
    const batch: UploadsBatch = { items: [], missing: [] }

    for (let start = 0; start < ids.length; start += UPLOADS_BATCH_MAX_IDS) {
        const chunk = ids.slice(start, start + UPLOADS_BATCH_MAX_IDS)
        const response = await fetcher(
            `${apiEndpoint.replace(/\/$/, '')}/api/v2/uploads?ids=${chunk.map(encodeURIComponent).join(',')}`
        )

        if (!response.ok) {
            throw new Error(`${response.status}`)
        }

        const result = await response.json() as UploadsBatch
        batch.items.push(...result.items)
        batch.missing.push(...result.missing)
    }

    return batch
}

export async function markUploadViewed(
    id: string,
    apiEndpoint: string,
    fetcher: typeof fetch = fetch
): Promise<void> {
    const response = await fetcher(
        `${apiEndpoint.replace(/\/$/, '')}/api/v2/viewed/${encodeURIComponent(id)}`,
        { method: 'POST' }
    )

    if (!response.ok) {
        throw new Error(`${response.status}`)
    }
}
