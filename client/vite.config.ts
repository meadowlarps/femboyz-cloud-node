import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Dev only: the account pages call /oidc and /api on their own origin, like nginx routes them
// in production. The API is told the request was HTTPS so its cookies come out Secure.
const api = {
	target: 'http://127.0.0.1:3000',
	headers: { 'x-forwarded-proto': 'https' }
};

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		proxy: {
			'/oidc': api,
			'/api': api
		}
	}
});
