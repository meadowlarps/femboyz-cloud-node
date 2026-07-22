<script lang="ts">
    import type { FileData } from '$lib/upload/downloader'
    import { formatFileSize } from '$lib/upload/uploader'
    import { fade } from 'svelte/transition';
    

    let { files }: { files: FileData[] } = $props()
</script>

<ul transition:fade class="file-list">
    {#each files as file (file.index)}
        <li class="file-row">
            <div class="file-info">
                <span class="file-name">{file.filename}</span>
                <span class="file-meta">{formatFileSize(file.size)}</span>
            </div>
            <div class="file-stats">
                {#if file.stat_dl > 0}
                    <span class="dl-count">{file.stat_dl} {file.stat_dl === 1 ? 'download' : 'downloads'}</span>
                {/if}
                <a class="fb-button dl-btn" href={file.url} target="_blank" rel="noopener">Download</a>
            </div>
        </li>
    {/each}
</ul>

<style>
    .file-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
    }

    .file-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.9rem 0;
        border-bottom: 1px solid #3b3538;
    }

    .file-row:last-child {
        border-bottom: none;
    }

    .file-info {
        display: grid;
        gap: 0.2rem;
        min-width: 0;
    }

    .file-name {
        font-weight: 600;
        overflow-wrap: anywhere;
    }

    .file-meta {
        font-size: 0.85rem;
        color: #8a8385;
    }

    .file-stats {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-shrink: 0;
    }

    .dl-count {
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

    @media (max-width: 36rem) {
        .file-row {
            flex-direction: column;
            align-items: flex-start;
        }

        .file-stats {
            width: 100%;
            justify-content: space-between;
        }

        .dl-btn {
            flex: 1;
            text-align: center;
        }
    }
</style>
