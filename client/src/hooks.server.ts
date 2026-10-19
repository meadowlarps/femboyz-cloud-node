import type { Handle } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'

// Webmail embeds /account (and /login when its session has to be renewed) in its settings.
// /signup is never framed. ACCOUNT_FRAME_ANCESTORS is a space-separated list of origins.
const FRAME_POLICY: Record<string, 'webmail' | 'none'> = {
	'/account': 'webmail',
	'/login': 'webmail',
	'/signup': 'none'
}

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event)
	const policy = FRAME_POLICY[event.url.pathname]
	if (policy && !response.headers.has('content-security-policy')) {
		const ancestors = policy === 'webmail' ? `'self' ${env.ACCOUNT_FRAME_ANCESTORS ?? 'https://mail.femboyz.cloud'}` : "'none'"
		response.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors}`)
	}
	return response
}
