<script module lang="ts">
    const apiEndpoint = import.meta.env.VITE_API_ENDPOINT ?? ''
    import { fetchUpload, type UploadData } from '$lib/upload/downloader'
    import { formatFileSize } from '$lib/upload/uploader'
    import { fade, scale } from 'svelte/transition'
</script>

<script lang="ts">
    let { id }: { id: string } = $props()

    let data = $state<UploadData | null>(null)
    let error = $state('')
    let expanded = $state(false)

    $effect(() => {
        data = null
        error = ''

        fetchUpload(id, apiEndpoint)
            .then((result) => { data = result })
            .catch((err) => { error = err instanceof Error ? err.message : 'Failed' })
    })

    let thumbnail = $derived(
        data?.files.find((f) => f.mime.startsWith('image/'))?.url ?? null
    )

    let label = $derived(data?.meta.title || id)

    let subtitle = $derived(() => {
        if (!data) return ''
        const count = data.files.length
        if (data.type === 'link') {
            try { return new URL(data.link ?? '').hostname } catch { return data.link ?? 'link' }
        }
        if (count === 1) return formatFileSize(data.files[0]!.size)
        return `${count} files`
    })

    let dateLabel = $derived(
        data ? new Date(data.when).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''
    )

    let totalSize = $derived(
        data?.files.reduce((sum, f) => sum + f.size, 0) ?? 0
    )

    function open() {
        if (data) expanded = true
    }

    function close() {
        expanded = false
    }

    function handleKeydown(e: KeyboardEvent) {
        if (expanded && e.key === 'Escape') close()
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<button class="mini-card" onclick={open} aria-label={label} disabled={!data && !error}>
    {#if error}
        <div class="state-box error" in:fade={{ duration: 300 }}>
            <span>{id}</span>
            <br />
            <span>{error}</span>
        </div>
    {:else if !data}
        <div class="state-box loading" aria-busy="true"></div>
    {:else}
        <div class="card-loaded" in:fade={{ duration: 300 }}>
            {#if thumbnail}
                <div class="thumb-wrap">
                    <img class="thumb" src={thumbnail} alt={label} loading="lazy" />
                </div>
            {:else}
                <div class="thumb-wrap no-thumb">
                    <span class="type-icon">{data.type === 'link' ? '↗' : data.type === 'playlist' ? '♫' : '📁'}</span>
                </div>
            {/if}

            <div class="card-info">
                <strong class="card-title">{label}</strong>
                <div class="card-meta">
                    <span class="card-subtitle">{subtitle()}</span>
                    {#if data.type !== "link"}
                        <span class="card-date">{dateLabel}</span>
                    {/if}
                </div>
            </div>
        </div>
    {/if}
</button>

{#if expanded && data}
    <div
        class="backdrop"
        role="presentation"
        in:fade={{ duration: 150 }}
        out:fade={{ duration: 150 }}
        onclick={close}
    >
        <div
            class="expanded-card"
            in:scale={{ duration: 200, start: 0.92 }}
            out:scale={{ duration: 150, start: 0.95 }}
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={label}
            aria-modal="true"
            tabindex="-1"
        >
            <a
                class="btn open-btn"
                href="/{id}"
                target="_blank"
                rel="noopener noreferrer"
                title="Open in new tab"
                aria-label="Open in new tab"
            >↗</a>

            <button class="btn close-btn" onclick={close} aria-label="Close">✕</button>

            {#if thumbnail}
                <div class="expanded-thumb-wrap">
                    <img class="expanded-thumb" src={thumbnail} alt={label} />
                </div>
            {:else}
                <div class="expanded-thumb-wrap no-thumb">
                    <span class="type-icon-large">{data.type === 'link' ? '↗' : data.type === 'playlist' ? '♫' : '📁'}</span>
                </div>
            {/if}

            <div class="expanded-info">
                <div class="expanded-header">
                    <h2 class="expanded-title">{label}</h2>
                    <span class="expanded-type-badge">{data.type}</span>
                </div>

                <div class="expanded-meta-row">
                    <span class="expanded-date">{dateLabel}</span>
                    {#if data.type !== 'link' && data.files.length > 1}
                        <span class="expanded-total">{formatFileSize(totalSize)} total</span>
                    {/if}
                </div>

                {#if data.type === 'link' && data.link}
                    <a class="expanded-link-url" href={data.link} target="_blank" rel="noopener noreferrer">{data.link}</a>
                {/if}

                {#if data.type !== 'link' && data.files.length > 0}
                    <ul class="expanded-file-list">
                        {#each data.files as file}
                            <li class="expanded-file-item">
                                <span class="expanded-file-name">{file.filename}</span>
                                <span class="expanded-file-size">{formatFileSize(file.size)}</span>
                            </li>
                        {/each}
                    </ul>
                {/if}

                {#if data.meta.desc}
                    <h5 style="margin-bottom: 0; margin-top: 0.8rem;">Description:</h5>
                    <p class="expanded-desc">{data.meta.desc}</p>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .mini-card {
        display: flex;
        flex-direction: column;
        text-decoration: none;
        color: inherit;
        background: #1e1b1c;
        border: 1px solid #3b3538;
        overflow: hidden;
        transition: border-color 0.15s ease-out, transform 0.2s ease-out;
        cursor: pointer;
        padding: 0;
        font: inherit;
        text-align: left;
        width: 100%;
    }

    .mini-card:hover:not(:disabled),
    .mini-card:focus-visible:not(:disabled) {
        border-color: var(--color-accent);
        transform: scale(1.01);
        outline: none;
    }

    .mini-card:disabled {
        cursor: default;
    }

    .card-loaded {
        display: flex;
        flex-direction: column;
        flex: 1;
        width: 100%;
    }

    .state-box {
        height: 10rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        font-size: 0.8rem;
        color: #8a8385;
        text-align: center;
        padding: 0.5rem;
    }

    .state-box.error span {
        color: #ffb3c7;
        display: block;
        margin-top: 0.25rem;
    }

    .state-box.loading {
        background: linear-gradient(90deg, #252222 25%, #2e2a2b 50%, #252222 75%);
        background-size: 200% 100%;
        animation: shimmer 1.4s infinite;
    }

    @keyframes shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
    }

    .thumb-wrap {
        width: 100%;
        aspect-ratio: 4 / 3;
        overflow: hidden;
        background: #171515;
        flex-shrink: 0;
    }

    .thumb {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }

    .no-thumb {
        display: flex;
        align-items: center;
        justify-content: center;
        background: #1a1718;
    }

    .type-icon {
        font-size: 3rem;
        opacity: 0.3;
    }

    .card-info {
        padding: 0.65rem 0.75rem;
        display: grid;
        gap: 0.3rem;
    }

    .card-title {
        font-size: 0.9rem;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        display: block;
    }

    .card-meta {
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
        font-size: 0.78rem;
        color: #8a8385;
    }

    .card-date {
        flex-shrink: 0;
    }

    /* ── Modal ── */

    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.72);
        backdrop-filter: blur(4px);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
    }

    .expanded-card {
        position: relative;
        background: #1e1b1c;
        border: 1px solid #3b3538;
        width: 100%;
        max-width: 30rem;
        max-height: 90vh;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
    }

    .expanded-card .btn {
        position: absolute;
        top: 0.6rem;
        width: 2rem;
        height: 2rem;
        box-sizing: border-box;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
        border: 1px solid #4b4246;
        color: #c9c3c5;
        cursor: pointer;
        font-size: 1rem;
        z-index: 10;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
    }

    .open-btn {
        right: 2.8rem;
        background: rgba(30, 27, 28, 0.85);
    }

    .open-btn:hover {
        background: #3b3538;
        color: #fff;
        border-color: #6b6068;
    }

    .close-btn {
        right: 0.6rem;
        background: rgba(30, 27, 28, 0.85);
    }

    .close-btn:hover {
        background: var(--color-accent);
        border-color: var(--color-accent);
        color: #fff;
    }

    .expanded-thumb-wrap {
        width: 100%;
        aspect-ratio: 16 / 9;
        overflow: hidden;
        background: #171515;
        flex-shrink: 0;
    }

    .expanded-thumb-wrap.no-thumb {
        display: flex;
        align-items: center;
        justify-content: center;
        background: #1a1718;
    }

    .expanded-thumb {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }

    .type-icon-large {
        font-size: 4.5rem;
        opacity: 0.25;
    }

    .expanded-info {
        padding: 1rem 1.1rem 1.25rem;
        display: grid;
        gap: 0.75rem;
        min-width: 0;
        overflow: hidden;
    }

    .expanded-header {
        display: flex;
        align-items: flex-start;
        gap: 0.6rem;
    }

    .expanded-title {
        margin: 0;
        font-size: 1.1rem;
        line-height: 1.3;
        flex: 1;
        word-break: break-word;
    }

    .expanded-type-badge {
        flex-shrink: 0;
        font-size: 0.72rem;
        color: #8a8385;
        border: 1px solid #3b3538;
        padding: 0.15rem 0.45rem;
        margin-top: 0.2rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .expanded-desc {
        margin: 0;
        font-size: 0.88rem;
        color: #c9c3c5;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .expanded-meta-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.8rem;
        color: #8a8385;
    }

    .expanded-file-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.4rem;
    }

    .expanded-file-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
        padding: 0.55rem 0.7rem;
        background: #171515;
        border: 1px solid #2e2a2b;
        font-size: 0.82rem;
    }

    .expanded-file-name {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
        color: #ddd7d9;
    }

    .expanded-file-size {
        flex-shrink: 0;
        color: #8a8385;
    }

    .expanded-link-url {
        display: block;
        font-size: 0.82rem;
        color: #c9c3c5;
        word-break: break-all;
        text-decoration: underline;
        text-underline-offset: 3px;
    }

    .expanded-link-url:hover {
        color: #fff;
    }
</style>
