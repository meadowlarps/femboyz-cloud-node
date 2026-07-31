<script lang="ts">
    import { fileDownloadUrl, type FileData } from '$lib/upload/downloader'
    import DownloadIcon from '$lib/DownloadIcon.svelte'
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
                        <span class="dl-count" title="{file.stat_dl} {file.stat_dl === 1 ? 'download' : 'downloads'}">
                            <DownloadIcon />
                            {file.stat_dl}
                        </span>
                    {/if}
                    <a class="fb-button fb-button-ghost dl-btn" href={fileDownloadUrl(file)} download={file.filename}>Download</a>
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

    .track {
        background: #262224;
        border: 1px solid #332e30;
    }

    .track-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem 1rem 0.5rem;
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

    .dl-count {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        font-size: 0.82rem;
        color: #6a6468;
        white-space: nowrap;
    }

    .dl-btn {
        font-size: 0.88rem;
        padding: 0.5rem 0.9rem;
        text-decoration: none;
        white-space: nowrap;
    }

    .audio-player {
        width: 100%;
        display: block;
        height: 3rem;
        padding: 0 0.75rem 0.75rem;
        box-sizing: border-box;
    }

    .audio-player:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: -2px;
    }
</style>
