import type { PageServerLoad } from './$types'
import { redirect, error } from '@sveltejs/kit'
import { fetchUpload } from '$lib/upload/downloader'

const apiEndpoint = import.meta.env.VITE_API_ENDPOINT ?? ''

export const load: PageServerLoad = async ({ params, fetch }) => {
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
