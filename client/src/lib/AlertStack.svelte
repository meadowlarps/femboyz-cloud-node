<script lang="ts">
    import { fade, fly } from 'svelte/transition'
    import { prefersReducedMotion } from 'svelte/motion'
    import { alerts, dismissAlert } from '$lib/alerts'
</script>

<section class="alert-stack" aria-label="Notifications">
    {#each $alerts as alert (alert.id)}
        <div
            class="alert"
            class:info={alert.type === 'info'}
            class:success={alert.type === 'success'}
            class:warning={alert.type === 'warning'}
            class:error={alert.type === 'error'}
            role={alert.type === 'error' ? 'alert' : 'status'}
            in:fly={{ x: prefersReducedMotion.current ? 0 : 24, duration: prefersReducedMotion.current ? 0 : 600 }}
            out:fade={{ duration: prefersReducedMotion.current ? 0 : 250 }}
        >
            <span class="message">{alert.text}</span>
            <button type="button" style="margin: 0; " onclick={() => dismissAlert(alert.id)} aria-label="Dismiss notification">
                &times;
            </button>
        </div>
    {/each}
</section>

<style>
    .alert-stack {
        position: fixed;
        z-index: 100;
        right: max(1rem, env(safe-area-inset-right));
        bottom: max(1rem, env(safe-area-inset-bottom));
        display: grid;
        justify-items: end;
        gap: 0.5rem;
        width: min(22rem, calc(100vw - 2rem));
        pointer-events: none;
    }

    .alert {
        --alert-color: #55a7e8;
        --alert-background: #202a329a;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.65rem;
        width: fit-content;
        max-width: 100%;
        padding: 0.65rem 0.75rem 0.65rem 1.2rem;
        color: #f4f4f4;
        background: var(--alert-background);
        backdrop-filter: blur(12px);
        border: 1px solid var(--alert-color);
        box-shadow: 0 0.4rem 1.25rem rgb(0 0 0 / 35%);
        pointer-events: auto;
    }

    .alert.success {
        --alert-color: #45c98a;
        --alert-background: #2030297a;
    }

    .alert.warning {
        --alert-color: #e9b949;
        --alert-background: #332d2094;
    }

    .alert.error {
        --alert-color: #ef5b68;
        --alert-background: #332124a4;
    }

    .message {
        font-size: 0.875rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
    }

    button {
        position: relative;
        top: -0.06em;
        display: grid;
        place-items: center;
        width: 1.5rem;
        height: 1.5rem;
        padding: 0;
        color: #8a8385;
        background: transparent;
        border: 0;
        font: inherit;
        font-size: 1.15rem;
        line-height: 1;
        cursor: pointer;
    }

    button:hover {
        color: #fff;
    }

    button:focus-visible {
        outline: 2px solid var(--alert-color);
        outline-offset: 2px;
    }

    @media (max-width: 36rem) {
        .alert-stack {
            right: 0.75rem;
            bottom: 0.75rem;
            width: calc(100vw - 1.5rem);
        }
    }
</style>
