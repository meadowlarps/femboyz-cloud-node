<script lang="ts">
    import { fade, slide } from 'svelte/transition';
    import type { PageData } from './$types'
    import {
        type UploadLimits,
        type UploadProgress,
        formatFileSize,
        sendUpload,
        sendLinkUpload
    } from '$lib/upload/uploader'
    import MiniUpload from './MiniUpload.svelte'
    import { getHistory, addToHistory } from '$lib/upload/history'
    import { spawnAlert } from '$lib/alerts'

    const apiEndpoint = import.meta.env.VITE_API_ENDPOINT ?? ''

    let { data }: { data: PageData } = $props()

    let mode = $state<'files' | 'link'>('files')
    let title = $state('')
    let description = $state('')
    let files = $state<File[]>([])
    let linkUrl = $state('')
    let uploadLimits = $derived(data.uploadLimits as UploadLimits | null)
    let limitsError = $derived(data.limitsError)
    let fileErrors = $state<string[]>([])
    let uploadError = $state('')
    let uploadResultId = $state('')
    let isUploading = $state(false)
    let uploadProgress = $state<UploadProgress>()
    let isFileLimitReached = $derived(uploadLimits ? files.length >= uploadLimits.maxcount : false)
    let isDragging = $state(false)
    let isPublic = $state(false)
    let hiddenProgressIndexes = $state(new Set<number>())
    let hideProgressTimer: ReturnType<typeof setTimeout> | undefined
    let uploadHistory = $state<string[]>([])
    let visibleCount = $state(16)
    let visibleUploads = $derived(uploadHistory.slice(0, visibleCount))
    let hasMore = $derived(uploadHistory.length > visibleCount)

    $effect(() => {
        uploadHistory = getHistory()
    })

    function clearProgressTimers() {
        clearTimeout(hideProgressTimer)
        hideProgressTimer = undefined
        hiddenProgressIndexes = new Set()
    }

    $effect(() => {
        const progress = uploadProgress
        if (!progress || progress.files.length === 0) return

        const allDone = progress.files.every((fp) => fp.total > 0 && fp.loaded >= fp.total)
        if (allDone && hideProgressTimer === undefined) {
            hideProgressTimer = setTimeout(() => {
                hiddenProgressIndexes = new Set(progress.files.map((_, i) => i))
                hideProgressTimer = undefined
            }, 5000)
        }
    })

    function processFiles(selectedFiles: File[]) {
        const nextFiles: File[] = []
        const nextErrors: string[] = []

        if (!uploadLimits) return

        for (const file of selectedFiles) {
            if (files.length + nextFiles.length >= uploadLimits.maxcount) {
                nextErrors.push(`Only ${uploadLimits.maxcount} files can be uploaded at once.`)
                break
            }
            if (file.size > uploadLimits.maxsizeperfile) {
                nextErrors.push(`${file.name} is larger than ${formatFileSize(uploadLimits.maxsizeperfile)}.`)
                continue
            }
            nextFiles.push(file)
        }

        files = [...files, ...nextFiles]
        fileErrors = nextErrors
    }

    function addFiles(event: Event) {
        const input = event.currentTarget as HTMLInputElement
        processFiles(Array.from(input.files ?? []))
        input.value = ''
    }

    function handleDragOver(event: DragEvent) {
        event.preventDefault()
        if (!uploadLimits || isFileLimitReached) return
        isDragging = true
    }

    function handleDragLeave() {
        isDragging = false
    }

    function handleDrop(event: DragEvent) {
        event.preventDefault()
        isDragging = false
        if (!uploadLimits || isFileLimitReached) return
        processFiles(Array.from(event.dataTransfer?.files ?? []))
    }

    function removeFile(index: number) {
        files = files.filter((_, fileIndex) => fileIndex !== index)
        uploadProgress = undefined
        clearProgressTimers()
    }

    async function uploadFiles() {
        uploadError = ''
        uploadResultId = ''
        uploadProgress = undefined
        clearProgressTimers()

        try {
            isUploading = true
            const result = await sendUpload(apiEndpoint, files, title, description, isPublic, (progress) => {
                uploadProgress = progress
            })
            uploadResultId = result.id
            addToHistory(result.id)
            uploadHistory = getHistory()
            spawnAlert('success', `Upload complete: ${result.id}`)
        } catch (error) {
            uploadError = error instanceof Error ? error.message : 'Upload failed'
            spawnAlert('error', `Upload failed: ${uploadError}`)
        } finally {
            isUploading = false
        }
    }

    function switchMode(next: 'files' | 'link') {
        mode = next
        uploadError = ''
        uploadResultId = ''
    }

    async function uploadLink() {
        uploadError = ''
        uploadResultId = ''

        try {
            isUploading = true
            const result = await sendLinkUpload(apiEndpoint, linkUrl)
            uploadResultId = result.id
            addToHistory(result.id)
            uploadHistory = getHistory()
            spawnAlert('success', `Upload complete: ${result.id}`)
        } catch (error) {
            uploadError = error instanceof Error ? error.message : 'Upload failed'
            spawnAlert('error', `Upload failed: ${uploadError}`)
        } finally {
            isUploading = false
        }
    }

    function fileProgress(index: number) {
        return uploadProgress?.files[index]
    }

    function progressPercent(index: number) {
        const progress = fileProgress(index)
        if (!progress || progress.total === 0) return 0

        return Math.round((progress.loaded / progress.total) * 100)
    }    
