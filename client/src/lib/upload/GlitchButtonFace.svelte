<!--
    The upload button's face: a canvas of 8px blocks under a fine 4px LCD mesh, drawn inside the button
    (its parent element). At rest the blocks shimmer; hover or keyboard focus dissolves them to light
    block by block; busy runs a ragged band; progress fills with a sparking edge; done flashes and
    dissolves into the resting look of its tone. Switching the tone at rest flips the blocks over the
    same way hover does. The label is drawn on the canvas too, so each block gets the text colour that
    reads on it. The canvas is aria-hidden: the button keeps its own text for screen readers.
-->
<script lang="ts" module>
    export type GlitchPhase = 'rest' | 'busy' | 'progress' | 'done'
    export type GlitchTone = 'accent' | 'green'

    /** an empty slot as wide as a digit: pad numbers with it so the label keeps its width */
    export const FIGURE_SPACE = ' '
</script>

<script lang="ts">
    import { onMount } from 'svelte'
    import { prefersReducedMotion } from 'svelte/motion'
    import { formatFileSize } from './uploader'

    interface Props {
        phase: GlitchPhase
        /** 0..1, used by 'progress' */
        progress?: number
        /** the label; in 'progress' the face shows its own percentage instead, matching the bar */
        main: string
        sub?: string
        /** 'progress': the total size in bytes; the face then shows the loaded size as its own drawn fill
            of it instead of `sub`, so the size and the percentage always agree */
        total?: number
        /** 'progress' only: a short piece shown right after the percentage (the time left) */
        mid?: string
        /** whether hover and keyboard focus dissolve the button to its light state */
        hoverable?: boolean
        /** the colour at rest; 'done' settles into it */
        tone?: GlitchTone
        /** called once the bar has visibly reached the end after 'done', just before "done" plays */
        onfilled?: () => void
    }

    let { phase, progress = 0, main, sub = '', total, mid = '', hoverable = true, tone = 'accent', onfilled }: Props = $props()

    let canvas: HTMLCanvasElement

    const CELL = 4 // mesh pitch
    const BLOCK = 8 // colour blocks: 2×2 cells
    const HOVER_S = 0.32
    const TONE_S = 0.4
    const DONE_FLASH_S = 0.08
    const DONE_DISSOLVE_S = 0.4
    const OUTLINE_PX = 1.5
    const PAD_X = 14
    // every move of the bar eases out over this long, so even an instant upload plays its fill
    const FILL_S = 0.7
    const easeOut = (x: number) => 1 - (1 - x) ** 3

    type RGB = [number, number, number]
    const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
    // block classes: 0 rest, 1 hovered, 2 empty (busy / unfilled), 3 filled, 4 flash, 5 green rest, 6 green hovered
    const GAP = hex('#100e0f')
    const BG: RGB[] = [
        hex('#c30f45'), hex('#fff8fa'), hex('#3a1623'), hex('#c30f45'), hex('#ffffff'), hex('#2fd67a'), hex('#eafff2'),
    ]
    const TEXT = ['#ffffff', '#060606', '#fff0f3', '#ffffff', '#060606', '#04160b', '#04160b']
    // how strongly the mesh darkens each class; light blocks get a fainter mesh so they read as white
    const MESH = [0.5, 0.2, 0.5, 0.5, 0.2, 0.35, 0.2]
    const BG_CSS = BG.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`)

    function hash(x: number, y: number, z = 0) {
        let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1440662683)
        h = Math.imul(h ^ (h >>> 13), 1274126177)
        h ^= h >>> 16
        return (h >>> 0) / 4294967296
    }

    type Run = { s: string; x: number }
    /** lays text out with every digit in a slot as wide as the widest one (canvas has no tabular-nums) */
    function layout(ctx: CanvasRenderingContext2D, text: string) {
        let dw = 0
        for (const d of '0123456789') dw = Math.max(dw, ctx.measureText(d).width)
        const runs: Run[] = []
        let x = 0
        let buf = ''
        let bx = 0
        const flush = () => {
            if (!buf) return
            runs.push({ s: buf, x: bx })
            x = bx + ctx.measureText(buf).width
            buf = ''
        }
        for (const ch of text) {
            if ((ch >= '0' && ch <= '9') || ch === FIGURE_SPACE) {
                flush()
                if (ch !== FIGURE_SPACE) runs.push({ s: ch, x: x + (dw - ctx.measureText(ch).width) / 2 })
                x += dw
            } else {
                if (!buf) bx = x
                buf += ch
            }
        }
        flush()
        return { runs, width: x }
    }

    onMount(() => {
        const button = canvas.parentElement as HTMLElement
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // the label uses the page's font, read once rather than every frame
        const family = getComputedStyle(button).fontFamily
        let w = 0
        let h = 0
        let dpr = 1
        let cols = 0
        let rows = 0
        let bcols = 0
        let brows = 0
        let colour: RGB[] = []
        let cls = new Uint8Array(0)

        const resize = () => {
            w = button.clientWidth
            h = button.clientHeight
            dpr = window.devicePixelRatio || 1
            canvas.width = Math.round(w * dpr)
            canvas.height = Math.round(h * dpr)
            cols = Math.ceil(w / CELL)
            rows = Math.ceil(h / CELL)
            bcols = Math.ceil(w / BLOCK)
            brows = Math.ceil(h / BLOCK)
            colour = Array.from({ length: bcols * brows }, () => [0, 0, 0] as RGB)
            cls = new Uint8Array(bcols * brows)
        }
        const observer = new ResizeObserver(resize)
        observer.observe(button)
        resize()

        let hovering = false
        let focused = false
        const enter = () => { hovering = true }
        const leave = () => { hovering = false }
        const focus = () => { focused = button.matches(':focus-visible') }
        const blur = () => { focused = false }
        button.addEventListener('pointerenter', enter)
        button.addEventListener('pointerleave', leave)
        button.addEventListener('focus', focus)
        button.addEventListener('blur', blur)

        let hoverT = 0
        let toneT = tone === 'green' ? 1 : 0
        let lastT = performance.now() / 1000
        let lastLook: GlitchPhase = phase
        let phaseT = lastT
        let shownP = 0 // the fill as drawn, which trails the real progress on fast uploads
        let tweenFrom = 0
        let tweenTo = 0
        let tweenT = 0
        let filledSent = false
        let frame = 0

        const set = (i: number, c: RGB, k: number, n = 0) => {
            const m = 1 + n
            const o = colour[i]
            o[0] = Math.min(255, c[0] * m)
            o[1] = Math.min(255, c[1] * m)
            o[2] = Math.min(255, c[2] * m)
            cls[i] = k
        }

        const paint = (nowMs: number) => {
            frame = requestAnimationFrame(paint)
            if (!w || !h) return
            const t = nowMs / 1000
            const dt = Math.min(0.05, Math.max(0, t - lastT))
            lastT = t
            const still = prefersReducedMotion.current

            // the drawn fill eases out toward the real one, restarting from where it is whenever the
            // real one moves; 'done' keeps showing the bar until it has reached the end, then flashes
            const filling = phase === 'progress' || phase === 'done'
            const target = phase === 'done' ? 1 : progress
            if (!filling) {
                shownP = tweenFrom = tweenTo = 0
            } else if (still) {
                shownP = tweenTo = target
            } else {
                if (target > tweenTo) {
                    tweenFrom = shownP
                    tweenTo = target
                    tweenT = t
                }
                const k = (t - tweenT) / FILL_S
                shownP = k >= 1 ? tweenTo : tweenFrom + (tweenTo - tweenFrom) * easeOut(k) // lands exactly on the end
            }
            const look: GlitchPhase = phase === 'done' && shownP < 1 ? 'progress' : phase
            if (look !== lastLook) {
                lastLook = look
                phaseT = t
            }
            if (look !== 'done') filledSent = false
            else if (!filledSent) {
                filledSent = true
                onfilled?.()
            }
            const st = t - phaseT
            const active = hoverable && phase === 'rest' && (hovering || focused)
            hoverT = still ? (active ? 1 : 0) : Math.min(1, Math.max(0, hoverT + (active ? dt : -dt) / HOVER_S))
            // the flash covers a tone change, so 'done' takes the new tone at once
            const toneTo = tone === 'green' ? 1 : 0
            toneT = still || look !== 'rest' ? toneTo : Math.min(1, Math.max(0, toneT + (toneTo ? dt : -dt) / TONE_S))

            // label: measured first, so the blocks behind a centred label can flip as one plate
            const spread = look === 'progress'
            const mainText = spread ? `${Math.round(shownP * 100)}%` : main
            let subText = sub
            if (spread && total !== undefined) {
                const all = formatFileSize(total)
                subText = `${formatFileSize(Math.round(shownP * total)).padStart(all.length, FIGURE_SPACE)} / ${all}`
            } else if (spread && phase !== 'progress') subText = '' // the catch-up after 'done' shows just the percentage
            const fontMain = `700 16px ${family}`
            const fontSub = `600 13px ${family}`
            ctx.font = fontMain
            const ml = layout(ctx, mainText)
            ctx.font = fontSub
            let sl = subText ? layout(ctx, subText) : null
            const room = w - PAD_X * 2
            if (sl && ml.width + sl.width + (spread ? PAD_X : 6) > room) sl = null // narrow screens drop the details
            let mx: number
            let sx = 0
            // progress can carry a third piece (the time left), right after the percentage
            let midL = phase === 'progress' && mid ? layout(ctx, mid) : null
            let midX = 0
            if (spread) {
                mx = PAD_X
                if (sl) sx = Math.round(w - PAD_X - sl.width)
                if (midL) {
                    // anchored past the widest percentage ("100%"), so it stays put as the number grows
                    ctx.font = fontMain
                    midX = Math.round(mx + layout(ctx, '100%').width + 8)
                    ctx.font = fontSub
                    // dropped when it would run into the sizes on the right
                    if (midX + midL.width > (sl ? sx : w - PAD_X) - 10) midL = null
                }
            } else {
                mx = Math.round((w - (ml.width + (sl ? 6 + sl.width : 0))) / 2)
                sx = mx + ml.width + 6
            }
            const plate = spread ? null : {
                x0: Math.floor((mx - 6) / BLOCK),
                x1: Math.floor(((sl ? sx + sl.width : mx + ml.width) + 6) / BLOCK),
                y0: Math.floor((h / 2 - 12) / BLOCK),
                y1: Math.floor((h / 2 + 11) / BLOCK),
            }

            // blocks
            const fe = shownP * bcols
            const tick = (rate: number) => (still ? 0 : Math.floor(t * rate))
            for (let by = 0; by < brows; by++) for (let bx = 0; bx < bcols; bx++) {
                const i = by * bcols + bx
                const onPlate = !!plate && bx >= plate.x0 && bx <= plate.x1 && by >= plate.y0 && by <= plate.y1
                const seed = onPlate ? 0.5 : hash(bx, by, 7)
                // each block drifts a little in brightness, at its own pace
                const drift = still ? 0 : (hash(bx, by, Math.floor(t * 1.2 + hash(bx, by, 3) * 5)) - 0.5) * 0.1
                // blocks flip in a random order leaning left to right; the label's plate flips halfway
                const flipped = (f: number) => onPlate ? f >= 0.5 : f * 1.1 > seed * 0.78 + (bx / bcols) * 0.22
                const base = flipped(toneT) ? 5 : 0
                if (look === 'rest') {
                    const light = base + 1
                    if (flipped(hoverT)) set(i, BG[light], light, -Math.abs(drift) * 1.035) // light can't get brighter, so it only dims
                    else set(i, BG[base], base, drift)
                } else if (look === 'busy') {
                    const band = Math.max(4, bcols * 0.28)
                    const pos = (Math.sin((still ? 0 : st) * 3.4 - Math.PI / 2) * 0.5 + 0.5) * (bcols - band)
                    const e = Math.min(bx - pos, pos + band - bx)
                    const lit = e > 0 && hash(bx, by, tick(12)) < e / 2
                    set(i, lit ? BG[3] : BG[2], lit ? 3 : 2)
                } else if (look === 'progress') {
                    let lit = bx < fe - 1
                    if (!lit && bx < fe + 1) lit = hash(bx, by, tick(14)) < (fe + 1 - bx) / 2.5
                    set(i, lit ? BG[3] : BG[2], lit ? 3 : 2, lit ? drift : 0)
                } else {
                    const on = still ? false : st < DONE_FLASH_S || seed > (st - DONE_FLASH_S) / DONE_DISSOLVE_S
                    if (on) set(i, BG[4], 4)
                    else set(i, BG[base], base, drift)
                }
            }

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            for (let i = 0; i < colour.length; i++) {
                const c = colour[i]
                ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
                ctx.fillRect((i % bcols) * BLOCK, ((i / bcols) | 0) * BLOCK, BLOCK, BLOCK)
            }

            // mesh between cells only, each block's lines mixed toward the gap colour by its class;
            // the button is one gap short of whole blocks, so every edge ends on a cell
            for (let i = 0; i < colour.length; i++) {
                const c = colour[i]
                const a = MESH[cls[i]]
                ctx.fillStyle = `rgb(${(c[0] + (GAP[0] - c[0]) * a) | 0},${(c[1] + (GAP[1] - c[1]) * a) | 0},${(c[2] + (GAP[2] - c[2]) * a) | 0})`
                const x = (i % bcols) * BLOCK
                const y = ((i / bcols) | 0) * BLOCK
                ctx.beginPath()
                for (let k = 1; k <= BLOCK / CELL; k++) {
                    if (x + k * CELL < cols * CELL) ctx.rect(x + k * CELL - 1, y, 1, BLOCK)
                    if (y + k * CELL < rows * CELL) ctx.rect(x, y + k * CELL - 1, BLOCK, 1)
                }
                ctx.fill()
            }

            // text above the mesh, outlined in the colour of the block behind it
            ctx.textBaseline = 'middle'
            ctx.lineJoin = 'round'
            ctx.lineWidth = OUTLINE_PX * 2
            const y = Math.round(h / 2) + 0.5
            const drawRuns = (runs: Run[], x0: number, yy: number, alpha: number) => {
                for (const r of runs) ctx.strokeText(r.s, x0 + r.x, yy)
                ctx.globalAlpha = alpha
                for (const r of runs) ctx.fillText(r.s, x0 + r.x, yy)
                ctx.globalAlpha = 1
            }
            const drawLabel = (k: number) => {
                ctx.strokeStyle = BG_CSS[k]
                ctx.fillStyle = TEXT[k]
                ctx.font = fontMain
                drawRuns(ml.runs, mx, y, 1)
                ctx.font = fontSub
                if (sl) drawRuns(sl.runs, sx, y + 0.5, 0.9)
                if (midL) drawRuns(midL.runs, midX, y + 0.5, 0.9)
            }
            const present = new Set(cls)
            if (present.size === 1) drawLabel(cls[0])
            else for (const k of present) {
                ctx.save()
                ctx.beginPath()
                for (let i = 0; i < cls.length; i++) if (cls[i] === k) ctx.rect((i % bcols) * BLOCK, ((i / bcols) | 0) * BLOCK, BLOCK, BLOCK)
                ctx.clip()
                drawLabel(k)
                ctx.restore()
            }
        }
        frame = requestAnimationFrame(paint)

        return () => {
            cancelAnimationFrame(frame)
            observer.disconnect()
            button.removeEventListener('pointerenter', enter)
            button.removeEventListener('pointerleave', leave)
            button.removeEventListener('focus', focus)
            button.removeEventListener('blur', blur)
        }
    })
</script>

<canvas bind:this={canvas} aria-hidden="true"></canvas>

<style>
    canvas {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
    }
</style>
