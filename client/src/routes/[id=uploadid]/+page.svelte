<script lang="ts">
    import type { PageData } from './$types'
    import FilesView from './FilesView.svelte'
    import AlbumView from './AlbumView.svelte'
    import PlaylistView from './PlaylistView.svelte'
    import CommentsView from './CommentsView.svelte'
    import CopyLinkButton from '$lib/CopyLinkButton.svelte'
    import ViewIcon from '$lib/ViewIcon.svelte'
    import { markUploadViewed } from '$lib/upload/downloader'

    let { data }: { data: PageData } = $props()

    const comments = $derived(data.comments)
    const apiEndpoint = $derived(data.apiEndpoint)

    let viewIncrement = $state(0)

    const upload = $derived(data.upload)
    const uploadId = $derived(data.upload.id)
    const viewCount = $derived(upload.views + viewIncrement)
    const title = $derived(upload.meta.title || upload.id)
    const desc = $derived(upload.meta.desc)
    const uploadUrl = $derived(`/${upload.id}`)
    const preview = $derived(data.preview)

    $effect(() => {
        const id = uploadId
        viewIncrement = 0

        const viewTimer = setTimeout(async () => {
            try {
                await markUploadViewed(id, apiEndpoint)
                if (uploadId === id) viewIncrement = 1
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                console.warn(`Failed to count view of ${id}: ${message}`)
            }
        }, 2000)

        return () => clearTimeout(viewTimer)
    })

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
    <meta property="og:title" content={preview.title} />
    {#if preview.description}
        <meta name="description" content={preview.description} />
        <meta property="og:description" content={preview.description} />
    {/if}
    <meta property="og:site_name" content={preview.siteName} />
    <meta property="og:type" content="website" />
    <meta property="og:url" content={preview.canonicalUrl} />
    {#if preview.cardImageUrl}
        <meta property="og:image" content={preview.cardImageUrl} />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="720" />
        <meta property="og:image:height" content="600" />
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
    <AlbumView
        files={upload.files}
        comments={upload.public ? comments : undefined}
        upload_id={uploadId}
        api_endpoint={apiEndpoint}
    >
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
                <div class="upload-meta-details">
                    <span class="meta-item">{formatDate(upload.when)}</span>
                    <span class="meta-item">{upload.files.length} {upload.files.length === 1 ? 'file' : 'files'}</span>
                </div>
                <span class="view-count" aria-label={`${viewCount} ${viewCount === 1 ? 'view' : 'views'}`}>
                    <ViewIcon />
                    <span class="view-count-number" class:incremented={viewIncrement > 0} aria-hidden="true">
                        <span class="previous-count">{upload.views}</span>
                        <span class="next-count">{upload.views + 1}</span>
                    </span>
                </span>
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
                <div class="upload-meta-details">
                    <span class="meta-item">{formatDate(upload.when)}</span>
                    <span class="meta-item">{upload.files.length} {upload.files.length === 1 ? 'file' : 'files'}</span>
                </div>
                <span class="view-count" aria-label={`${viewCount} ${viewCount === 1 ? 'view' : 'views'}`}>
                    <ViewIcon />
                    <span class="view-count-number" class:incremented={viewIncrement > 0} aria-hidden="true">
                        <span class="previous-count">{upload.views}</span>
                        <span class="next-count">{upload.views + 1}</span>
                    </span>
                </span>
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
        {#if upload.public}
            <CommentsView {comments} upload_id={uploadId} api_endpoint={apiEndpoint} />
        {/if}
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
        display: grid;
        grid-template-columns: minmax(0, 48rem);
        justify-content: center;
        gap: 1rem;
    }

    .upload-panel {
        display: inline-grid;
        min-width: 0;
        max-width: 100%;
        background: #221f20;
        border: 1px solid #2e2b2c;
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

    .upload-meta-row,
    .upload-meta-details {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
    }

    .meta-item {
        font-size: 0.85rem;
        color: #6a6468;
    }

    .upload-meta-details .meta-item + .meta-item::before {
        content: '·';
        margin-right: 1rem;
    }

    .view-count {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        margin-left: auto;
        color: #6a6468;
        font-size: 0.85rem;
        font-variant-numeric: tabular-nums;
        line-height: 1;
    }

    .view-count-number {
        display: inline-grid;
        overflow: hidden;
    }

    .view-count-number > span {
        grid-area: 1 / 1;
        min-width: 1ch;
        text-align: right;
        transition-property: opacity, transform, filter;
        transition-duration: 220ms;
        transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
    }

    .previous-count {
        opacity: 1;
        transform: translateY(0);
        filter: blur(0);
    }

    .next-count {
        opacity: 0;
        transform: translateY(0.25rem);
        filter: blur(2px);
    }

    .view-count-number.incremented .previous-count {
        opacity: 0;
        transform: translateY(-0.25rem);
        filter: blur(2px);
    }

    .view-count-number.incremented .next-count {
        opacity: 1;
        transform: translateY(0);
        filter: blur(0);
    }

    .view-count {
        --view-icon-size: 1rem;
    }

    @media (prefers-reduced-motion: reduce) {
        .view-count-number > span {
            transform: none;
            filter: none;
            transition-duration: 0.01ms;
        }
    }

    @media (max-width: 36rem) {
        .upload-header,
        .upload-body {
            padding-left: 1rem;
            padding-right: 1rem;
        }
    }
</style>
