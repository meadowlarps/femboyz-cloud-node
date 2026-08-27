import type { PageServerLoad } from './$types'
import { redirect, error } from '@sveltejs/kit'
import { fetchUploadComments, type CommentPublic } from '$lib/upload/comments'
import { env } from '$env/dynamic/private'
import { fetchUpload } from '$lib/upload/downloader'
import { forwardedHeaders } from '$lib/upload/forwarded'
import { buildUploadPreview } from '$lib/upload/preview'

export const load: PageServerLoad = async ({ params, fetch, request, url }) => {
    const apiEndpoint = env.INTERNAL_API_ENDPOINT ?? env.VITE_API_ENDPOINT ?? ''
    let upload
    try {
        upload = await fetchUpload(params.id, apiEndpoint, fetch, forwardedHeaders(request))
    } catch (err) {
        const status = err instanceof Error ? parseInt(err.message) : NaN
        throw error(isNaN(status) ? 500 : status, 'Upload not found')
    }

    if (upload.type === 'link' && upload.link) {
        throw redirect(302, upload.link)
    }

    const preview = buildUploadPreview(upload, url.origin, request.headers.get('user-agent'))
    if (preview.redirectUrl) {
        throw redirect(302, preview.redirectUrl)
    }

    const comments = upload.public
        ? await fetchUploadComments(params.id, apiEndpoint, fetch, forwardedHeaders(request))
            .catch(() => {
                throw error(502, 'Comments unavailable')
            })
        : []

    return {
        upload,
        preview,
        comments,
        apiEndpoint: env.VITE_API_ENDPOINT ?? ''
    }
}
