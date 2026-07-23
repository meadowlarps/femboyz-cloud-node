import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { fetchUpload, type FileData, type UploadData } from '$lib/upload/downloader'
import {
    MAX_OG_SOURCE_BYTES,
    canNormalizeLeadImage,
    normalizeLeadImage,
    renderOgCard,
    selectLeadImage
} from '$lib/upload/ogCard'
import { hasGeneratedCard } from '$lib/upload/preview'

function rawFileUrl(upload: UploadData, file: FileData, apiEndpoint: string): string {
    return apiEndpoint
        ? `${apiEndpoint.replace(/\/$/, '')}/${upload.id}/${file.index}`
        : file.url
}

async function loadLeadImage(upload: UploadData, apiEndpoint: string, fetcher: typeof fetch): Promise<string | null> {
    const lead = selectLeadImage(upload)
    if (!lead || !canNormalizeLeadImage(lead)) return null

    try {
        const response = await fetcher(rawFileUrl(upload, lead, apiEndpoint))
        if (!response.ok) return null

        const contentLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(contentLength) && contentLength > MAX_OG_SOURCE_BYTES) return null

        const bytes = await response.arrayBuffer()
        if (bytes.byteLength > MAX_OG_SOURCE_BYTES) return null
        return normalizeLeadImage(bytes)
    } catch {
        return null
    }
}

export const GET: RequestHandler = async ({ params, fetch, url }) => {
    const apiEndpoint = env.INTERNAL_API_ENDPOINT ?? env.VITE_API_ENDPOINT ?? ''
    let upload: UploadData

    try {
        upload = await fetchUpload(params.id, apiEndpoint, fetch)
    } catch (err) {
        const status = err instanceof Error ? parseInt(err.message) : NaN
        throw error(isNaN(status) ? 500 : status, 'Upload not found')
    }

    if (!hasGeneratedCard(upload)) throw error(404, 'Preview not found')

    const leadImageDataUri = await loadLeadImage(upload, apiEndpoint, fetch)
    const png = await renderOgCard(upload, url.hostname, leadImageDataUri)

    return new Response(png, {
        headers: {
            'Cache-Control': 'public, max-age=31536000, immutable, no-transform',
            'Content-Length': String(png.byteLength),
            'Content-Type': 'image/png'
        }
    })
}
