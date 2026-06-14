<script lang="ts">
    import type { FileData } from '$lib/upload/downloader'
    import { formatFileSize } from '$lib/upload/uploader'
    import { fade } from 'svelte/transition';

    let { files }: { files: FileData[] } = $props()
</script>

<ul transition:fade class="track-list">
    {#each files as file (file.index)}
        <li class="track">
            <div class="track-header">
                <span class="track-index">{file.index + 1}</span>
                <div class="track-info">
                    <span class="track-name">{file.filename}</span>
                    <span class="track-meta">{formatFileSize(file.size)}</span>
                </div>
                <div class="track-actions">
                    {#if file.stat_dl > 0}
                        <span class="play-count">{file.stat_dl}</span>
                    {/if}
                    <a class="fb-button dl-btn" href={file.url} target="_blank" rel="noopener">↓</a>
                </div>
            </div>
            <audio controls src={file.url} preload="none" class="audio-player"></audio>
        </li>
    {/each}
</ul>

<style>
    .track-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
    }

    .track-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
    }

    .track-index {
        flex-shrink: 0;
        width: 1.5rem;
        text-align: center;
        color: #6a6468;
        font-size: 0.9rem;
    }

    .track-info {
        flex: 1;
        min-width: 0;
        display: grid;
        gap: 0.15rem;
    }

    .track-name {
        font-weight: 600;
        overflow-wrap: anywhere;
    }

    .track-meta {
        font-size: 0.82rem;
        color: #8a8385;
    }

    .track-actions {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-shrink: 0;
    }

    .play-count {
        font-size: 0.8rem;
        color: #6a6468;
    }

    .dl-btn {
        text-decoration: none;
        font-size: 0.9rem;
    }

    .audio-player {
        width: 100%;
        display: block;
        height: 2.5rem;
        border-top: none;
    }

    audio::-webkit-media-controls-panel {
        background: #1b1a1a;
    }
</style>
