import type { PageServerLoad } from './$types'
import { env } from '$env/dynamic/private'
import { fetchUploadLimits } from '$lib/upload/uploader'
import { forwardedHeaders } from '$lib/upload/forwarded'

export const load: PageServerLoad = async ({ fetch, request }) => {
    const apiEndpoint = env.INTERNAL_API_ENDPOINT ?? env.VITE_API_ENDPOINT ?? ''

    try {
        return {
            uploadLimits: await fetchUploadLimits(apiEndpoint, fetch, forwardedHeaders(request)),
            limitsError: ''
        }
    } catch (error) {
        return {
            uploadLimits: null,
            limitsError: error instanceof Error ? error.message : 'Could not message server'
        }
    }
}
