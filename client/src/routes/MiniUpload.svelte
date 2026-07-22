<script lang="ts">
    import emblaCarouselSvelte from 'embla-carousel-svelte'
    import type { EmblaCarouselType, EmblaOptionsType } from 'embla-carousel'
    import { onDestroy } from 'svelte'
    import { prefersReducedMotion } from 'svelte/motion'
    import { fade } from 'svelte/transition'
    import { fetchUpload, type UploadData } from '$lib/upload/downloader'
    import { formatFileSize } from '$lib/upload/uploader'
    import CopyLinkButton from '$lib/CopyLinkButton.svelte'

    const apiEndpoint = import.meta.env.VITE_API_ENDPOINT ?? ''

    type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'document' | 'binary'

    let { id, onIgnore }: { id: string; onIgnore: (id: string) => void } = $props()

    let data = $state<UploadData | null>(null)
    let error = $state('')
    let ignored = $state(false)
    let carouselApi = $state<EmblaCarouselType>()
    let cardRoot = $state<HTMLElement>()
    let selectedIndex = $state(0)
    let cardHovered = $state(false)
    let persistentSelection = $state(false)
    let returnTimer: ReturnType<typeof setTimeout> | undefined

    const files = $derived(data?.files ?? [])
    const hasMultiple = $derived(files.length > 1)
    const label = $derived(data?.meta.title || id)
    const uploadUrl = $derived(`/${id}`)
    const dateLabel = $derived(
        data ? new Date(data.when).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''
    )
    const totalSize = $derived(files.reduce((sum, file) => sum + file.size, 0))
    const carouselOptions = $derived<EmblaOptionsType>({
        loop: false,
        watchDrag: hasMultiple
    })

    $effect(() => {
        const uploadId = id
        let cancelled = false

        data = null
        error = ''
        ignored = false
        selectedIndex = 0
        persistentSelection = false
        clearReturnTimer()

        fetchUpload(uploadId, apiEndpoint)
            .then((result) => {
                if (cancelled) return
                if (result.type === 'link') {
                    ignored = true
                    onIgnore(uploadId)
                    return
                }
                data = result
            })
            .catch((err) => {
                if (!cancelled) error = err instanceof Error ? err.message : 'Failed'
            })

        return () => { cancelled = true }
    })

    onDestroy(() => {
        clearReturnTimer()
        pauseVideos()
    })

    function clearReturnTimer() {
        clearTimeout(returnTimer)
        returnTimer = undefined
    }

    function pauseVideos() {
        cardRoot?.querySelectorAll('video').forEach((video) => video.pause())
    }

    function syncVideoPlayback() {
        cardRoot?.querySelectorAll('video').forEach((video) => {
            const isActive = Number(video.dataset.fileIndex) === selectedIndex
            if (cardHovered && isActive) {
                void video.play().catch(() => {})
            } else {
                video.pause()
            }
        })
    }

    function syncSelection(api: EmblaCarouselType) {
        selectedIndex = api.selectedScrollSnap()
        syncVideoPlayback()
    }

    function onCarouselInit(event: CustomEvent<EmblaCarouselType>) {
        carouselApi = event.detail
        syncSelection(carouselApi)
        carouselApi.on('select', syncSelection)
        carouselApi.on('pointerDown', () => {
            persistentSelection = true
            clearReturnTimer()
        })
    }

    function showMedia(index: number, jump = prefersReducedMotion.current) {
        carouselApi?.scrollTo(index, jump)
    }

    function previewMedia(index: number) {
        persistentSelection = false
        clearReturnTimer()
        showMedia(index)
    }

    function keepMedia(index: number) {
        persistentSelection = true
        clearReturnTimer()
        showMedia(index)
    }

    function scheduleFirstMedia() {
        if (persistentSelection) return
        clearReturnTimer()
        returnTimer = setTimeout(() => showMedia(0, true), 4000)
    }

    function handleCardEnter() {
        cardHovered = true
        syncVideoPlayback()
    }

    function handleCardLeave() {
        cardHovered = false
        pauseVideos()
    }

    function mimeKind(mime: string): FileKind {
        if (mime.startsWith('image/')) return 'image'
        if (mime.startsWith('video/')) return 'video'
        if (mime.startsWith('audio/')) return 'audio'
        if (mime === 'application/pdf') return 'pdf'
        if (/zip|compressed|archive|tar|rar|7z|gzip/.test(mime)) return 'archive'
        if (mime.startsWith('text/') || /json|xml|document|word|sheet|presentation/.test(mime)) return 'document'
        return 'binary'
    }

    function mimeLabel(mime: string) {
        const labels: Record<FileKind, string> = {
            image: 'IMG',
            video: 'VID',
            audio: 'AUD',
            pdf: 'PDF',
            archive: 'ZIP',
            document: 'DOC',
            binary: 'FILE'
        }
        return labels[mimeKind(mime)]
    }
