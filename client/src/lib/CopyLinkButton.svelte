<script lang="ts">
    import { onDestroy } from 'svelte'
    import { spawnAlert } from '$lib/alerts'

    let { url, label }: { url: string; label: string } = $props()

    let status = $state<'idle' | 'copied' | 'error'>('idle')
    let resetTimer: ReturnType<typeof setTimeout> | undefined

    onDestroy(() => clearTimeout(resetTimer))

    async function copyLink() {
        clearTimeout(resetTimer)

        try {
            await navigator.clipboard.writeText(new URL(url, window.location.href).href)
            status = 'copied'
            spawnAlert('success', 'Link copied')
        } catch {
            status = 'error'
            spawnAlert('error', 'Could not copy link')
        }

        resetTimer = setTimeout(() => status = 'idle', 2000)
    }
</script>

<button
    class="copy-link"
    class:copied={status === 'copied'}
    class:error={status === 'error'}
    type="button"
    aria-label={status === 'copied' ? `${label}: copied` : label}
    title={status === 'copied' ? 'Copied' : label}
    onclick={copyLink}
>
    {#if status === 'copied'}
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 12 4 4L19 6" />
        </svg>
    {:else}
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.15-1.15" />
        </svg>
    {/if}
</button>

<span class="sr-only" aria-live="polite">
    {status === 'copied' ? 'Link copied' : status === 'error' ? 'Could not copy link' : ''}
</span>

<style>
    .copy-link {
        display: grid;
        place-items: center;
        flex: 0 0 auto;
        width: 1.75rem;
        height: 1.75rem;
        padding: 0.3rem;
        color: #8a8385;
        background: transparent;
        border: 0;
        border-radius: 0.2rem;
        cursor: pointer;
        transition: color 120ms ease, background 120ms ease, transform 100ms ease;
    }

    .copy-link:hover {
        color: var(--color-fb-white);
        background: #2b2729;
    }

    .copy-link:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }

    .copy-link:active {
        transform: scale(0.82);
    }

    .copy-link.copied {
        color: #7dd3a7;
        animation: copy-confirm 280ms cubic-bezier(0.2, 0.8, 0.3, 1.35);
    }

    .copy-link.error {
        color: var(--color-accent);
    }

    svg {
        width: 100%;
        height: 100%;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
    }

    @keyframes copy-confirm {
        0% { transform: scale(0.92); }
        60% { transform: scale(1.05); }
        100% { transform: scale(1); }
    }

    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }

    @media (prefers-reduced-motion: reduce) {
        .copy-link {
            transition: none;
            animation: none;
        }

        .copy-link:active { transform: none; }
    }
</style>
