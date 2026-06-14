<script lang="ts">
    import type { FileData } from '$lib/upload/downloader'
    import { formatFileSize } from '$lib/upload/uploader'

    let { files }: { files: FileData[] } = $props()

    let carouselIndex = $state(0)
    const carouselFile = $derived(files[carouselIndex])

    function carouselPrev() { carouselIndex = (carouselIndex - 1 + files.length) % files.length }
    function carouselNext() { carouselIndex = (carouselIndex + 1) % files.length }

    function onKeydown(e: KeyboardEvent) {
        if (files.length >= 3) {
            if (e.key === 'ArrowRight') carouselNext()
            if (e.key === 'ArrowLeft') carouselPrev()
        }
    }
</script>

<svelte:window onkeydown={onKeydown} />

{#if files.length === 1}
    {@const file = files[0]!}
    <div class="single-media">
        {#if file.mime.startsWith('image/')}
            <img src={file.url} alt={file.filename} />
        {:else if file.mime.startsWith('video/')}
            <video src={file.url} controls>
                <track kind="captions" label="Captions" srclang="en" src="" default />
            </video>
        {/if}
    </div>

{:else if files.length === 2}
    <div class="duo-grid">
        {#each files as file (file.index)}
            <div class="media-item">
                {#if file.mime.startsWith('image/')}
                    <img src={file.url} alt={file.filename} loading="lazy" />
                {:else if file.mime.startsWith('video/')}
                    <video src={file.url} controls>
                        <track kind="captions" label="Captions" srclang="en" src="" default />
                    </video>
                {/if}
            </div>
        {/each}
    </div>

{:else}
    <div class="carousel">
        <div class="carousel-stage">
            <button class="carousel-arrow left" type="button" onclick={carouselPrev} aria-label="Previous">&#8592;</button>

            <div class="carousel-media">
                {#if carouselFile?.mime.startsWith('image/')}
                    <img src={carouselFile.url} alt={carouselFile.filename} />
                {:else if carouselFile?.mime.startsWith('video/')}
                    <video src={carouselFile.url} controls>
                        <track kind="captions" label="Captions" srclang="en" src="" default />
                    </video>
                {/if}
            </div>

            <button class="carousel-arrow right" type="button" onclick={carouselNext} aria-label="Next">&#8594;</button>
        </div>

        <div class="carousel-footer">
            <span class="carousel-counter">{carouselIndex + 1} / {files.length}</span>
            {#if carouselFile}
                <span class="carousel-meta">{formatFileSize(carouselFile.size)}{#if carouselFile.stat_dl > 0} &middot; {carouselFile.stat_dl} downloads{/if}</span>
            {/if}
        </div>
    </div>
{/if}

<style>
    /* Single */
    .single-media {
        display: grid;
    }

    .single-media img,
    .single-media video {
        max-width: 100%;
        max-height: calc(100vh - 22rem);
        width: auto;
        height: auto;
        display: block;
        justify-self: center;
    }

    /* Duo */
    .duo-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.5rem;
    }

    .media-item {
        overflow: hidden;
        background: #221f20;
    }

    .media-item img,
    .media-item video {
        width: 100%;
        height: auto;
        display: block;
    }

    /* Carousel */
    .carousel {
        display: grid;
        gap: 0.75rem;
    }

    .carousel-stage {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .carousel-arrow {
        flex-shrink: 0;
        background: #2e2b2c;
        border: 1px solid #3b3538;
        color: #f4f4f4;
        cursor: pointer;
        font: inherit;
        font-size: 1.1rem;
        padding: 0.5rem 0.75rem;
        transition: background 0.15s ease;
        align-self: center;
    }

    .carousel-arrow:hover {
        background: #3b3538;
    }

    .carousel-media {
        flex: 1;
        display: flex;
        justify-content: center;
        min-width: 0;
    }

    .carousel-media img,
    .carousel-media video {
        max-width: 100%;
        max-height: calc(100vh - 22rem);
        width: auto;
        height: auto;
        display: block;
    }

    .carousel-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
    }

    .carousel-counter {
        font-size: 0.85rem;
        color: #6a6468;
        min-width: 3rem;
    }

    .carousel-meta {
        font-size: 0.85rem;
        color: #8a8385;
    }


    @media (max-width: 36rem) {
        .carousel-stage {
            gap: 0.25rem;
        }

        .carousel-arrow {
            padding: 0.4rem 0.5rem;
        }
    }
</style>
