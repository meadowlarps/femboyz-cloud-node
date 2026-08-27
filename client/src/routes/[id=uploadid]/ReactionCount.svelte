<script lang="ts">
    import { onMount } from 'svelte'
    import { prefersReducedMotion } from 'svelte/motion'

    let { value }: { value: number } = $props()

    let direction = $state(1)
    let generation = $state(0)
    let intro_enabled = $state(false)
    let last_value: number | undefined

    $effect.pre(() => {
        if (last_value === undefined) {
            last_value = value
            return
        }
        if (value === last_value) return
        direction = value > last_value ? 1 : -1
        last_value = value
        generation += 1
    })

    onMount(() => {
        intro_enabled = true
    })

    function count_slide(_node: Element, { dir }: { dir: number }) {
        const reduced = prefersReducedMotion.current || !intro_enabled
        return {
            duration: reduced ? 0 : 220,
            easing: (t: number) => 1 - (1 - t) ** 4,
            css: (t: number, u: number) =>
                `opacity:${t};transform:translateY(${u * dir * 0.25}rem);filter:blur(${u * 2}px)`
        }
    }
</script>

<span class="count">
    {#each [{ value, generation }] as item (item.generation)}
        <span
            class="value"
            in:count_slide={{ dir: direction }}
            out:count_slide={{ dir: -direction }}
        >{item.value}</span>
    {/each}
</span>

<style>
    .count {
        display: inline-grid;
        justify-items: center;
        overflow: hidden;
        font-variant-numeric: tabular-nums;
    }

    .value {
        grid-area: 1 / 1;
        min-width: 1ch;
        text-align: center;
    }

    @media (prefers-reduced-motion: reduce) {
        .value {
            transform: none;
            filter: none;
        }
    }
</style>
