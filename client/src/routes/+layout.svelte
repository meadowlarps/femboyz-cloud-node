<script lang="ts">
	import '$lib/styles/global.css'
	import favicon from '$lib/assets/favicon.webp'
	import logo from '$lib/assets/logo.webp'
	import { page } from '$app/stores'
	import AlertStack from '$lib/AlertStack.svelte'

	const GALLERY_LOGO_TRIGGER_RATIO = 0.55

	let { children } = $props()
	let galleryInView = $state(false)
	const miniLogo = $derived($page.route.id === '/[id=uploadid]' || galleryInView)

	$effect(() => {
		const isHome = $page.route.id === '/'
		galleryInView = false
		if (!isHome) return

		let gallery: Element | undefined
		let mutationObserver: MutationObserver | undefined
		let syncFrame: number | undefined

		function syncLogo() {
			syncFrame = undefined
			if (!gallery) return

			const triggerY = window.innerHeight * GALLERY_LOGO_TRIGGER_RATIO
			galleryInView = gallery.getBoundingClientRect().top <= triggerY
		}

		function scheduleSync() {
			if (syncFrame !== undefined) return
			syncFrame = requestAnimationFrame(syncLogo)
		}

		function observeGallery() {
			gallery = document.querySelector('.gallery-section') ?? undefined
			if (!gallery) return false

			window.addEventListener('scroll', scheduleSync, { passive: true })
			window.addEventListener('resize', scheduleSync)
			syncLogo()
			return true
		}

		if (!observeGallery()) {
			mutationObserver = new MutationObserver(() => {
				if (observeGallery()) mutationObserver?.disconnect()
			})
			mutationObserver.observe(document.querySelector('.page-content') ?? document.body, {
				childList: true,
				subtree: true
			})
		}

		return () => {
			if (gallery) {
				window.removeEventListener('scroll', scheduleSync)
				window.removeEventListener('resize', scheduleSync)
			}
			if (syncFrame !== undefined) cancelAnimationFrame(syncFrame)
			mutationObserver?.disconnect()
		}
	})
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="app-shell">
	<header class="site-header">
		<a class="brand" class:mini={miniLogo} href="/" aria-label="Go to home">
			<img class="logo-img" src={logo} alt="femboyz.cloud">
		</a>

		<nav class="nav-links" aria-label="Main navigation">
			<a href="/">Home</a>
		</nav>
	</header>

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
	}

	.site-header {
		position: sticky;
		top: 0;
		z-index: 10;
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

	.brand {
		display: block;
		width: 17.91rem;
		transition: width 0.5s ease;
	}

	.brand .logo-img {
		width: 100%;
		transition: filter 0.35s ease-out, transform 0.25s ease;
	}

	.brand:hover .logo-img {
		transform: scale(1.03);
	}

	:global(.brand.mini) {
		width: 7.5rem;
	}

	:global(.brand.mini:hover) {
		width: 17.91rem;
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

	@media (max-width: 42rem) {
		.site-header {
			padding: 0 1rem;
		}

		.page-content {
			width: min(100% - 1.5rem, 72rem);
			padding: 1.5rem 0;
		}
	}
</style>
