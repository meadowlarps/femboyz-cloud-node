<script lang="ts">
    import { fade, slide } from 'svelte/transition';
    import type { PageData } from './$types'
    import {
        type UploadLimits,
        type UploadProgress,
        formatFileSize,
        sendUpload
    } from '$lib/upload/uploader'
    import MiniUpload from './MiniUpload.svelte';

    const apiEndpoint = import.meta.env.VITE_API_ENDPOINT ?? ''

    let { data }: { data: PageData } = $props()

    let title = $state('')
    let description = $state('')
    let files = $state<File[]>([])
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
        } catch (error) {
            uploadError = error instanceof Error ? error.message : 'Upload failed'
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

<div class="upload-field">
    <div class="field-header">
        <div>
            <h1>New upload</h1>
            <p>Add details and choose one or more files.</p>
            {#if uploadLimits}
                <p class="limit-note">
                    Up to {uploadLimits.maxcount} files, {formatFileSize(uploadLimits.maxsizeperfile - 1024 * 1024)} each.
                </p>
            {/if}
        </div>
    </div>

    <label class="form-field">
        <input bind:value={title} type="text" name="title" placeholder="Upload title" />
    </label>

    <label class="form-field">
        {#if title.length > 0}
            <textarea transition:slide bind:value={description} name="description" rows="3" placeholder="Description"></textarea>
        {:else}
            {description = ""}
        {/if}
    </label>

    <ul class="file-list" aria-label="Selected files">
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

    {#if uploadError}
        <p transition:slide|global class="error-message">Upload failed: {uploadError}</p>
    {/if}

    {#if uploadResultId}
        <p transition:slide|global class="success-message">Uploaded: {uploadResultId}</p>
    {/if}
    

    <div class="finalize">
        <label class="public-checkbox">
            <input type="checkbox" bind:checked={isPublic} disabled={isUploading} />
            <span class="checkbox-box" aria-hidden="true"></span>
            <span class="checkbox-label">Make public</span>
        </label>
        <button class="upload-button fb-button" type="button" onclick={uploadFiles} disabled={files.length === 0 || isUploading}>
            {isUploading ? 'Uploading...' : 'Upload!'}
        </button>
    </div>
</div>

<div class="uploads-grid">
    <MiniUpload id="7202TLAV" />
    <MiniUpload id="3925GWEN" />
    <MiniUpload id="8521QKZG" />
    <MiniUpload id="4016GJYR" />

</div>


<style>
    .upload-field {
        display: grid;
        gap: 1rem;
        width: min(100%, 25rem);
        min-height: 15rem;
        border: 2px solid var(--color-accent);
        padding: 1.25rem;
        background: #221f20;
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