</script>

{#if !ignored}
    <!-- Hover playback is a visual enhancement; all navigation remains keyboard-accessible. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <article
        class="mini-card"
        bind:this={cardRoot}
        onmouseenter={handleCardEnter}
        onmouseleave={handleCardLeave}
    >
        {#if error}
            <div class="state-box error" in:fade={{ duration: 300 }}>
                <strong>{id}</strong>
                <span>{error}</span>
            </div>
        {:else if !data}
            <div class="state-box loading" aria-busy="true" aria-label={`Loading ${id}`}></div>
        {:else}
            <div class="card-loaded" in:fade={{ duration: 300 }}>
                {#if data.type === 'album'}
                    <div
                        class="preview-stage"
                        role="region"
                        aria-label={`${label} preview`}
                        aria-roledescription="carousel"
                    >
                        <span class="type-badge">Album</span>
                        <div
                            class="embla-viewport"
                            use:emblaCarouselSvelte={{ options: carouselOptions, plugins: [] }}
                            onemblaInit={onCarouselInit}
                        >
                            <div class="embla-container">
                                {#each files as file, index (file.index)}
                                    <div
                                        class="embla-slide"
                                        role="group"
                                        aria-label={`${index + 1} of ${files.length}`}
                                        aria-hidden={index !== selectedIndex}
                                    >
                                        <a
                                            class="media-link"
                                            href={uploadUrl}
                                            aria-label={`Open ${label}`}
                                            tabindex={index === selectedIndex ? 0 : -1}
                                        >
                                            {#if file.mime.startsWith('image/')}
                                                <img src={file.url} alt="" loading="lazy" />
                                            {:else}
                                                <!-- Muted card previews have no spoken content or caption resource. -->
                                                <!-- svelte-ignore a11y_media_has_caption -->
                                                <video
                                                    src={file.url}
                                                    muted
                                                    playsinline
                                                    preload="metadata"
                                                    loop
                                                    data-file-index={index}
                                                    aria-hidden="true"
                                                ></video>
                                            {/if}
                                        </a>
                                    </div>
                                {/each}
                            </div>
                        </div>

                        {#if hasMultiple}
                            <div class="carousel-selectors" role="group" aria-label="Choose album media">
                                {#each files as file, index (file.index)}
                                    <button
                                        class:active={index === selectedIndex}
                                        type="button"
                                        aria-label={`Show ${file.filename}, ${index + 1} of ${files.length}`}
                                        aria-current={index === selectedIndex ? 'true' : undefined}
                                        onmouseenter={() => previewMedia(index)}
                                        onmouseleave={scheduleFirstMedia}
                                        onfocus={() => previewMedia(index)}
                                        onblur={scheduleFirstMedia}
                                        onclick={() => keepMedia(index)}
                                    ></button>
                                {/each}
                            </div>
                        {/if}
                    </div>
                {:else}
                    <a class="file-stage" href={uploadUrl} aria-label={`Open ${label}`}>
                        <span class="type-badge">{data.type}</span>
                        <span class="file-icons" aria-hidden="true">
                            {#each files as file (file.index)}
                                <span class="file-icon" data-kind={mimeKind(file.mime)}>
                                    {mimeLabel(file.mime)}
                                </span>
                            {/each}
                        </span>
                    </a>
                {/if}

                <footer class="card-info">
                    <div class="title-row">
                        <a class="card-title" href={uploadUrl} title={label}>{label}</a>
                        <CopyLinkButton url={uploadUrl} label={`Copy link to ${label}`} />
                    </div>
                    <div class="card-meta">
                        <span>{files.length} {files.length === 1 ? 'file' : 'files'} &middot; {formatFileSize(totalSize)}</span>
                        <time datetime={data.when}>{dateLabel}</time>
                    </div>
                </footer>
            </div>
        {/if}
    </article>
{/if}

<style>
    .mini-card {
        width: 100%;
        min-width: 0;
        overflow: hidden;
        color: inherit;
        background: #1e1b1c;
        border: 1px solid #3b3538;
        transition: border-color 150ms ease-out, transform 200ms ease-out;
    }

    .mini-card:hover,
    .mini-card:focus-within {
        border-color: var(--color-accent);
        transform: scale(1.01);
    }

    .card-loaded {
        display: flex;
        flex-direction: column;
        height: 100%;
    }

    .state-box {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        aspect-ratio: 4 / 3;
        padding: 0.75rem;
        color: #8a8385;
        font-size: 0.8rem;
        text-align: center;
    }

    .state-box.error {
        gap: 0.35rem;
        color: #ffb3c7;
    }

    .state-box.loading {
        background: linear-gradient(90deg, #252222 25%, #2e2a2b 50%, #252222 75%);
        background-size: 200% 100%;
        animation: shimmer 1.4s infinite;
    }

    .preview-stage,
    .file-stage {
        position: relative;
        display: block;
        width: 100%;
        aspect-ratio: 4 / 3;
        overflow: hidden;
        background: #171515;
    }

    .type-badge {
        position: absolute;
        z-index: 3;
        top: 0.65rem;
        left: 0.65rem;
        padding: 0.2rem 0.45rem;
        color: #f4f4f4;
        background: rgb(23 21 21 / 75%);
        border: 1px solid rgb(255 255 255 / 25%);
        font-size: 0.68rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        backdrop-filter: blur(0.25rem);
        pointer-events: none;
    }

    .embla-viewport,
    .embla-container,
    .embla-slide,
    .media-link {
        height: 100%;
    }

    .embla-viewport {
        overflow: hidden;
    }

    .embla-container {
        display: flex;
        touch-action: pan-y pinch-zoom;
    }

    .embla-slide {
        flex: 0 0 100%;
        min-width: 0;
    }

    .media-link {
        display: block;
        width: 100%;
    }

    .media-link:focus-visible,
    .file-stage:focus-visible,
    .card-title:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: -3px;
    }

    .media-link img,
    .media-link video {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .carousel-selectors {
        position: absolute;
        z-index: 4;
        left: 50%;
        bottom: 0.65rem;
        display: flex;
        gap: 0.4rem;
        padding: 0.35rem 0.45rem;
        transform: translateX(-50%);
        background: rgba(23, 21, 21, 0.583);
        border-radius: 5px;
        backdrop-filter: blur(12px) invert(0.1);
    }

    .carousel-selectors button {
        width: 0.65rem;
        height: 0.65rem;
        padding: 0;
        background: #d1cbcd;
        border: 0;
        border-radius: 50%;
        transition: background 150ms ease, transform 150ms ease;
    }

    .carousel-selectors button:hover,
    .carousel-selectors button:focus-visible {
        background: #fff;
    }

    .carousel-selectors button.active {
        background: var(--color-accent);
    }

    .file-stage {
        display: grid;
        place-items: center;
        color: inherit;
        text-decoration: none;
    }

    .file-icons {
        display: grid;
        grid-template-columns: repeat(auto-fit, 3.3rem);
        place-content: center;
        gap: 0.5rem;
        width: 100%;
        padding: 3rem 0.75rem 1rem;
        box-sizing: border-box;
    }

    .file-icon {
        --icon-color: #918a8d;
        display: grid;
        place-items: center;
        aspect-ratio: 1;
        color: var(--icon-color);
        border: 1px solid currentColor;
        font-size: 0.55rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        box-shadow: inset 0 -0.25rem 0 rgb(255 255 255 / 4%);
    }

    .file-icon[data-kind='image'] { --icon-color: #66b8e8; }
    .file-icon[data-kind='video'] { --icon-color: #c78be8; }
    .file-icon[data-kind='audio'] { --icon-color: #e887b3; }
    .file-icon[data-kind='pdf'] { --icon-color: #e86f77; }
    .file-icon[data-kind='archive'] { --icon-color: #e6b85f; }
    .file-icon[data-kind='document'] { --icon-color: #75cda5; }

    .card-info {
        display: grid;
        gap: 0.35rem;
        padding: 0.6rem 0.65rem;
        min-width: 0;
    }

    .title-row,
    .card-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-width: 0;
        gap: 0.5rem;
    }

    .card-title {
        min-width: 0;
        overflow: hidden;
        color: #f4f4f4;
        font-size: 0.9rem;
        font-weight: 700;
        text-decoration: none;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .card-title:hover {
        color: var(--color-accent);
        text-decoration: underline;
        text-underline-offset: 0.15em;
    }

    .card-meta {
        gap: 0.25rem;
        color: #8a8385;
        font-size: 0.68rem;
    }

    .card-meta time {
        flex: 0 0 auto;
    }

    @keyframes shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
    }

    @media (prefers-reduced-motion: reduce) {
        .mini-card,
        .carousel-selectors button {
            transition: none;
        }

        .state-box.loading {
            animation: none;
        }
    }
</style>
