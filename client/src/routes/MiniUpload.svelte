<script lang="ts">
    import emblaCarouselSvelte from 'embla-carousel-svelte'
    import type { EmblaCarouselType, EmblaOptionsType } from 'embla-carousel'
    import { onDestroy } from 'svelte'
    import { prefersReducedMotion } from 'svelte/motion'
    import { fade } from 'svelte/transition'
    import type { FeedItem } from '$lib/upload/feed'
    import { buildMiniUploadTypeLabel } from '$lib/upload/miniUpload'
    import { formatFileSize } from '$lib/upload/uploader'
    import CopyLinkButton from '$lib/CopyLinkButton.svelte'
    import ViewIcon from '$lib/ViewIcon.svelte'

    type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'document' | 'binary'

    // Keep two readable rows even for uploads with a raised file limit.
    const FILE_ICON_LIMIT = 10

    // A card whose first media is slow (a big video on a slow link, or Safari
    // skipping its first frame under preload="metadata") shows up after this
    // long anyway, with the media area still shimmering until it arrives.
    const MEDIA_WAIT_MS = 8000

    // The parent fetches card data (in batches); while `initial` and `error` are
    // both unset the card shows its loading state.
    let {
        id,
        initial,
        error = '',
        onIgnore,
        showViews = false
    }: {
        id: string
        initial?: FeedItem
        error?: string
        onIgnore?: (id: string) => void
        showViews?: boolean
    } = $props()

    let data = $state<FeedItem | null>(null)
    let ignored = $state(false)
    let carouselApi = $state<EmblaCarouselType>()
    let cardRoot = $state<HTMLElement>()
    let selectedIndex = $state(0)
    let cardHovered = $state(false)
    let persistentSelection = $state(false)
    // Ids rather than booleans, so a card handed a new id starts over without
    // an effect resetting them (which could race the media's own load event).
    let mediaReadyFor = $state<string>()
    let mediaWaitExpiredFor = $state<string>()
    let firstMedia: HTMLImageElement | HTMLVideoElement | undefined
    let returnTimer: ReturnType<typeof setTimeout> | undefined

    const files = $derived(data?.files ?? [])
    const fileIconColumns = $derived(Math.max(1, Math.ceil(Math.min(files.length, FILE_ICON_LIMIT) / 2)))
    const previewFiles = $derived(files.slice(0, files.length > FILE_ICON_LIMIT ? FILE_ICON_LIMIT - 1 : FILE_ICON_LIMIT))
    const fileIconRows = $derived([previewFiles.slice(0, fileIconColumns), previewFiles.slice(fileIconColumns)])
    const remainingFileCount = $derived(files.length - previewFiles.length)
    const hasMultiple = $derived(files.length > 1)
    const label = $derived(data?.meta.title || id)
    const typeLabel = $derived(data ? buildMiniUploadTypeLabel(data) : '')
    const uploadUrl = $derived(`/${id}`)
    const dateLabel = $derived(
        data ? new Date(data.when).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''
    )
    const totalSize = $derived(files.reduce((sum, file) => sum + file.size, 0))
    const noteLength = $derived(data?.note_length ?? 0)
    const mediaReady = $derived(mediaReadyFor === id)
    const mediaWaitExpired = $derived(mediaWaitExpiredFor === id)
    // Album cards stay behind the skeleton until their first media has loaded,
    // so the whole card fades in at once instead of the picture popping in late.
    const revealed = $derived(data !== null && (data.type !== 'album' || files.length === 0 || mediaReady || mediaWaitExpired))
    const carouselOptions = $derived<EmblaOptionsType>({
        loop: false,
        watchDrag: hasMultiple
    })

    $effect(() => {
        const uploadId = id
        const preloaded = initial

        ignored = false
        selectedIndex = 0
        persistentSelection = false
        clearReturnTimer()

        if (preloaded?.type === 'link') {
            ignored = true
            onIgnore?.(uploadId)
            data = null
            return
        }
        data = preloaded ?? null
    })

    // Also re-checks the media itself, so a missed load event can't leave the
    // media area shimmering once the file is actually there.
    $effect(() => {
        if (!data || mediaReady) return
        const cardId = id
        const timer = setTimeout(() => {
            mediaWaitExpiredFor = cardId
            if (firstMedia && mediaLoaded(firstMedia)) mediaReadyFor = cardId
        }, MEDIA_WAIT_MS)
        return () => clearTimeout(timer)
    })

    function mediaLoaded(node: HTMLImageElement | HTMLVideoElement) {
        return node instanceof HTMLImageElement
            ? node.complete
            : node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    }

    // Marks the card ready once the first slide is on screen; failures count
    // too, so a broken file doesn't hold the card back.
    function watchFirstMedia(node: HTMLImageElement | HTMLVideoElement, first: boolean) {
        if (!first) return
        const cardId = id
        const ready = () => { mediaReadyFor = cardId }
        firstMedia = node
        if (node instanceof HTMLImageElement) {
            if (mediaLoaded(node)) {
                ready()
                return
            }
            node.addEventListener('load', ready)
            node.addEventListener('error', ready)
            return {
                destroy() {
                    if (firstMedia === node) firstMedia = undefined
                    node.removeEventListener('load', ready)
                    node.removeEventListener('error', ready)
                }
            }
        }

        // loadeddata comes well before the first frame is presented (over a
        // second on a slow link), so wait for the frame itself where supported.
        const video = node
        let frameRequest: number | undefined
        const loaded = () => {
            if ('requestVideoFrameCallback' in video) {
                frameRequest ??= video.requestVideoFrameCallback(ready)
            } else {
                ready()
            }
        }
        if (mediaLoaded(video)) loaded()
        video.addEventListener('loadeddata', loaded)
        video.addEventListener('error', ready)
        return {
            destroy() {
                if (firstMedia === video) firstMedia = undefined
                video.removeEventListener('loadeddata', loaded)
                video.removeEventListener('error', ready)
                if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest)
            }
        }
    }

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
        {:else}
            {#if !revealed}
                <!-- Always laid over the card: an outroing element stops updating, so one that
                     switched to an overlay only once data arrived would stay in flow and double the card. -->
                <div
                    class="skeleton"
                    aria-busy="true"
                    aria-label={`Loading ${id}`}
                    out:fade={{ duration: prefersReducedMotion.current ? 0 : 300 }}
                >
                    <div class="skeleton-stage shimmer"></div>
                    <div class="skeleton-info">
                        <span class="skeleton-line shimmer"></span>
                        <span class="skeleton-line short shimmer"></span>
                    </div>
                </div>
            {/if}
            {#if !data}
                <!-- holds the card's shape until data arrives; swapped for the card in one frame -->
                <div class="skeleton-spacer" aria-hidden="true">
                    <div class="skeleton-stage"></div>
                    <div class="skeleton-info"></div>
                </div>
            {:else}
            <div class="card-loaded" class:revealed inert={!revealed}>
                {#if data.type === 'album'}
                    <div
                        class="preview-stage"
                        class:shimmer={!mediaReady}
                        role="region"
                        aria-label={`${label} preview`}
                        aria-roledescription="carousel"
                    >
                        <span class="type-badge">{typeLabel}</span>
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
                                                <img src={file.url} alt="" loading="lazy" use:watchFirstMedia={index === 0} />
                                            {:else}
                                                <!-- Muted card previews have no spoken content or caption resource. -->
                                                <!-- svelte-ignore a11y_media_has_caption -->
                                                <video
                                                    use:watchFirstMedia={index === 0}
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
                {:else if data.type === 'note'}
                    <a class="note-stage" href={uploadUrl} aria-label={`Open ${label}`}>
                        <span class="type-badge">{typeLabel}</span>
                        <span class="note-excerpt" aria-hidden="true">{data.note_preview ?? ''}</span>
                    </a>
                {:else}
                    <a class="file-stage" href={uploadUrl} aria-label={`Open ${label}`}>
                        <span class="type-badge">{typeLabel}</span>
                        <span
                            class="file-icons"
                            style:--icon-columns={fileIconColumns}
                            style:--icon-rows={files.length > 1 ? 2 : 1}
                            aria-hidden="true"
                        >
                            {#each fileIconRows as row, rowIndex}
                                <span class="file-icon-row">
                                    {#each row as file (file.index)}
                                        <span class="file-icon" data-kind={mimeKind(file.mime)}>
                                            {mimeLabel(file.mime)}
                                        </span>
                                    {/each}
                                    {#if rowIndex === 1 && remainingFileCount > 0}
                                        <span class="file-icon">+{remainingFileCount}</span>
                                    {/if}
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
                        {#if showViews}
                            <span
                                class="card-views"
                                aria-label={`${data.views} ${data.views === 1 ? 'view' : 'views'}`}
                            >
                                <ViewIcon />
                                <span aria-hidden="true">{data.views}</span>
                            </span>
                        {:else if data.type === 'note'}
                            <span>{noteLength.toLocaleString()} {noteLength === 1 ? 'char' : 'chars'}</span>
                        {:else}
                            <span>{files.length} {files.length === 1 ? 'file' : 'files'} &middot; {formatFileSize(totalSize)}</span>
                        {/if}
                        <time datetime={data.when}>{dateLabel}</time>
                    </div>
                </footer>
            </div>
            {/if}
        {/if}
    </article>
{/if}

<style>
    .mini-card {
        position: relative;
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

    /* stays laid out (not display: none) so the lazy first image still loads behind the skeleton */
    .card-loaded {
        display: flex;
        flex-direction: column;
        height: 100%;
        opacity: 0;
        transition: opacity 300ms ease-out;
    }

    .card-loaded.revealed {
        opacity: 1;
    }

    .skeleton {
        position: absolute;
        z-index: 5;
        inset: 0;
        display: flex;
        flex-direction: column;
        background: #1e1b1c;
        pointer-events: none;
    }

    .skeleton-stage {
        aspect-ratio: 4 / 3;
    }

    /* same height as .card-info, so the loaded card doesn't grow when it replaces the skeleton */
    .skeleton-info {
        display: grid;
        align-content: center;
        gap: 0.55rem;
        height: 4.1rem;
        padding: 0 0.65rem;
    }

    .skeleton-line {
        width: 70%;
        height: 0.7rem;
    }

    .skeleton-line.short {
        width: 45%;
        height: 0.5rem;
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

    /* two classes so it beats .preview-stage's own background */
    .mini-card .shimmer {
        background: linear-gradient(90deg, #252222 25%, #2e2a2b 50%, #252222 75%);
        background-size: 200% 100%;
        animation: shimmer 1.4s infinite;
    }

    .preview-stage,
    .file-stage,
    .note-stage {
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
    .note-stage:focus-visible,
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
        transition: opacity 300ms ease-out;
    }

    /* the card was revealed by MEDIA_WAIT_MS before its media: keep the shimmer showing through */
    .preview-stage.shimmer .media-link :is(img, video) {
        opacity: 0;
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
        container-type: inline-size;
        color: inherit;
        text-decoration: none;
    }

    .note-stage {
        color: inherit;
        text-decoration: none;
    }

    /* fades out at the bottom instead of a hard cut, so a cropped excerpt still reads as "more inside" */
    .note-excerpt {
        display: block;
        height: 100%;
        padding: 2.6rem 0.8rem 0.75rem;
        box-sizing: border-box;
        overflow: hidden;
        color: #c9c3c5;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.68rem;
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        mask-image: linear-gradient(to bottom, #000 65%, transparent);
    }

    .file-icons {
        --icon-gap: clamp(0.35rem, 2cqi, 0.65rem);
        /* Fit both the row width and the 4:3 stage below its badge. */
        --icon-size: min(
            5.5rem,
            calc((100cqi - 1.5rem - (var(--icon-columns) - 1) * var(--icon-gap)) / var(--icon-columns)),
            calc((75cqi - 4rem - (var(--icon-rows) - 1) * var(--icon-gap)) / var(--icon-rows))
        );
        display: grid;
        place-content: center;
        gap: var(--icon-gap);
        width: 100%;
        padding: 3rem 0.75rem 1rem;
        box-sizing: border-box;
    }

    .file-icon-row {
        display: flex;
        justify-content: center;
        gap: var(--icon-gap);
    }

    .file-icon-row:empty {
        display: none;
    }

    .file-icon {
        --icon-color: #918a8d;
        display: grid;
        place-items: center;
        flex: 0 0 var(--icon-size);
        width: var(--icon-size);
        aspect-ratio: 1;
        box-sizing: border-box;
        color: var(--icon-color);
        border: 1px solid currentColor;
        font-size: clamp(0.55rem, calc(var(--icon-size) * 0.18), 0.85rem);
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

    .card-views {
        --view-icon-size: 0.8rem;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-variant-numeric: tabular-nums;
        line-height: 1;
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

        .card-loaded,
        .media-link img,
        .media-link video {
            transition: none;
        }

        .mini-card .shimmer {
            animation: none;
        }
    }
</style>
