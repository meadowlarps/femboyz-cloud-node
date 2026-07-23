<script lang="ts">
    import type { PageData } from './$types'
    import FilesView from './FilesView.svelte'
    import AlbumView from './AlbumView.svelte'
    import PlaylistView from './PlaylistView.svelte'
    import CopyLinkButton from '$lib/CopyLinkButton.svelte'

    let { data }: { data: PageData } = $props()

    const upload = $derived(data.upload)
    const title = $derived(upload.meta.title || upload.id)
    const desc = $derived(upload.meta.desc)
    const uploadUrl = $derived(`/${upload.id}`)
    const preview = $derived(data.preview)

    function formatDate(iso: string) {
        return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    }

    const typeLabel: Record<string, string> = {
        files: 'Files',
        album: 'Album',
        playlist: 'Playlist'
    }
</script>

<svelte:head>
    <title>{preview.title}</title>
    <meta name="description" content={preview.description} />
    <meta property="og:title" content={preview.title} />
    <meta property="og:description" content={preview.description} />
    <meta property="og:type" content="website" />
    <meta property="og:url" content={preview.canonicalUrl} />
    <meta property="og:site_name" content={preview.siteName} />
    {#if preview.cardImageUrl}
        <meta property="og:image" content={preview.cardImageUrl} />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content={preview.cardImageAlt ?? preview.title} />
    {:else if preview.image}
        <meta property="og:image" content={preview.image.url} />
        <meta property="og:image:type" content={preview.image.mime} />
        <meta property="og:image:alt" content={preview.image.filename} />
    {:else if preview.video}
        <meta property="og:video" content={preview.video.url} />
        <meta property="og:video:type" content={preview.video.mime} />
    {/if}
</svelte:head>

{#if upload.type === 'album'}
    <AlbumView files={upload.files}>
        <div class="album-info">
            <div class="upload-title-row">
                <div class="upload-title-group">
                    <h1 class="upload-title"><a href={uploadUrl}>{title}</a></h1>
                    <CopyLinkButton url={uploadUrl} label={`Copy link to ${title}`} />
                </div>
            </div>
            {#if desc}
                <p class="upload-desc">{desc}</p>
            {/if}
            <div class="upload-meta-row">
                <span class="meta-item">{formatDate(upload.when)}</span>
                {#if upload.views > 0}
                    <span class="meta-item">{upload.views} {upload.views === 1 ? 'view' : 'views'}</span>
                {/if}
                <span class="meta-item">{upload.files.length} {upload.files.length === 1 ? 'file' : 'files'}</span>
            </div>
        </div>
    </AlbumView>
{:else}
    <div class="panel-wrap">
    <div class="upload-panel">
        <header class="upload-header">
            <div class="upload-title-row">
                <div class="upload-title-group">
                    <h1 class="upload-title"><a href={uploadUrl}>{title}</a></h1>
                    <CopyLinkButton url={uploadUrl} label={`Copy link to ${title}`} />
                </div>
                <span class="upload-type-badge">{typeLabel[upload.type] ?? upload.type}</span>
            </div>

            {#if desc}
                <p class="upload-desc">{desc}</p>
            {/if}

            <div class="upload-meta-row">
                <span class="meta-item">{formatDate(upload.when)}</span>
                {#if upload.views > 0}
                    <span class="meta-item">{upload.views} {upload.views === 1 ? 'view' : 'views'}</span>
                {/if}
                <span class="meta-item">{upload.files.length} {upload.files.length === 1 ? 'file' : 'files'}</span>
            </div>
        </header>

        <div class="upload-body">
            {#if upload.type === 'files'}
                <FilesView files={upload.files} />
            {:else if upload.type === 'playlist'}
                <PlaylistView files={upload.files} />
            {/if}
        </div>
    </div>
    </div>
{/if}

<style>
    .album-info {
        display: grid;
        gap: 0.5rem;
        padding: 1rem 1.25rem;
        border: 1px solid #2e2b2c;
    }

    /* Panel — files / playlist */
    .panel-wrap {
        display: flex;
        justify-content: center;
    }

    .upload-panel {
        display: inline-grid;
        min-width: min(38rem, 100%);
        max-width: min(100%, 48rem);
        background: #221f20;
        border: 2px solid var(--color-accent);
        overflow: hidden;
    }

    .upload-header {
        display: grid;
        gap: 0.65rem;
        padding: 1.5rem 1.5rem 1.25rem;
        border-bottom: 1px solid #3b3538;
    }

    .upload-body {
        display: grid;
        padding: 1.25rem 1.5rem 1.5rem;
    }

    /* Shared */
    .upload-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        flex-wrap: wrap;
    }

    .upload-title {
        margin: 0;
        font-size: 1.75rem;
        line-height: 1.2;
        overflow-wrap: anywhere;
    }

    .upload-title-group {
        display: flex;
        align-items: center;
        min-width: 0;
        gap: 0.5rem;
    }

    .upload-title a {
        color: inherit;
        text-decoration: none;
    }

    .upload-title a:hover {
        color: var(--color-accent);
        text-decoration: underline;
        text-underline-offset: 0.15em;
    }

    .upload-title a:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 3px;
    }

    .upload-type-badge {
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--color-accent);
        border: 1px solid var(--color-accent);
        padding: 0.2rem 0.5rem;
        flex-shrink: 0;
    }

    .upload-desc {
        margin: 0;
        color: #c9c3c5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }

    .upload-meta-row {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
    }

    .meta-item {
        font-size: 0.85rem;
        color: #6a6468;
    }

    .meta-item + .meta-item::before {
        content: '·';
        margin-right: 1rem;
    }

    @media (max-width: 36rem) {
        .upload-header,
        .upload-body {
            padding-left: 1rem;
            padding-right: 1rem;
        }
    }
</style>
