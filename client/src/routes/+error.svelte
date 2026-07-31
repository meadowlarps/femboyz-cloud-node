<script lang="ts">
	import { page } from '$app/stores'
	import lostBoy from '$lib/assets/404boy.webp'

	const notFound = $derived($page.status === 404)
</script>

<svelte:head>
	<title>{$page.status} {notFound ? 'Not Found' : 'Error'} | femboyz.cloud</title>
</svelte:head>

<section class="error-page">
	<div class="art" aria-hidden="true">
		<span>{$page.status}</span>
		<img src={lostBoy} alt="">
	</div>

	<div class="copy">
		{#if !notFound}
			<p class="eyebrow">Huh!?!?!?</p>
		{/if}
		<h1>
			{notFound 
				? 'We cant find this page' 
				: 'We broke something...'}
		</h1>
		<p>
			{notFound
				? 'The link may be broken, expired, or floating somewhere else'
				: 'Try again later or head back home'}
		</p>
		<a class="fb-button" href="/">Back to home</a>
	</div>
</section>

<style>
	.error-page {
		position: fixed;
		inset: 0;
		box-sizing: border-box;
		display: grid;
		grid-template-columns: minmax(14rem, 22rem) minmax(18rem, 31rem);
		align-items: center;
		align-content: center;
		justify-content: center;
		gap: clamp(2rem, 6vw, 5rem);
		padding: 1.5rem;
		overflow: auto;
	}

	.art {
		position: relative;
		display: grid;
		place-items: center;
		aspect-ratio: 1;
	}


	.art span {
		position: absolute;
		top: -1.5rem;
		left: -0.5rem;
		color: #fff0f30a;
		font-size: clamp(8rem, 19vw, 15rem);
		font-weight: 900;
		line-height: 1;
		letter-spacing: -0.12em;
	}

	.art img {
		position: relative;
		z-index: 1;
		width: min(75%, 16rem);
		height: auto;
		filter: drop-shadow(0 1.25rem 1.5rem #0008);
	}

	.copy {
		position: relative;
		z-index: 1;
	}

	.eyebrow {
		margin: 0 0 0.75rem;
		color: var(--color-accent);
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}

	h1 {
		max-width: 12ch;
		margin: 0;
		color: var(--color-fb-white);
		font-size: clamp(2.25rem, 5vw, 4.5rem);
		line-height: 0.98;
		letter-spacing: -0.045em;
		text-wrap: balance;
	}

	.copy > p:last-of-type {
		max-width: 37rem;
		margin: 1.35rem 0 2rem;
		color: var(--color-fb-white-semi);
		font-size: 1.05rem;
		line-height: 1.65;
	}

	.fb-button {
		display: inline-block;
		text-decoration: none;
	}

	.fb-button:focus-visible {
		outline: 2px solid var(--color-fb-white);
		outline-offset: 4px;
	}

	@media (max-width: 42rem) {
		.error-page {
			grid-template-columns: 1fr;
			gap: 0.5rem;
			text-align: center;
		}

		.art {
			width: min(70vw, 17rem);
			margin: 0 auto;
		}

		.art span {
			left: 50%;
			transform: translateX(-54%);
		}

		h1,
		.copy > p:last-of-type {
			margin-right: auto;
			margin-left: auto;
		}
	}
</style>
