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
	<header class="site-header" class:home>
		<a class="brand" href="/" aria-label="Go to home">
			<img class="logo-img" src={logo} alt="femboyz.cloud">
		</a>

		{#if home}
			<div class="header-buttons">
				<a class="header-button" href="/account" aria-label="Account" title="Account">
					<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="8.5" r="3.5" />
						<path d="M5 19.5c.8-3.3 3.6-5.5 7-5.5s6.2 2.2 7 5.5" />
					</svg>
				</a>
				<a class="header-button" href={mailUrl} aria-label="Mail" title="Mail">
					<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
						<rect x="3" y="5" width="18" height="14" rx="1" />
						<path d="m3.5 6 8.5 7 8.5-7" />
					</svg>
				</a>
			</div>
		{/if}
		<nav class="nav-links" aria-label="Main navigation">
			<a href="/">Home</a>
		</nav>
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
		min-height: 100vh;
		min-height: 100dvh;
	}

	.site-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-height: 6rem;
		padding: 0 1.5rem;
		padding-top: 1.2rem;
		border: none;
		background: none;
	}

	/* account and mail, at the right end of the header, top-aligned with the logo */
	.header-buttons {
		display: flex;
		gap: 0.75rem;
		flex: none;
		align-self: flex-start;
		margin-left: auto;
	}

	/* line icon: no fill, gray border; border and icon turn white on hover.
	   Same height as the logo, square. */
	.header-button {
		display: grid;
		place-items: center;
		height: 7rem;
		aspect-ratio: 1;
		box-sizing: border-box;
		color: #9e9699;
		background: none;
		border: 1px solid #5b5357;
		transition: color 0.2s ease-out, border-color 0.2s ease-out;
	}

	.header-button:hover,
	.header-button:focus-visible {
		color: #fff;
		border-color: #fff;
		outline: none;
	}

	.brand {
		display: block;
		width: 17.91rem;
	}

	.brand .logo-img {
		width: 100%;
		transition: filter 0.35s ease-out, transform 0.25s ease;
	}

	.brand:hover .logo-img {
		transform: scale(1.03);
	}

	.logo-img {
		max-width: 100%;
		height: 7rem;
		object-fit: cover;
		object-position: 93% center;
	}

	.nav-links {
		display: none;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.95rem;
		font-weight: 500;
	}

	.nav-links a {
		padding: 0.5rem 0.65rem;
		border-radius: 0.375rem;
		text-decoration: none;
		color: #475466;
	}

	.nav-links a:hover,
	.nav-links a:focus-visible {
		color: #111827;
		background: #eef2f6;
		outline: none;
	}

	.page-content {
		margin: 0;
		padding: 2rem 1.5rem 2rem;
	}

	.embed {
		min-height: 0;
	}

	.embed .page-content {
		padding: 1rem;
	}

	@media (max-width: 42rem) {
		.site-header {
			padding: 0 1rem;
		}

		.page-content {
			padding: 1.5rem 1rem 2rem;
		}

		/* away from home the logo is only a way back, so it gives the form the room */
		.site-header:not(.home) {
			min-height: 0;
			padding-top: 1rem;
		}

		.site-header:not(.home) .brand {
			width: 11.5rem;
		}

		.site-header:not(.home) .logo-img {
			height: 4.5rem;
		}
	}
</style>
