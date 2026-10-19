<script lang="ts">
    import { onMount } from 'svelte'
    import { fade, slide } from 'svelte/transition';
    import { cubicInOut } from 'svelte/easing'
    import type { PageData } from './$types'
    import {
        type UploadLimits,
        type UploadProgress,
        type UploadTokenInfo,
        UPLOAD_TOKEN_MIN_LENGTH,
        NOTE_MAX_LENGTH_DEFAULT,
        UploadTokenError,
        fetchUploadLimits,
        formatFileSize,
        sendUpload,
        sendLinkUpload,
        sendNoteUpload
    } from '$lib/upload/uploader'
    import MiniUpload from './MiniUpload.svelte'
    import { FEED_PAGE_SIZE, fetchFeed, fetchFeedRange, type FeedItem, type FeedResponse } from '$lib/upload/feed'
    import { fetchUploads } from '$lib/upload/downloader'
    import { getHistory, addToHistory, removeFromHistory } from '$lib/upload/history'
    import { spawnAlert } from '$lib/alerts'

    const GALLERY_REFRESH_MS = 30_000
    const TOKEN_HOLD_MS = 600
    const TOKEN_CHECK_DEBOUNCE_MS = 700      // each wrong check counts toward the IP block — don't burn them mid-typing
    const apiEndpoint = import.meta.env.VITE_API_ENDPOINT ?? ''

    // exits: shorter than the intro and eased at both ends so the collapse settles instead of hard-stopping;
    // content fades out ahead of the height (slide alone keeps it opaque until the last 5%)
    const slideOut = (node: Element) => {
        const config = slide(node, { duration: 300, easing: cubicInOut })
        return {
            ...config,
            css: (t: number, u: number) => `${config.css?.(t, u) ?? ''};opacity: ${Math.max(0, (t - 0.25) / 0.75)}`
        }
    }

    // stable {#each} keys — an index-based key re-creates every row after a removed one
    const fileKeys = new WeakMap<File, number>()
    let nextFileKey = 0

    let { data }: { data: PageData } = $props()

    const MODES = ['files', 'link', 'note'] as const
    type Mode = typeof MODES[number]

    let mode = $state<Mode>('files')
    let title = $state('')
    let description = $state('')
    let files = $state<File[]>([])
    let linkUrl = $state('')
    let noteText = $state('')
    let uploadLimits = $derived(data.uploadLimits as UploadLimits | null)
    let limitsError = $derived(data.limitsError)
    let fileErrors = $state<string[]>([])
    let uploadError = $state('')
    let uploadResultId = $state('')
    let isUploading = $state(false)
    let uploadProgress = $state<UploadProgress>()
    let tokenOpen = $state(false)
    let tokenValue = $state('')
    let tokenLimits = $state<UploadLimits | null>(null)
    let tokenError = $state('')
    let tokenChecking = $state(false)
    let tokenInput = $state<HTMLInputElement>()
    let tokenHoldTimer: ReturnType<typeof setTimeout> | undefined
    let tokenHoldFired = false
    let effectiveLimits = $derived(tokenLimits ?? uploadLimits)
    let tokenPending = $derived(tokenOpen && tokenValue.trim() !== '' && !tokenLimits)
    let isFileLimitReached = $derived(effectiveLimits ? files.length >= effectiveLimits.maxcount : false)
    let isDragging = $state(false)
    let isPublic = $state(false)
    let hiddenProgressIndexes = $state(new Set<number>())
    let hideProgressTimer: ReturnType<typeof setTimeout> | undefined
    let noteMaxLength = $derived(uploadLimits?.max_note_length ?? NOTE_MAX_LENGTH_DEFAULT)
    let uploadDisabled = $derived(mode === 'files'
        ? (files.length === 0 || isUploading || tokenPending)
        : mode === 'note'
            ? (noteText.trim() === '' || noteText.length > noteMaxLength || isUploading)
            : (linkUrl.trim() === '' || isUploading))
    let uploadHistory = $state<string[]>([])
    let visibleCount = $state(16)
    let visibleUploads = $derived(uploadHistory.slice(0, visibleCount))
    let hasMore = $derived(uploadHistory.length > visibleCount)
    // History card data, fetched in batches as cards become visible.
    let historyData = $state.raw<Record<string, FeedItem>>({})
    let historyErrors = $state.raw<Record<string, string>>({})
    const historyRequested = new Set<string>()
    let galleryPages = $state<FeedResponse[]>([])
    let galleryLoading = $state(false)
    let galleryError = $state('')
    let galleryItems = $derived(galleryPages.flatMap((page) => page.items))
    let galleryLast = $derived(galleryPages.length > 0 ? galleryPages[galleryPages.length - 1] : undefined)
    let galleryTotal = $derived(galleryLast?.total ?? 0)
    let galleryHasMore = $derived(galleryLast?.has_more ?? false)
    let galleryVisible = $derived(galleryItems.filter((item) => item.type !== 'link'))

    let galleryRevealed = $state(false)

    // Feed fetch fires immediately, but the section itself is revealed a
    // second later so the history cards' batch fetch gets a head start.
    onMount(() => {
        void loadGalleryPage(0)
        const revealTimer = setTimeout(() => { galleryRevealed = true }, 1000)
        const refreshTimer = setInterval(() => { void refreshGallery() }, GALLERY_REFRESH_MS)
        return () => {
            clearTimeout(revealTimer)
            clearInterval(refreshTimer)
        }
    })

    $effect(() => {
        uploadHistory = getHistory()
    })

    // Fetches every newly visible history card in a single request.
    $effect(() => {
        const pending = visibleUploads.filter((id) => !historyRequested.has(id))
        if (pending.length === 0) return
        for (const id of pending) historyRequested.add(id)
        void loadHistoryBatch(pending)
    })

    async function loadHistoryBatch(ids: string[]) {
        try {
            const { items, missing } = await fetchUploads(ids, apiEndpoint)
            const data = { ...historyData }
            for (const item of items) data[item.id] = item
            historyData = data
            if (missing.length > 0) {
                const errors = { ...historyErrors }
                for (const id of missing) errors[id] = '404'
                historyErrors = errors
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed'
            const errors = { ...historyErrors }
            for (const id of ids) {
                errors[id] = message
                // allow a retry the next time the visible set changes
                historyRequested.delete(id)
            }
            historyErrors = errors
        }
    }

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

    // Validates the typed token against the server once it could be one (custom tokens vary in length).
    $effect(() => {
        const token = tokenValue.trim()
        tokenLimits = null
        tokenError = ''
        if (token.length < UPLOAD_TOKEN_MIN_LENGTH) return

        const timer = setTimeout(async () => {
            tokenChecking = true
            try {
                const limits = await fetchUploadLimits(apiEndpoint, fetch, {}, token)
                if (tokenValue.trim() === token) tokenLimits = limits
            } catch (error) {
                if (tokenValue.trim() === token)
                    tokenError = error instanceof Error ? error.message : 'Token check failed'
            } finally {
                tokenChecking = false
            }
        }, TOKEN_CHECK_DEBOUNCE_MS)
        return () => clearTimeout(timer)
    })

    $effect(() => {
        if (tokenOpen) tokenInput?.focus()
    })

    $effect(() => {
        if (title.length === 0) description = ''
    })

    function tokenHoldStart(event: PointerEvent) {
        if (mode !== 'files' || isUploading || event.button !== 0) return
        tokenHoldFired = false
        clearTimeout(tokenHoldTimer)
        tokenHoldTimer = setTimeout(() => {
            tokenHoldFired = true
            tokenOpen = true
        }, TOKEN_HOLD_MS)
    }

    function tokenHoldCancel() {
        clearTimeout(tokenHoldTimer)
        tokenHoldTimer = undefined
    }

    function tokenClose() {
        tokenOpen = false
        tokenValue = ''
    }

    function tokenSummary(info: UploadTokenInfo) {
        const label = info.label ? ` "${info.label}"` : ''
        const count = info.max_files === null ? 'Unlimited files' : `${info.max_files} file${info.max_files === 1 ? '' : 's'}`
        const size = info.max_bytes === null ? 'unlimited size' : formatFileSize(info.max_bytes)
        const uses = info.uses_left === null ? '' : ` · ${info.uses_left} use${info.uses_left === 1 ? '' : 's'} left`
        const expires = info.expires_at ? ` · expires ${new Date(info.expires_at).toLocaleString()}` : ''
        return `Token${label}: ${count} / ${size}${uses}${expires}`
    }

    function uploadClick() {
        // the click that ends a long-press only opens the token field
        if (tokenHoldFired) {
            tokenHoldFired = false
            return
        }
        if (uploadDisabled) return
        void (mode === 'files' ? uploadFiles() : mode === 'note' ? uploadNote() : uploadLink())
    }

    function processFiles(selectedFiles: File[]) {
        const nextFiles: File[] = []
        const nextErrors: string[] = []

        if (!effectiveLimits) return

        for (const file of selectedFiles) {
            if (files.length + nextFiles.length >= effectiveLimits.maxcount) {
                nextErrors.push(`Only ${effectiveLimits.maxcount} files can be uploaded at once.`)
                break
            }
            if (file.size > effectiveLimits.maxsizeperfile) {
                nextErrors.push(`${file.name} is larger than ${displayedFileSizeLimit(effectiveLimits)}.`)
                continue
            }
            fileKeys.set(file, nextFileKey++)
            nextFiles.push(file)
        }

        files = [...files, ...nextFiles]
        fileErrors = nextErrors
    }

    // MAX_FILE_SIZE carries 1 MB of headroom on the server; token limits are exact
    function displayedFileSizeLimit(limits: UploadLimits) {
        return formatFileSize(limits.token ? limits.maxsizeperfile : limits.maxsizeperfile - 1024 * 1024)
    }

    function addFiles(event: Event) {
        const input = event.currentTarget as HTMLInputElement
        processFiles(Array.from(input.files ?? []))
        input.value = ''
    }

    function handleDragOver(event: DragEvent) {
        event.preventDefault()
        if (!effectiveLimits || isFileLimitReached) return
        isDragging = true
    }

    function handleDragLeave() {
        isDragging = false
    }

    function handleDrop(event: DragEvent) {
        event.preventDefault()
        isDragging = false
        if (!effectiveLimits || isFileLimitReached) return
        processFiles(Array.from(event.dataTransfer?.files ?? []))
    }

    function removeFile(index: number) {
        files = files.filter((_, fileIndex) => fileIndex !== index)
        uploadProgress = undefined
        clearProgressTimers()
    }

    function ignoreUpload(id: string) {
        removeFromHistory(id)
        uploadHistory = getHistory()
    }

    async function loadGalleryPage(start: number) {
        if (galleryLoading) return
        galleryError = ''
        try {
            galleryLoading = true
            const page = await fetchFeed(apiEndpoint, start, start + FEED_PAGE_SIZE)
            galleryPages = [...galleryPages, page]
        } catch (error) {
            galleryError = error instanceof Error ? error.message : 'Failed to load feed'
        } finally {
            galleryLoading = false
        }
    }

    function loadMoreGallery() {
        const last = galleryLast
        if (!last || !last.has_more) return
        void loadGalleryPage(last.end)
    }

    // Re-fetches the loaded feed range so new public uploads appear without a
    // page reload. Current cards are kept untouched when nothing changed.
    async function refreshGallery() {
        const end = galleryLast?.end ?? 0
        if (end === 0 || galleryLoading) return
        try {
            const range = await fetchFeedRange(apiEndpoint, end)
            const unchanged =
                range.items.length === galleryItems.length &&
                range.items.every((item, index) => item.id === galleryItems[index]?.id) &&
                range.total === galleryTotal &&
                range.has_more === galleryHasMore
            if (!unchanged) {
                const prevById = new Map(galleryItems.map((item) => [item.id, item]))
                galleryPages = [{ ...range, items: range.items.map((item) => prevById.get(item.id) ?? item) }]
            }
        } catch {
            // keep current cards; retried on the next refresh
        }
    }

    async function uploadFiles() {
        uploadError = ''
        uploadResultId = ''
        uploadProgress = undefined
        clearProgressTimers()

        const token = tokenLimits ? tokenValue.trim() : undefined
        try {
            isUploading = true
            const result = await sendUpload(apiEndpoint, files, title, description, isPublic, (progress) => {
                uploadProgress = progress
            }, token)
            // a token covers a single upload — it has to be entered again for the next one
            if (token) tokenClose()
            uploadResultId = result.id
            addToHistory(result.id)
            uploadHistory = getHistory()
            spawnAlert('success', `Upload complete: ${result.id}`)
            if (isPublic) void refreshGallery()
        } catch (error) {
            uploadError = error instanceof Error ? error.message : 'Upload failed'
            if (error instanceof UploadTokenError) {
                tokenLimits = null
                tokenError = error.message
            }
            spawnAlert('error', `Upload failed: ${uploadError}`)
        } finally {
            isUploading = false
        }
    }

    function switchMode(next: Mode) {
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
            const shortUrl = new URL(`/${result.id}`, window.location.href).href

            try {
                await navigator.clipboard.writeText(shortUrl)
                spawnAlert('success', 'Short link copied')
            } catch {
                spawnAlert('error', `Short link created but could not be copied: ${shortUrl}`)
            }
        } catch (error) {
            uploadError = error instanceof Error ? error.message : 'Upload failed'
            spawnAlert('error', `Upload failed: ${uploadError}`)
        } finally {
            isUploading = false
        }
    }

    async function uploadNote() {
        uploadError = ''
        uploadResultId = ''

        try {
            isUploading = true
            const result = await sendNoteUpload(apiEndpoint, noteText, title.trim(), isPublic)
            uploadResultId = result.id
            addToHistory(result.id)
            uploadHistory = getHistory()
            spawnAlert('success', `Note shared: ${result.id}`)
            if (isPublic) void refreshGallery()
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

<svelte:head>
    <title>femboyz.cloud</title>
</svelte:head>

<div class="page-layout">
<div class="upload-sidebar">
<div class="upload-field">
    <div class="mode-switcher" style={`--mode-index: ${MODES.indexOf(mode)}`}>
        <span class="mode-indicator" aria-hidden="true"></span>
        <button class="mode-tab" class:active={mode === 'files'} type="button" onclick={() => switchMode('files')}>Files</button>
        <button class="mode-tab" class:active={mode === 'link'} type="button" onclick={() => switchMode('link')}>Link</button>
        <button class="mode-tab" class:active={mode === 'note'} type="button" onclick={() => switchMode('note')}>Note</button>
    </div>

    <div class="field-header">
        <div>
            <h1>New upload</h1>
            {#if mode === 'files'}
                <p>Add details and choose one or more files</p>
                {#if tokenLimits?.token}
                    <p class="limit-note token-note">{tokenSummary(tokenLimits.token)}</p>
                {:else if uploadLimits}
                    <p class="limit-note">
                        Up to {uploadLimits.maxcount} files, {displayedFileSizeLimit(uploadLimits)} each.
                    </p>
                {/if}
            {:else if mode === 'note'}
                <p>Share a piece of text</p>
                <p class="limit-note">Up to {noteMaxLength.toLocaleString()} characters.</p>
            {:else}
                <p>Shorten a link</p>
                <p>Automatically copied to clipboard</p>
            {/if}
        </div>
    </div>

    {#if mode === 'files'}
        <div in:slide out:slideOut>
            <label class="form-field">
                <input
                    bind:value={title}
                    type="text"
                    name="title"
                    placeholder="Upload title"
                    maxlength={effectiveLimits?.max_title_length}
                />
                {#if uploadLimits && title.length > 0}
                    <span class="char-counter" class:near-limit={title.length >= uploadLimits.max_title_length * 0.85}>
                        {title.length}/{uploadLimits.max_title_length}
                    </span>
                {/if}
            </label>
        </div>

        {#if title.length > 0}
            <div in:slide out:slideOut>
                <label class="form-field">
                    <textarea
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
                </label>
            </div>
        {/if}

        <ul in:slide out:slideOut class="file-list" aria-label="Selected files">
            {#each files as file, index (fileKeys.get(file))}
                <li in:slide out:slideOut>
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
                <li in:slide out:slideOut>
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
            <p in:slide|global out:slideOut|global class="error-message">Something is wrong: {limitsError}</p>
        {/if}

        {#if fileErrors.length > 0}
            <ul in:slide|global out:slideOut|global class="error-list" aria-label="File selection errors">
                {#each fileErrors as error}
                    <li>{error}</li>
                {/each}
            </ul>
        {/if}
    {:else if mode === 'note'}
        <div in:slide out:slideOut>
            <label class="form-field">
                <input
                    bind:value={title}
                    type="text"
                    name="title"
                    placeholder="Note title (optional)"
                    aria-label="Note title"
                    maxlength={uploadLimits?.max_title_length}
                    disabled={isUploading}
                />
            </label>
        </div>

        <div in:slide out:slideOut>
            <label class="form-field">
                <textarea
                    class="note-input"
                    bind:value={noteText}
                    name="note"
                    aria-label="Note text"
                    rows="10"
                    placeholder="Write or paste your note"
                    maxlength={noteMaxLength}
                    spellcheck="false"
                    disabled={isUploading}
                ></textarea>
                <span class="char-counter" class:near-limit={noteText.length >= noteMaxLength * 0.85}>
                    {noteText.length.toLocaleString()}/{noteMaxLength.toLocaleString()}
                </span>
            </label>
        </div>
    {:else}
        <label in:slide out:slideOut class="form-field">
            <input bind:value={linkUrl} type="url" name="link" placeholder="https://example.com" />
        </label>
    {/if}

    {#if uploadError}
        <p in:slide|global out:slideOut|global class="error-message">Upload failed: {uploadError}</p>
    {/if}

    {#if uploadResultId}
        <p in:slide|global out:slideOut|global class="success-message">
            {mode === 'link' ? 'Short link' : mode === 'note' ? 'Note shared' : 'Uploaded'}: <a href={`/${uploadResultId}`}>{uploadResultId}</a>
        </p>
    {/if}

    {#if mode === 'files' && tokenOpen}
        <div in:slide out:slideOut class="token-field">
            <div class="token-row">
                <label class="form-field">
                    <input
                        bind:this={tokenInput}
                        bind:value={tokenValue}
                        type="text"
                        name="upload-token"
                        placeholder="Upload token"
                        autocomplete="off"
                        spellcheck="false"
                        disabled={isUploading}
                    />
                </label>
                <button class="fb-button token-close" type="button" onclick={tokenClose} disabled={isUploading} aria-label="Remove token">
                    Remove
                </button>
            </div>
            {#if tokenChecking}
                <p class="token-status">Checking token...</p>
            {:else if tokenError}
                <p class="error-message">{tokenError}</p>
            {/if}
        </div>
    {/if}

    <div class="finalize">
        {#if mode !== 'link'}
            <label class="public-checkbox">
                <input type="checkbox" bind:checked={isPublic} disabled={isUploading} />
                <span class="checkbox-box" aria-hidden="true"></span>
                <span class="checkbox-label">Make public</span>
            </label>
        {:else}
            <span></span>
        {/if}
        <!-- aria-disabled instead of disabled: a disabled button gets no pointer events, and the token long-press must work before files are picked -->
        <button
            class="upload-button fb-button"
            type="button"
            title={mode === 'files' ? 'Hold to enter an upload token' : undefined}
            aria-disabled={uploadDisabled}
            onclick={uploadClick}
            onpointerdown={tokenHoldStart}
            onpointerup={tokenHoldCancel}
            onpointerleave={tokenHoldCancel}
            onpointercancel={tokenHoldCancel}
            oncontextmenu={(event) => { if (mode === 'files') event.preventDefault() }}
        >
            {isUploading ? 'Uploading...' : 'Upload!'}
        </button>
    </div>
</div>
</div>

<div class="uploads-grid-wrap">
    <div class="uploads-grid">
        {#each visibleUploads as id (id)}
            <MiniUpload {id} initial={historyData[id]} error={historyErrors[id]} onIgnore={ignoreUpload} />
        {/each}
    </div>
    {#if hasMore}
        <button class="load-more-btn" type="button" onclick={() => visibleCount += 8} aria-label="Load more uploads">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M201.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 338.7 54.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z"/></svg>
        </button>
    {/if}
</div>
</div>

{#if galleryRevealed}
<section class="gallery-section" aria-label="Public gallery" transition:fade={{ duration: 400 }}>
    <div class="gallery-header">
        <h2>Gallery</h2>
        {#if galleryPages.length > 0}
            <span class="gallery-count">{galleryTotal} {galleryTotal === 1 ? 'upload' : 'uploads'}</span>
        {/if}
    </div>

    {#if galleryPages.length === 0}
        {#if galleryError}
            <p class="error-message">Could not load the public gallery: {galleryError}</p>
            <button class="fb-button fb-button-ghost gallery-more" type="button" onclick={() => loadGalleryPage(0)}>
                Try again
            </button>
        {:else}
            <p class="gallery-note">Loading public uploads...</p>
        {/if}
    {:else if galleryTotal === 0}
        <p class="gallery-note">No public uploads yet — tick "Make public" when uploading to appear here.</p>
    {:else}
        <div class="gallery-grid-wrap" class:fade-bottom={galleryHasMore}>
            <div class="uploads-grid">
                {#each galleryVisible as item (item.id)}
                    <MiniUpload id={item.id} initial={item} showViews />
                {/each}
            </div>
        </div>

        {#if galleryError}
            <p class="error-message">Could not load more uploads: {galleryError}</p>
        {/if}

        {#if galleryHasMore}
            <button
                class="fb-button fb-button-ghost gallery-more"
                type="button"
                onclick={loadMoreGallery}
                disabled={galleryLoading}
            >
                {galleryLoading ? 'Loading...' : 'Load more'}
            </button>
        {/if}
    {/if}
</section>
{/if}


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
        width: 25rem;
        min-height: 15rem;
        border: 2px solid var(--color-accent);
        padding: 0;
        background: #221f20;
        overflow: hidden;
    }

    .mode-switcher {
        --mode-gap: 0.75rem;
        position: relative;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--mode-gap);
        margin: 1.25rem 1.25rem 0;
    }

    /* one accent frame that slides between the tabs, drawn over their grey borders */
    .mode-indicator {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: calc((100% - 2 * var(--mode-gap)) / 3);
        box-sizing: border-box;
        border: 2px solid var(--color-accent);
        pointer-events: none;
        transform: translateX(calc(var(--mode-index, 0) * (100% + var(--mode-gap))));
        transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .mode-tab {
        padding: 0.55rem 1rem;
        background: none;
        border: 2px solid #4b4246;
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
    }

    @media (prefers-reduced-motion: reduce) {
        .mode-indicator {
            transition: none;
        }
    }

    /* spacing via margins, not gap: slide animates margins, a parent's gap snaps shut only once the node is removed */
    /* doubled class lifts specificity so `margin: 0` resets on .file-list / .error-message don't swallow the spacing */
    .upload-field.upload-field > * + * {
        margin-top: 1rem;
    }

    .upload-field > :not(.mode-switcher) {
        padding-left: 1.25rem;
        padding-right: 1.25rem;
    }

    .upload-field > .field-header {
        padding-top: 0.5rem;
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

    .form-field .note-input {
        min-height: 12rem;
        max-height: 60vh;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.85rem;
        line-height: 1.5;
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
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        touch-action: manipulation;
    }

    .token-field {
        display: grid;
        gap: 0.35rem;
    }

    .token-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.5rem;
        align-items: stretch;
    }

    .token-status {
        margin: 0;
        font-size: 0.85rem;
        color: #6a6468;
    }

    .token-note {
        color: #b7f0ce;
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
        padding: 0;
        list-style: none;
    }

    .file-list {
        display: grid;
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .file-list > li + li {
        margin-top: 0.65rem;
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
    .upload-button[aria-disabled='true'] {
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
        grid-template-columns: repeat(auto-fill, minmax(min(13rem, 100%), 1fr));
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
        transition: border-color 0.15s, color 0.15s, transform 0.2s;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        z-index: 15;
        position: relative;
    }

    /* Fades out the bottom rows of the uploads grid. Upward-only, so it can
       never veil the sections below. */
    .load-more-btn::before {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 1rem);
        height: 9rem;
        background: linear-gradient(to bottom, transparent, #1b1a1a);
        pointer-events: none;
        transition: opacity 0.2s ease;
    }

    .load-more-btn:hover::before {
        opacity: 0.5;
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
    }

    .gallery-section {
        display: grid;
        gap: 1rem;
        margin-top: 17rem;
    }

    .gallery-grid-wrap {
        position: relative;
    }

    .gallery-grid-wrap.fade-bottom::after {
        content: '';
        position: absolute;
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 5;
        height: 10rem;
        background: linear-gradient(to bottom, transparent, rgb(27 26 26 / 82%) 68%, #1b1a1a);
        pointer-events: none;
    }

    .gallery-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
        border-bottom: 1px solid #3b3538;
        padding-bottom: 0.5rem;
    }

    .gallery-header h2 {
        margin: 0;
        font-size: 2rem;
    }

    .gallery-count {
        color: #8a8385;
        font-size: 0.9rem;
    }

    .gallery-note {
        margin: 0;
        color: #c9c3c5;
    }

    .gallery-more {
        justify-self: center;
        min-width: 12rem;
    }

    @media (max-width: 48rem) {
        .page-layout {
            flex-direction: column;
        }

        /* the upload card fills the column instead of its fixed 25rem, which overflows a phone */
        .upload-sidebar {
            position: static;
            align-self: stretch;
        }

        .upload-field {
            width: auto;
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
