<script lang="ts">
    import CopyTextButton from '$lib/CopyTextButton.svelte'
    import { fade } from 'svelte/transition'

    let { text }: { text: string } = $props()

    const lineCount = $derived(text.split('\n').length)
</script>

<div transition:fade class="note">
    <div class="note-toolbar">
        <span class="note-stats">
            {text.length.toLocaleString()} {text.length === 1 ? 'character' : 'characters'}
            &middot; {lineCount.toLocaleString()} {lineCount === 1 ? 'line' : 'lines'}
        </span>
        <CopyTextButton {text} />
    </div>
    <pre class="note-text">{text}</pre>
</div>

<style>
    .note {
        display: grid;
        gap: 0.85rem;
        min-width: 0;
    }

    .note-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        flex-wrap: wrap;
    }

    .note-stats {
        color: #6a6468;
        font-size: 0.85rem;
        font-variant-numeric: tabular-nums;
    }

    .note-text {
        margin: 0;
        padding: 1rem 1.1rem;
        max-height: 70vh;
        overflow: auto;
        color: #e8e3e5;
        background: #1a1718;
        border: 1px solid #3b3538;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.88rem;
        line-height: 1.55;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        tab-size: 4;
    }
</style>
