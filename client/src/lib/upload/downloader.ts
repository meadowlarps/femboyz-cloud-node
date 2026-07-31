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
    fetcher: typeof fetch = fetch
): Promise<UploadData> {
    const response = await fetcher(`${apiEndpoint.replace(/\/$/, '')}/${id}`, {
        headers: { Accept: 'application/json' }
    })

    if (!response.ok) {
        throw new Error(`${response.status}`)
    }

    return await response.json() as UploadData
}
