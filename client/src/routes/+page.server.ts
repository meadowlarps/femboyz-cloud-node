import type { PageServerLoad } from './$types'
import { env } from '$env/dynamic/private'
import { fetchUploadLimits } from '$lib/upload/uploader'

export const load: PageServerLoad = async ({ fetch }) => {
    const apiEndpoint = env.INTERNAL_API_ENDPOINT ?? env.VITE_API_ENDPOINT ?? ''

    try {
        return {
            uploadLimits: await fetchUploadLimits(apiEndpoint, fetch),
            limitsError: ''
        }
    } catch (error) {
        return {
            uploadLimits: null,
            limitsError: error instanceof Error ? error.message : 'Could not message server'
        }
    }
}
