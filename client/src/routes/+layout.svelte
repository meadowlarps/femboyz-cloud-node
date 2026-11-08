<script lang="ts">
	import '$lib/styles/global.css'
	import favicon from '$lib/assets/favicon.webp'
	import logo from '$lib/assets/logo.webp'
	import AlertStack from '$lib/AlertStack.svelte'
	import { page } from '$app/state'
	import { env } from '$env/dynamic/public'

	let { children } = $props()

	// /account?embed=1 sits inside webmail settings, without the site header
	const embed = $derived(page.url.pathname === '/account' && page.url.searchParams.get('embed') === '1')
	const home = $derived(page.url.pathname === '/')
	const mailUrl = env.PUBLIC_MAIL_URL || 'https://mail.femboyz.cloud'
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="app-shell" class:embed>
	{#if !embed}
	<header class="site-header">
		<a class="brand" href="/" aria-label="Go to home">
			<img class="logo-img" src={logo} alt="femboyz.cloud">
		</a>

		{#if home}
			<nav class="header-buttons" aria-label="Main navigation">
				<a class="header-button" href={mailUrl} aria-label="Mail">
					<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
						<rect x="3" y="5" width="18" height="14" rx="1" />
						<path d="m3.5 6 8.5 7 8.5-7" />
					</svg>
					<span>Mail</span>
				</a>
				<a class="header-button" href="/account" aria-label="Account">
					<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="8.5" r="3.5" />
						<path d="M5 19.5c.8-3.3 3.6-5.5 7-5.5s6.2 2.2 7 5.5" />
					</svg>
					<span>Account</span>
				</a>
			</nav>
		{/if}
	</header>
	{/if}

	<main class="page-content">
		{@render children()}
	</main>
</div>

<AlertStack />

<style>
	:global(body) {
		margin: 0;
		font-family: Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif;
		color: #f4f4f4;
		background: #1b1a1a;
	}

	:global(a) {
		color: inherit;
	}

	.app-shell {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		min-height: 100dvh;
	}

	/* one strip over a hairline, inset to the page content's edges; the logo fills its height */
	.site-header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		height: 6rem;
		margin: 1.5rem 1.5rem 0;
		padding-bottom: 1.5rem;
		border-bottom: 1px solid #3a3437;
	}

	.brand {
		display: block;
		height: 100%;
		margin-right: auto;
	}

	.logo-img {
		display: block;
		height: 100%;
		aspect-ratio: 655 / 256;
		object-fit: cover;
		object-position: 92% center;
		transition: filter 0.25s ease-out;
	}

	/* flush with the edges, so it brightens instead of scaling */
	.brand:hover .logo-img,
	.brand:focus-visible .logo-img {
		filter: brightness(1.12);
	}

	.brand:focus-visible {
		outline: none;
	}

	.header-buttons {
		display: flex;
		gap: 0.75rem;
	}

	/* line icon and label: no fill, gray border; border, icon and label turn white on hover */
	.header-button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
		width: 9rem;
		height: 3.25rem;
		box-sizing: border-box;
		color: #9e9699;
		border: 1px solid #5b5357;
		font-size: 0.95rem;
		letter-spacing: 0.02em;
		text-decoration: none;
		transition: color 0.2s ease-out, border-color 0.2s ease-out;
	}

	.header-button:hover,
	.header-button:focus-visible {
		color: #fff;
		border-color: #fff;
		outline: none;
	}

	.page-content {
		flex: 1;
		margin: 0;
		padding: 2rem 1.5rem 2rem;
	}

	/* Error screens fill the space below the header and grow when content needs it. */
	.page-content:has(> :global(.error-page)) {
		display: grid;
	}

	.embed {
		min-height: 0;
	}

	.embed .page-content {
		padding: 1rem;
	}

	@media (max-width: 42rem) {
		.site-header {
			height: 4.5rem;
			margin: 1rem 1rem 0;
			padding-bottom: 1rem;
			gap: 0.5rem;
		}

		.page-content {
			padding: 1.5rem 1rem 2rem;
		}

		.header-buttons {
			gap: 0.5rem;
		}

		/* icon-only squares */
		.header-button {
			width: 3rem;
			height: 3rem;
		}

		.header-button span {
			display: none;
		}
	}

	/* too narrow for the full logo next to the buttons: just the cat */
	@media (max-width: 21rem) {
		.logo-img {
			aspect-ratio: 1;
		}
	}
</style>
