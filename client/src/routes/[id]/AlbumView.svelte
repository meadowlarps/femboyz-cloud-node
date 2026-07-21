<script lang="ts">
    import emblaCarouselSvelte from 'embla-carousel-svelte'
    import type { EmblaCarouselType, EmblaOptionsType } from 'embla-carousel'
    import { onMount, type Snippet } from 'svelte'
    import type { FileData } from '$lib/upload/downloader'
    import { formatFileSize } from '$lib/upload/uploader'
    import CopyLinkButton from '$lib/CopyLinkButton.svelte'

    let { files, children }: { files: FileData[]; children: Snippet } = $props()

    let carouselApi = $state<EmblaCarouselType>()
    let carouselRoot = $state<HTMLElement>()
    let selectedIndex = $state(0)
    let reduceMotion = $state(false)
    const hasMultiple = $derived(files.length > 1)
    const carouselOptions = $derived<EmblaOptionsType>({
        loop: hasMultiple,
        watchDrag: hasMultiple
    })

    onMount(() => {
        const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
        const updateMotionPreference = () => reduceMotion = mediaQuery.matches

        updateMotionPreference()
        mediaQuery.addEventListener('change', updateMotionPreference)
        return () => mediaQuery.removeEventListener('change', updateMotionPreference)
    })

    function pauseInactiveVideos(activeIndex: number) {
        carouselRoot?.querySelectorAll('video').forEach((video) => {
            if (Number(video.dataset.fileIndex) !== activeIndex) video.pause()
        })
    }

    function syncSelection(api: EmblaCarouselType) {
        selectedIndex = api.selectedScrollSnap()
        pauseInactiveVideos(selectedIndex)
    }

    function onCarouselInit(event: CustomEvent<EmblaCarouselType>) {
        carouselApi = event.detail
        syncSelection(carouselApi)
        carouselApi.on('select', syncSelection)
    }

    function showPrevious() {
        carouselApi?.scrollPrev(reduceMotion)
    }

    function showNext() {
        carouselApi?.scrollNext(reduceMotion)
    }

    function showFile(index: number) {
        carouselApi?.scrollTo(index, reduceMotion)
    }

    function onStageKeydown(event: KeyboardEvent) {
        if (event.target !== event.currentTarget) return

        if (event.key === 'ArrowLeft') {
            event.preventDefault()
            showPrevious()
        } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            showNext()
        }
    }
</script>

<section
    class="album-view"
    class:single={!hasMultiple}
    bind:this={carouselRoot}
    aria-label="Media gallery"
    aria-roledescription="carousel"
