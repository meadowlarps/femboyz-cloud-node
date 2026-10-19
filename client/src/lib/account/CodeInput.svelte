<script lang="ts">
    // Four single-digit boxes that behave like one field: typing moves on, backspace moves
    // back, and pasting "1234" (or "12 34") anywhere fills all four.
    // No autocomplete="one-time-code": codes come by email, not SMS, and that hint is what
    // makes password managers (Bitwarden, 1Password) attach their fill menus to the boxes.
    let {
        value = $bindable(''),
        disabled = false,
        oncomplete
    }: { value?: string; disabled?: boolean; oncomplete?: (code: string) => void } = $props()

    const LENGTH = 4
    let digits = $state<string[]>(Array.from({ length: LENGTH }, (_, i) => value[i] ?? ''))
    let inputs: HTMLInputElement[] = []

    $effect(() => {
        if (value === '' && digits.some(Boolean)) digits = Array(LENGTH).fill('')
    })

    function commit() {
        value = digits.join('')
        if (value.length === LENGTH && /^\d{4}$/.test(value)) oncomplete?.(value)
    }

    function fill(from: number, text: string) {
        const incoming = text.replace(/\D/g, '').slice(0, LENGTH - from)
        if (!incoming) return
        const next = [...digits]
        for (let i = 0; i < incoming.length; i++) next[from + i] = incoming[i]!
        digits = next
        inputs[Math.min(from + incoming.length, LENGTH - 1)]?.focus()
        commit()
    }

    function onInput(index: number, event: Event) {
        const input = event.currentTarget as HTMLInputElement
        const typed = input.value.replace(/\D/g, '')
        input.value = digits[index] ?? ''
        if (typed) fill(index, typed)
    }

    function onKeydown(index: number, event: KeyboardEvent) {
        if (event.key === 'Backspace') {
            event.preventDefault()
            const next = [...digits]
            if (next[index]) next[index] = ''
            else if (index > 0) { next[index - 1] = ''; inputs[index - 1]?.focus() }
            digits = next
            commit()
        } else if (event.key === 'ArrowLeft' && index > 0) {
            inputs[index - 1]?.focus()
        } else if (event.key === 'ArrowRight' && index < LENGTH - 1) {
            inputs[index + 1]?.focus()
        }
    }

    function onPaste(index: number, event: ClipboardEvent) {
        event.preventDefault()
        fill(index, event.clipboardData?.getData('text') ?? '')
    }

    export function focus() {
        const empty = digits.findIndex((digit) => !digit)
        inputs[empty === -1 ? LENGTH - 1 : empty]?.focus()
    }
</script>

<div class="code-input" role="group" aria-label="4-digit code">
    {#each digits as digit, index (index)}
        <input
            bind:this={inputs[index]}
            value={digit}
            inputmode="numeric"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            data-bwignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            maxlength={LENGTH}
            aria-label={`Digit ${index + 1}`}
            {disabled}
            oninput={(event) => onInput(index, event)}
            onkeydown={(event) => onKeydown(index, event)}
            onpaste={(event) => onPaste(index, event)}
            onfocus={(event) => (event.currentTarget as HTMLInputElement).select()}
        />
    {/each}
</div>

<style>
    .code-input {
        display: flex;
        gap: 0.5rem;
    }

    input {
        width: 3.5rem;
        height: 3.5rem;
        box-sizing: border-box;
        padding: 0;
        text-align: center;
        font: inherit;
        font-size: 1.5rem;
        font-weight: 700;
        color: var(--color-fb-white);
        background: #171515;
        border: 1px solid #4a4447;
        transition: border-color 0.2s ease-out;
    }

    input:hover {
        border-color: #6a6266;
    }

    input:focus {
        border-color: var(--color-accent);
        outline: none;
    }
</style>
