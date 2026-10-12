<script lang="ts">
    import { onDestroy } from 'svelte'
    import { spawnAlert } from '$lib/alerts'

    let { text, label = 'Copy text' }: { text: string; label?: string } = $props()

    let status = $state<'idle' | 'copied' | 'error'>('idle')
    let resetTimer: ReturnType<typeof setTimeout> | undefined

    onDestroy(() => clearTimeout(resetTimer))

    async function copyText() {
        clearTimeout(resetTimer)

        try {
            await navigator.clipboard.writeText(text)
            // the button itself turns into "Copied" — no toast for the success case
            status = 'copied'
        } catch {
            status = 'error'
            spawnAlert('error', 'Could not copy text')
        }

        resetTimer = setTimeout(() => status = 'idle', 2000)
    }
</script>

<button
    class="copy-text fb-button fb-button-ghost"
    class:copied={status === 'copied'}
    class:error={status === 'error'}
    type="button"
    onclick={copyText}
>
    <!-- both states share one grid cell, so the button keeps the wider label's width and never jumps -->
    <span class="state" class:shown={status === 'copied'}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 12 4 4L19 6" />
        </svg>
        Copied
    </span>
    <span class="state" class:shown={status !== 'copied'}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="1.5" />
            <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
        </svg>
        {label}
    </span>
</button>

<span class="sr-only" aria-live="polite">
    {status === 'copied' ? 'Text copied' : status === 'error' ? 'Could not copy text' : ''}
</span>

<style>
    .copy-text {
        display: inline-grid;
        font-size: 0.88rem;
        padding: 0.5rem 0.9rem;
        white-space: nowrap;
        transition: color 220ms ease, border-color 220ms ease, background-color 220ms ease, transform 100ms ease;
    }

    /* the outgoing label shrinks and blurs away while the incoming one settles in, both in place */
    .state {
        grid-area: 1 / 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.45rem;
        visibility: hidden;
        opacity: 0;
        transform: scale(0.8);
        filter: blur(2px);
        transition-property: opacity, transform, filter, visibility;
        transition-duration: 220ms;
        transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
    }

    .state.shown {
        visibility: visible;
        opacity: 1;
        transform: none;
        filter: none;
    }

    .copy-text:active {
        transform: scale(0.96);
    }

    .copy-text.copied {
        color: #7dd3a7;
        border-color: #7dd3a7;
        background-color: transparent;
    }

    .copy-text.error {
        color: var(--color-accent);
    }

    svg {
        width: 1rem;
        height: 1rem;
        flex: 0 0 auto;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
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
        .copy-text {
            transition: none;
        }

        .state {
            transform: none;
            filter: none;
            transition-property: opacity, visibility;
        }

        .copy-text:active { transform: none; }
    }
</style>
