export type UploadData = {
    id: string
    type: 'files' | 'album' | 'playlist' | 'link'
    public: boolean
    meta: { title: string; desc: string }
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