>
    <!-- The media region is focusable so left/right navigation remains scoped to the stage. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
        class="media-stage"
        role="region"
        aria-label="Media stage"
        tabindex="0"
        onkeydown={onStageKeydown}
    >
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
                        aria-roledescription="slide"
                        aria-label={`${index + 1} of ${files.length}`}
                        aria-hidden={index !== selectedIndex}
                    >
                        {#if file.mime.startsWith('image/')}
                            <img
                                src={file.url}
                                alt={file.filename}
                                loading={index === 0 ? 'eager' : 'lazy'}
                            />
                        {:else if file.mime.startsWith('video/')}
                            <!-- User uploads do not include caption resources in the upload schema. -->
                            <!-- svelte-ignore a11y_media_has_caption -->
                            <video
                                src={file.url}
                                controls={index === selectedIndex}
                                playsinline
                                preload="metadata"
                                data-file-index={index}
                                tabindex={index === selectedIndex ? 0 : -1}
                                aria-label={file.filename}
                            >
                                Your browser cannot play this video.
                                <a href={file.url} tabindex={index === selectedIndex ? 0 : -1}>Open {file.filename}</a>
                            </video>
                        {:else}
                            <a class="unsupported-file" href={file.url}>Open {file.filename}</a>
                        {/if}
                    </div>
                {/each}
            </div>
        </div>

        {#if hasMultiple}
            <button class="carousel-arrow previous" type="button" onclick={showPrevious} aria-label="Previous media">
                &#8592;
            </button>
            <button class="carousel-arrow next" type="button" onclick={showNext} aria-label="Next media">
                &#8594;
            </button>
        {/if}

        <p class="sr-only" aria-live="polite">
            Showing {selectedIndex + 1} of {files.length}: {files[selectedIndex]?.filename}
        </p>
    </div>

    {#if hasMultiple}
        <nav class="file-navigator" aria-label="Album files">
            <h2 style="padding-left: 0.75em; margin-bottom: 0.2em;">Your media:</h2>
            <ol>
                {#each files as file, index (file.index)}
                    <li class="file-row">
                        <button
                            class="file-button"
                            class:active={index === selectedIndex}
                            type="button"
                            aria-current={index === selectedIndex ? 'true' : undefined}
                            onclick={() => showFile(index)}
                        >
                            <span class="filename">{file.filename}</span>
                            {#if index === selectedIndex}
                                <span class="file-meta">
                                    {index + 1} / {files.length} &middot; {formatFileSize(file.size)}
                                    {#if file.stat_dl > 0}
                                        &middot; {file.stat_dl} {file.stat_dl === 1 ? 'download' : 'downloads'}
                                    {/if}
                                </span>
                            {/if}
                        </button>
                        <span class="file-copy">
                            <CopyLinkButton
                                url={file.url}
                                label={`Copy direct link to ${file.filename}`}
                            />
                        </span>
                    </li>
                {/each}
            </ol>
        </nav>
    {/if}

    <div class="album-details">
        {@render children()}
    </div>
</section>

<style>
    .album-view {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(12rem, 18rem);
        grid-template-areas:
            "stage files"
            "details .";
        align-items: start;
        gap: 1rem;
        width: min(100%, 72rem);
        margin: 0 auto;
    }

    .album-view.single {
        grid-template-columns: minmax(0, 60rem);
        grid-template-areas:
            "stage"
            "details";
        justify-content: center;
    }

    .media-stage {
        position: relative;
        grid-area: stage;
        min-width: 0;
        height: clamp(20rem, 68svh, 44rem);
        overflow: hidden;
        background: #111;
        border: 1px solid #2e2b2c;
    }

    .media-stage:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 3px;
    }

    .embla-viewport,
    .embla-container,
    .embla-slide {
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
        position: relative;
        flex: 0 0 100%;
        display: grid;
        place-items: center;
        min-width: 0;
    }

    .embla-slide img,
    .embla-slide video {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
    }

    .embla-slide video {
        background: #000;
    }

    .unsupported-file {
        color: var(--color-fb-white);
    }

    .carousel-arrow {
        position: absolute;
        z-index: 2;
        top: 50%;
        width: 2.75rem;
        height: 2.75rem;
        padding: 0;
        transform: translateY(-50%);
        color: #fff;
        background: rgb(27 26 26 / 78%);
        border: 1px solid rgb(255 255 255 / 25%);
        font: inherit;
        font-size: 1.25rem;
        cursor: pointer;
        transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }

    .carousel-arrow.previous {
        left: 0.75rem;
    }

    .carousel-arrow.next {
        right: 0.75rem;
    }

    .carousel-arrow:hover,
    .carousel-arrow:focus-visible {
        color: #060606;
        background: var(--color-fb-white);
        border-color: var(--color-fb-white);
        outline: none;
    }

    .file-navigator {
        grid-area: files;
        align-self: stretch;
        min-width: 0;
        min-height: 0;
        max-height: clamp(20rem, 68svh, 44rem);
        overflow-y: auto;
        border: 1px solid #2e2b2c;
    }

    .file-navigator ol {
        display: grid;
        gap: 0.35rem;
        margin: 0;
        padding: 0.5rem;
        list-style: none;
    }

    .file-row {
        position: relative;
        min-width: 0;
    }

    .file-copy {
        position: absolute;
        z-index: 1;
        top: 0.55rem;
        right: 0.55rem;
    }

    .file-button {
        display: grid;
        gap: 0.35rem;
        width: 100%;
        padding: 0.75rem 2.65rem 0.75rem 0.75rem;
        color: #c9c3c5;
        background: transparent;
        border: 1px solid transparent;
        font: inherit;
        text-align: left;
        cursor: pointer;
        transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }

    .file-button:hover,
    .file-button:focus-visible {
        color: #fff;
        background: #2e2b2c;
        border-color: #3b3538;
        outline: none;
    }

    .file-button.active {
        color: #fff;
        background: rgb(195 15 69 / 18%);
        border-color: var(--color-accent);
    }

    .filename {
        font-weight: 400;
        overflow-wrap: anywhere;
    }

    .file-meta {
        color: #8a8385;
        font-size: 0.78rem;
        line-height: 1.35;
    }

    .album-details {
        grid-area: details;
        min-width: 0;
    }

    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }

    @media (max-width: 48rem) {
        .album-view {
            grid-template-columns: minmax(0, 1fr);
            grid-template-areas:
                "stage"
                "files"
                "details";
        }

        .album-view.single {
            grid-template-areas:
                "stage"
                "details";
        }

        .media-stage {
            height: clamp(16rem, 85vw, 32rem);
        }

        .file-navigator {
            max-height: none;
            overflow-y: visible;
        }
    }

    @media (max-width: 36rem) {
        .carousel-arrow {
            width: 2.35rem;
            height: 3rem;
        }

        .carousel-arrow.previous {
            left: 0.4rem;
        }

        .carousel-arrow.next {
            right: 0.4rem;
        }
    }
</style>