</script>

<div class="page-layout">
<div class="upload-sidebar">
<div class="upload-field">
    <div class="mode-switcher">
        <button class="mode-tab" class:active={mode === 'files'} type="button" onclick={() => switchMode('files')}>Files</button>
        <button class="mode-tab" class:active={mode === 'link'} type="button" onclick={() => switchMode('link')}>Link</button>
    </div>

    <div class="field-header">
        <div>
            <h1>New upload</h1>
            {#if mode === 'files'}
                <p>Add details and choose one or more files.</p>
                {#if uploadLimits}
                    <p class="limit-note">
                        Up to {uploadLimits.maxcount} files, {formatFileSize(uploadLimits.maxsizeperfile - 1024 * 1024)} each.
                    </p>
                {/if}
            {:else}
                <p>Shorten a link.</p>
            {/if}
        </div>
    </div>

    {#if mode === 'files'}
        <div transition:slide>
            <label class="form-field">
                <input
                    bind:value={title}
                    type="text"
                    name="title"
                    placeholder="Upload title"
                    maxlength={uploadLimits?.max_title_length}
                />
                {#if uploadLimits && title.length > 0}
                    <span class="char-counter" class:near-limit={title.length >= uploadLimits.max_title_length * 0.85}>
                        {title.length}/{uploadLimits.max_title_length}
                    </span>
                {/if}
            </label>
        </div>

        <div transition:slide>
            <label class="form-field">
                {#if title.length > 0}
                    <textarea
                        transition:slide
                        bind:value={description}
                        name="description"
                        rows="3"
                        placeholder="Description"
                        maxlength={uploadLimits?.max_desc_length}
                    ></textarea>
                    {#if uploadLimits && description.length > 0}
                        <span class="char-counter" class:near-limit={description.length >= uploadLimits.max_desc_length * 0.85}>
                            {description.length}/{uploadLimits.max_desc_length}
                        </span>
                    {/if}
                {:else}
                    {description = ""}
                {/if}
            </label>
        </div>

        <ul transition:slide class="file-list" aria-label="Selected files">
            {#each files as file, index (file.name + file.size + index)}
                <li transition:slide>
                    {#if fileProgress(index) && !hiddenProgressIndexes.has(index)}
                        <div transition:fade class="upload-progressbar" aria-hidden="true">
                            <div
                                class="upload-progressbar-value"
                                class:done={progressPercent(index) === 100}
                                style={`width: ${progressPercent(index)}%`}
                            ></div>
                        </div>
                    {/if}

                    <div class="index">
                        <span>{index + 1}</span>
                    </div>

                    <div class="file-label">
                        <strong>{file.name}</strong>
                        <span>{formatFileSize(file.size)}</span>
                    </div>

                    <button
                        class="file-action-button remove-button fb-button"
                        type="button"
                        onclick={() => removeFile(index)} disabled={isUploading}
                    >
                        Remove
                    </button>
                </li>
            {/each}

            {#if !isFileLimitReached}
                <li>
                    <label
                        id="drop-area"
                        for="file_input"
                        class:highlight={isDragging}
                        ondragover={handleDragOver}
                        ondragleave={handleDragLeave}
                        ondrop={handleDrop}
                    >
                        <div class="drop-text">
                            Drag & drop files here or click to upload
                        </div>
                        <input
                            class="file-input"
                            type="file"
                            id="file_input"
                            multiple
                            hidden
                            onchange={addFiles}
                        />
                    </label>
                </li>
            {/if}
        </ul>

        {#if limitsError}
            <p transition:slide|global class="error-message">Something is wrong: {limitsError}</p>
        {/if}

        {#if fileErrors.length > 0}
            <ul transition:slide|global class="error-list" aria-label="File selection errors">
                {#each fileErrors as error}
                    <li>{error}</li>
                {/each}
            </ul>
        {/if}
    {:else}
        <label transition:slide class="form-field">
            <input bind:value={linkUrl} type="url" name="link" placeholder="https://example.com" />
        </label>
    {/if}

    {#if uploadError}
        <p transition:slide|global class="error-message">Upload failed: {uploadError}</p>
    {/if}

    {#if uploadResultId}
        <p transition:slide|global class="success-message">Uploaded: {uploadResultId}</p>
    {/if}

    <div class="finalize">
        {#if mode === 'files'}
            <label class="public-checkbox">
                <input type="checkbox" bind:checked={isPublic} disabled={isUploading} />
                <span class="checkbox-box" aria-hidden="true"></span>
                <span class="checkbox-label">Make public</span>
            </label>
        {:else}
            <span></span>
        {/if}
        <button
            class="upload-button fb-button"
            type="button"
            onclick={mode === 'files' ? uploadFiles : uploadLink}
            disabled={mode === 'files' ? (files.length === 0 || isUploading) : (linkUrl.trim() === '' || isUploading)}
        >
            {isUploading ? 'Uploading...' : 'Upload!'}
        </button>
    </div>
</div>
</div>

<div class="uploads-grid-wrap">
    <div class="uploads-grid">
        {#each visibleUploads as id (id)}
            <MiniUpload {id} />
        {/each}
    </div>
    {#if hasMore}
        <button class="load-more-btn" type="button" onclick={() => visibleCount += 8} aria-label="Load more uploads">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M201.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 338.7 54.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z"/></svg>
        </button>
    {/if}
</div>
</div>


<style>
    .page-layout {
        display: flex;
        align-items: flex-start;
        gap: 3.5rem;
    }

    .upload-sidebar {
        position: sticky;
        top: 9.5rem;
        align-self: flex-start;
        flex-shrink: 0;
    }

    .upload-field {
        display: grid;
        gap: 1rem;
        width: 25rem;
        min-height: 15rem;
        border: 2px solid var(--color-accent);
        padding: 0;
        background: #221f20;
        overflow: hidden;
    }

    .mode-switcher {
        display: flex;
        border-bottom: 1px solid #3b3538;
    }

    .mode-tab {
        flex: 1;
        padding: 0.55rem 1rem;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        color: #8a8385;
        cursor: pointer;
        font: inherit;
        font-size: 0.88rem;
        letter-spacing: 0.02em;
        transition: color 0.15s, border-color 0.15s, background 0.15s;
    }

    .mode-tab:hover {
        color: #c9c3c5;
        background: #2a2728;
    }

    .mode-tab.active {
        color: #f4f4f4;
        border-bottom-color: var(--color-accent);
    }

    .upload-field > :not(.mode-switcher) {
        padding-left: 1.25rem;
        padding-right: 1.25rem;
    }

    .upload-field > .field-header {
        padding-top: 1.25rem;
    }

    .upload-field > .finalize {
        padding-bottom: 1.25rem;
    }

    #drop-area {
        border: 2px dashed var(--color-accent);
        width: 100%;
        padding: 2rem 0;
        text-align: center;
        cursor: pointer;
        transition: background-color 0.2s ease-out, transform 0.2s ease-out;
    }

    #drop-area.highlight,
    #drop-area:hover {
        border-color: var(--color-fb-white);
        background-color: #f0f0ff30;
        transform: scale(1.01);
    }

    .drop-text {
        opacity: 0.8;
    }

    .field-header h1 {
        margin: 0;
        font-size: 1.5rem;
    }

    .field-header p {
        margin: 0.35rem 0 0;
        color: #c9c3c5;
    }

    .field-header .limit-note {
        color: #f0b7ca;
        font-size: 0.92rem;
    }

    .form-field {
        display: grid;
        gap: 0.45rem;
        font-weight: 600;
    }

    .form-field input,
    .form-field textarea {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #4b4246;
        padding: 0.75rem;
        color: #f4f4f4;
        background: #171515;
        font: inherit;
    }

    .form-field textarea {
        min-height: fit-content;
        resize: vertical;
    }

    .char-counter {
        display: block;
        text-align: right;
        font-size: 0.78rem;
        font-weight: 400;
        color: #6a6468;
        margin-top: -0.2rem;
    }

    .char-counter.near-limit {
        color: #f0b7ca;
    }

    .file-input {
        opacity: 0;
        width: 0.1px;
        height: 0.1px;
        position: absolute;
    }

    .file-list .file-action-button,
    .upload-button {
        width: fit-content;
    }
    

    .upload-button {
        padding-left: 2rem;
        padding-right: 2rem;
    }


    .error-message,
    .success-message,
    .error-list {
        margin: 0;
        font-size: 0.92rem;
    }

    .error-message,
    .error-list {
        color: #ffb3c7;
    }

    .success-message {
        color: #b7f0ce;
    }

    .error-list {
        display: grid;
        gap: 0.25rem;
        padding-left: 1.2rem;
    }

    .file-list {
        display: grid;
        gap: 0.65rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .file-list li {
        position: relative;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        border: 1px solid #3b3538;
        padding: 0.75rem;
        background: #191718;
    }

    .file-list .file-label {
        flex: 1 1 auto;
        text-align: left;
    }

    .file-list strong,
    .file-list span {
        display: block;
    }

    .file-list strong {
        overflow-wrap: anywhere;
    }

    .file-list span {
        margin-top: 0.2rem;
        color: #c9c3c5;
        font-size: 0.9rem;
    }

    .file-list .upload-progressbar {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 3px;
        z-index: 2;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.08);
    }

    .upload-progressbar-value {
        height: 100%;
        background: var(--color-fb-white-semi);
        transition: width 0.5s ease-out, background-color 0.4s ease-out;
    }

    .upload-progressbar-value.done {
        background: #5de899;
    }

    .file-list li > :not(.upload-progressbar) {
        position: relative;
        z-index: 5;
    }

    .file-list .file-action-button {
        flex: 0 0 auto;
        padding: 0.55rem 0.75rem;
        background: rgba(51, 44, 47, 0.651);
        backdrop-filter: blur(48px);
        z-index: 10;
    }

    .file-list button:hover {
        background-color: var(--color-fb-white);
    }

    .file-list button:disabled,
    .upload-button:disabled {
        cursor: not-allowed;
        opacity: 0.6;
    }

    .finalize {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
    }

    .public-checkbox {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        cursor: pointer;
        user-select: none;
    }

    .public-checkbox input[type="checkbox"] {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
        pointer-events: none;
    }

    .checkbox-box {
        flex-shrink: 0;
        width: 1.1rem;
        height: 1.1rem;
        border: 2px solid #4b4246;
        background: #171515;
        transition: border-color 0.15s ease-out, background-color 0.15s ease-out;
    }

    .public-checkbox:hover .checkbox-box {
        border-color: var(--color-fb-white-semi);
    }

    .public-checkbox input:checked ~ .checkbox-box {
        border-color: var(--color-accent);
        background-color: var(--color-accent);
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 6l3 3 5-5' stroke='%23fff' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-size: 75%;
        background-position: center;
        background-repeat: no-repeat;
    }

    .public-checkbox input:disabled ~ .checkbox-box,
    .public-checkbox input:disabled ~ .checkbox-label {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .public-checkbox input:disabled ~ .checkbox-box {
        cursor: not-allowed;
    }

    .public-checkbox:has(input:disabled) {
        cursor: not-allowed;
    }

    .checkbox-label {
        color: #c9c3c5;
        font-size: 0.92rem;
        transition: color 0.15s ease-out;
    }

    .public-checkbox:hover .checkbox-label {
        color: var(--color-fb-white);
    }

    .uploads-grid-wrap {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        flex: 1;
        align-items: stretch;
    }

    .uploads-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
        gap: 1rem;
        align-content: start;
    }

    .load-more-btn {
        align-self: center;
        width: 100%;
        height: 2.5rem;
        background: none;
        border: 1px solid #3b3538;
        color: #8a8385;
        cursor: pointer;
        transition: border-color 0.15s, color 0.15s, transform 0.2s, box-shadow 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: #1b1a1ae6 0 0 5rem 8rem;
        padding: 0;
        z-index: 15;
    }

    .load-more-btn svg {
        width: 1rem;
        height: 1rem;
        fill: currentColor;
        display: block;
    }

    .load-more-btn:hover {
        border-color: var(--color-accent);
        color: #f4f4f4;
        transform: translateY(2px);
        box-shadow: #1b1a1a82 0 0 5rem 8rem;
    }

    @media (max-width: 48rem) {
        .page-layout {
            flex-direction: column;
        }

        .upload-sidebar {
            position: static;
        }
    }

    @media (max-width: 36rem) {
        .file-list li {
            align-items: stretch;
            flex-direction: column;
        }
        .file-list button {
            width: 100%;
        }
        .file-list .index {
            display: none;
        }
    }
</style>
