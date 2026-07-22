import type { PageServerLoad } from './$types'
import { redirect, error } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { fetchUpload } from '$lib/upload/downloader'

export const load: PageServerLoad = async ({ params, fetch }) => {
    const apiEndpoint = env.INTERNAL_API_ENDPOINT ?? env.VITE_API_ENDPOINT ?? ''
    let upload
    try {
        upload = await fetchUpload(params.id, apiEndpoint, fetch)
    } catch (err) {
        const status = err instanceof Error ? parseInt(err.message) : NaN
        throw error(isNaN(status) ? 500 : status, 'Upload not found')
    }

    if (upload.type === 'link' && upload.link) {
        throw redirect(302, upload.link)
    }

    return { upload }
}
