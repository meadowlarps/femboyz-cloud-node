import type { PageLoad } from './$types'
import { fetchUploadLimits } from '$lib/upload/uploader'

const apiEndpoint = import.meta.env.VITE_API_ENDPOINT ?? ''

export const load: PageLoad = async ({ fetch }) => {
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
