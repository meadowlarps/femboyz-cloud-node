<script lang="ts">
    // TEMPORARY birthday event. To remove: delete this file, static/birthday/,
    // and the <BirthdayBanner /> line + import in src/routes/+page.svelte.
    // It also switches itself off after SHOW_UNTIL.
    import { onMount } from 'svelte'
    import { fade, scale } from 'svelte/transition'
    import { backOut } from 'svelte/easing'
    import { prefersReducedMotion } from 'svelte/motion'

    const SHOW_UNTIL = new Date('2026-11-22T00:00:00+03:00')
    const AUTO_CLOSE_MS = 9000
    const TEXT = 'ВАДИМ С ДНЕМ РОЖДЕНИЯ!!!'
    const COLORS = ['#c30f45', '#ff4f8b', '#ffd23f', '#3ec6ff', '#7cff6b', '#b46bff', '#fff0f3']

    type Piece = { x: number; delay: number; dur: number; drift: number; spin: number; color: string; w: number; h: number; round: boolean }

    let open = $state(false)
    let pieces = $state<Piece[]>([])
    let audio: HTMLAudioElement | undefined

    function burst() {
        const count = prefersReducedMotion.current ? 0 : 140
        pieces = Array.from({ length: count }, () => ({
            x: Math.random() * 100,
            delay: Math.random() * 0.6,
            dur: 2.6 + Math.random() * 2.4,
            drift: (Math.random() - 0.5) * 40,
            spin: (Math.random() - 0.5) * 1440,
            color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
            w: 6 + Math.random() * 8,
            h: 8 + Math.random() * 12,
            round: Math.random() < 0.3
        }))
    }

    function pop(): Promise<void> {
        if (!audio) return Promise.resolve()
        audio.currentTime = 0
        return audio.play()
    }

    function celebrateAgain() {
        burst()
        pop().catch(() => {})
    }

    function close() {
        open = false
    }

    onMount(() => {
        if (Date.now() >= SHOW_UNTIL.getTime()) return
        audio = new Audio('/birthday/pop.mp3')
        audio.volume = 0.8
        open = true
        burst()

        // browsers block sound until the first interaction; pop on that one instead
        const onFirstGesture = () => {
            pop().catch(() => {})
            removeGesture()
        }
        const removeGesture = () => {
            window.removeEventListener('pointerdown', onFirstGesture, true)
            window.removeEventListener('keydown', onFirstGesture, true)
        }
        pop().catch(() => {
            window.addEventListener('pointerdown', onFirstGesture, true)
            window.addEventListener('keydown', onFirstGesture, true)
        })

        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        const timer = setTimeout(close, AUTO_CLOSE_MS)

        return () => {
            clearTimeout(timer)
            removeGesture()
            window.removeEventListener('keydown', onKey)
        }
    })
</script>

{#if open}
    <div class="bday" role="dialog" aria-label={TEXT} transition:fade={{ duration: 500 }}>
        <div class="confetti" aria-hidden="true">
            {#each pieces as p, i (i + ':' + p.x)}
                <span
                    class="piece"
                    class:round={p.round}
                    style:left="{p.x}%"
                    style:width="{p.w}px"
                    style:height="{p.round ? p.w : p.h}px"
                    style:background={p.color}
                    style:--drift="{p.drift}vw"
                    style:--spin="{p.spin}deg"
                    style:animation-duration="{p.dur}s"
                    style:animation-delay="{p.delay}s"
                ></span>
            {/each}
        </div>

        <button class="card" onclick={celebrateAgain} in:scale={{ duration: 900, start: 0.2, easing: backOut }} title="Ещё!">
            <span class="emoji" aria-hidden="true">🎂🎉🥳🎈🎁</span>
            <h1>
                {#each TEXT.split(' ') as word, wi}
                    <span class="word">
                        {#each word.split('') as ch, ci}
                            <span class="ch" style:animation-delay="{(wi * 6 + ci) * 0.06}s">{ch}</span>
                        {/each}
                    </span>
                {/each}
            </h1>
            <span class="hint">нажми ещё раз 🎊</span>
        </button>

        <button class="close fb-button" onclick={close}>Спасибо! ✕</button>
    </div>
{/if}

<style>
    .bday {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2rem;
        padding: 1rem;
        overflow: hidden;
        background:
            radial-gradient(circle at 50% 45%, #c30f4566, transparent 60%),
            #0d0a0bd9;
        backdrop-filter: blur(6px);
    }

    .confetti {
        position: absolute;
        inset: 0;
        pointer-events: none;
    }

    .piece {
        position: absolute;
        top: -5vh;
        border-radius: 2px;
        animation-name: fall;
        animation-timing-function: cubic-bezier(0.25, 0.4, 0.5, 1);
        animation-fill-mode: both;
        animation-iteration-count: 2;
    }

    .piece.round {
        border-radius: 50%;
    }

    @keyframes fall {
        0% { transform: translate(0, 0) rotate(0deg); opacity: 1; }
        85% { opacity: 1; }
        100% { transform: translate(var(--drift), 110vh) rotate(var(--spin)); opacity: 0; }
    }

    .card {
        position: relative;
        max-width: 100%;
        padding: clamp(1.25rem, 4vw, 3rem) clamp(1rem, 5vw, 4rem);
        border: 4px solid transparent;
        border-radius: 1.5rem;
        background:
            linear-gradient(#1a1214, #1a1214) padding-box,
            conic-gradient(from var(--angle, 0deg), #c30f45, #ffd23f, #3ec6ff, #b46bff, #ff4f8b, #c30f45) border-box;
        color: var(--color-fb-white);
        font: inherit;
        text-align: center;
        cursor: pointer;
        box-shadow: 0 0 60px #c30f4599, 0 0 140px #ff4f8b44;
        animation: spin-border 3s linear infinite, bob 2.4s ease-in-out infinite;
    }

    @property --angle {
        syntax: '<angle>';
        inherits: false;
        initial-value: 0deg;
    }

    @keyframes spin-border {
        to { --angle: 360deg; }
    }

    @keyframes bob {
        0%, 100% { translate: 0 0; }
        50% { translate: 0 -10px; }
    }

    .emoji {
        display: block;
        font-size: clamp(2rem, 7vw, 4rem);
        letter-spacing: 0.2em;
        animation: wiggle 1.2s ease-in-out infinite;
    }

    @keyframes wiggle {
        0%, 100% { rotate: -4deg; }
        50% { rotate: 4deg; }
    }

    h1 {
        margin: 0.5rem 0;
        font-size: clamp(2.25rem, 9vw, 7.5rem);
        font-weight: 900;
        line-height: 1.05;
        text-transform: uppercase;
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        column-gap: 0.3em;
    }

    .word {
        white-space: nowrap;
    }

    .ch {
        display: inline-block;
        background: linear-gradient(90deg, #ff4f8b, #ffd23f, #3ec6ff, #b46bff, #ff4f8b);
        background-size: 400% 100%;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        filter: drop-shadow(0 4px 0 #c30f45);
        animation: jump 1.4s ease-in-out infinite, rainbow 4s linear infinite;
    }

    @keyframes jump {
        0%, 60%, 100% { transform: translateY(0) scale(1); }
        30% { transform: translateY(-0.18em) scale(1.12); }
    }

    @keyframes rainbow {
        to { background-position: 400% 0; }
    }

    .hint {
        display: block;
        opacity: 0.7;
        font-size: 0.95rem;
    }

    .close {
        position: relative;
        border-radius: 999px;
    }

    @media (prefers-reduced-motion: reduce) {
        .card, .emoji, .ch {
            animation: none;
        }
    }
</style>
