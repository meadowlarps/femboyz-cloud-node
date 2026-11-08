<script lang="ts">
	import { page } from '$app/stores'
	import ErrorScreen from '$lib/ErrorScreen.svelte'

	const notFound = $derived($page.status === 404)
	// errors we throw carry a readable message; SvelteKit's own crashes say just "Internal Error"
	const message = $derived($page.error?.message && $page.error.message !== 'Internal Error' ? $page.error.message : '')
</script>

<svelte:head>
	<title>{$page.status} {notFound ? 'Not Found' : 'Error'} | femboyz.cloud</title>
</svelte:head>

<ErrorScreen
	status={$page.status}
	eyebrow={notFound ? '' : 'Huh!?!?!?'}
	title={notFound ? 'We cant find this page' : 'We broke something...'}
	text={notFound ? 'The link may be broken, expired, or floating somewhere else' : message ? message : 'Try again later or head back home'}
/>
