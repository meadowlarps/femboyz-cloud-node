<script lang="ts">
    import { onMount, tick } from 'svelte'
    import { fade, fly, scale, slide } from 'svelte/transition'
    import { flip } from 'svelte/animate'
    import { backOut, cubicInOut, cubicOut } from 'svelte/easing'
    import { prefersReducedMotion } from 'svelte/motion'
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
    const REORDER_DRAG_THRESHOLD_PX = 4
    const REORDER_HOLD_MS = 300             // touch: a long press on a tile picks it up
    const REORDER_HOLD_SLOP_PX = 8          // moving further than this before the hold fires is a scroll
    const TRAY_COLUMNS = 3                  // matches .tray's grid-template-columns, for Up/Down
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
    let trayEl = $state<HTMLUListElement>()
    // tile being dragged to reorder, and its offset from the slot it currently occupies
    let reorderKey = $state<number>()
    let reorderOffset = $state({ x: 0, y: 0 })
    // armed: movement drags the tile (mouse at once, touch after the long press)
    let reorderPending: {
        key: number, node: HTMLElement, startX: number, startY: number, startLeft: number, startTop: number, armed: boolean
    } | undefined
    let reorderHoldTimer: ReturnType<typeof setTimeout> | undefined
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
        releaseThumb(files[index])
        files = files.filter((_, fileIndex) => fileIndex !== index)
        uploadProgress = undefined
        clearProgressTimers()
    }

    function moveFile(from: number, to: number) {
        if (from === to || to < 0 || to >= files.length) return
        const next = [...files]
        const [file] = next.splice(from, 1)
        next.splice(to, 0, file!)
        files = next
        // progress is tracked by index, so it no longer lines up
        uploadProgress = undefined
        clearProgressTimers()
    }

    function reorderStart(event: PointerEvent, file: File) {
        if (isUploading || files.length < 2 || event.button !== 0) return
        if ((event.target as HTMLElement).closest('button')) return
        const armed = event.pointerType === 'mouse'
        // also keeps the browser from starting a native drag of the thumbnail image
        if (armed) event.preventDefault()
        const node = event.currentTarget as HTMLElement
        node.setPointerCapture(event.pointerId)
        const pending = {
            key: fileKeys.get(file)!, node, startX: event.clientX, startY: event.clientY,
            startLeft: node.offsetLeft, startTop: node.offsetTop, armed
        }
        reorderPending = pending
        if (armed) return
        // a touch scrolls the page, unless the finger holds still first
        clearTimeout(reorderHoldTimer)
        reorderHoldTimer = setTimeout(() => {
            if (reorderPending !== pending) return
            pending.armed = true
            reorderKey = pending.key
            navigator.vibrate?.(10)
        }, REORDER_HOLD_MS)
    }

    // touchmove has to be non-passive to stop the page scrolling under an armed drag
    $effect(() => {
        const tray = trayEl
        if (!tray) return
        const block = (event: Event) => { if (reorderPending?.armed) event.preventDefault() }
        tray.addEventListener('touchmove', block, { passive: false })
        tray.addEventListener('contextmenu', block)
        return () => {
            tray.removeEventListener('touchmove', block)
            tray.removeEventListener('contextmenu', block)
        }
    })

    async function reorderMove(event: PointerEvent) {
        const pending = reorderPending
        if (!pending) return
        const dx = event.clientX - pending.startX
        const dy = event.clientY - pending.startY
        if (!pending.armed) {
            if (Math.hypot(dx, dy) > REORDER_HOLD_SLOP_PX) reorderEnd()
            return
        }
        if (reorderKey === undefined) {
            if (Math.hypot(dx, dy) < REORDER_DRAG_THRESHOLD_PX) return
            reorderKey = pending.key
        }

        // the dragged tile drops into the slot whose centre is nearest its own;
        // offsetLeft/Top ignore transforms, so tiles mid-flip don't skew the comparison
        const node = pending.node
        const x = pending.startLeft + dx + node.offsetWidth / 2
        const y = pending.startTop + dy + node.offsetHeight / 2
        const tiles = Array.from(trayEl?.querySelectorAll<HTMLElement>(':scope > li[data-key]') ?? [])
        const from = tiles.indexOf(node)
        let to = from
        let best = Infinity
        tiles.forEach((tile, index) => {
            const distance = Math.hypot(
                tile.offsetLeft + tile.offsetWidth / 2 - x,
                tile.offsetTop + tile.offsetHeight / 2 - y
            )
            if (distance < best) {
                best = distance
                to = index
            }
        })
        if (from !== -1 && to !== from) {
            moveFile(from, to)
            await tick()
        }
        if (reorderPending === pending)
            reorderOffset = { x: pending.startLeft + dx - node.offsetLeft, y: pending.startTop + dy - node.offsetTop }
    }

    function reorderEnd() {
        clearTimeout(reorderHoldTimer)
        reorderPending = undefined
        reorderKey = undefined
        reorderOffset = { x: 0, y: 0 }
    }

    async function reorderKeydown(event: KeyboardEvent, index: number) {
        if (isUploading || event.target !== event.currentTarget) return
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -TRAY_COLUMNS, ArrowDown: TRAY_COLUMNS }[event.key]
        if (step === undefined) return
        event.preventDefault()
        const to = Math.max(0, Math.min(files.length - 1, index + step))
        if (to === index) return
        const tile = event.currentTarget as HTMLElement
        moveFile(index, to)
        // the keyed {#each} moves the same element, but focus can drop on the way
        await tick()
        tile.focus()
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
        uploadStartedAt = 0
        try {
            isUploading = true
            const result = await sendUpload(apiEndpoint, files, title, description, isPublic, (progress) => {
                if (!uploadStartedAt) uploadStartedAt = performance.now()
                uploadProgress = progress
            }, token)
            lastUpload = { count: files.length, bytes: totalBytes, isPublic }
            // a token covers a single upload — it has to be entered again for the next one
            if (token) tokenClose()
            uploadResultId = result.id
            addToHistory(result.id)
            uploadHistory = getHistory()
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
        // leaving the done screen starts over, rather than offering the same files for upload again
        if (isDone) startNewUpload()
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

    // ── motion ──
    // Svelte transitions ignore prefers-reduced-motion on their own, so every duration goes through here
    const ms = (duration: number) => prefersReducedMotion.current ? 0 : duration

    // Animates the card's height whenever its content jumps (files picked, upload done, mode switched).
    // Small steps are left alone: those come from the slide transitions inside, which animate themselves.
    function smoothHeight(card: HTMLElement) {
        const inner = card.firstElementChild as HTMLElement
        let animation: Animation | undefined
        let lastTarget = inner.offsetHeight
        // by the time the observer reports, the card has already taken its new height, so remember the old one
        let lastHeight = card.offsetHeight

        const observer = new ResizeObserver(() => {
            const style = getComputedStyle(card)
            const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
                + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
            const target = inner.offsetHeight
            // mid-animation the card still shows the animated height, which is where the next one starts
            const from = animation?.playState === 'running' ? card.getBoundingClientRect().height : lastHeight
            const jump = Math.abs(target - lastTarget)
            lastTarget = target
            lastHeight = target + chrome
            if (jump < 24 || prefersReducedMotion.current) return

            animation?.cancel()
            card.style.overflow = 'clip'
            const current = card.animate(
                [{ height: `${from}px` }, { height: `${lastHeight}px` }],
                { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
            )
            animation = current
            // a cancelled animation reports in late, after its replacement has started
            current.onfinish = current.oncancel = () => { if (animation === current) card.style.overflow = '' }
        })

        observer.observe(inner)
        return { destroy: () => observer.disconnect() }
    }

    // the done summary's veil: blur and darkening build up together over the finished tray
    function veil(_node: Element, { duration }: { duration: number }) {
        return {
            duration,
            easing: cubicOut,
            css: (t: number) => `backdrop-filter: blur(${t * 10}px) brightness(${1 - t * 0.45});`
                + `-webkit-backdrop-filter: blur(${t * 10}px) brightness(${1 - t * 0.45});`
                + `background-color: rgb(20 18 19 / ${t * 0.45})`
        }
    }

    // ── tray: thumbnails, totals, overall progress ──
    const thumbUrls = new WeakMap<File, string>()
    let uploadStartedAt = 0
    let lastUpload = $state<{ count: number; bytes: number; isPublic: boolean } | null>(null)
    // the finished upload stays on screen under a blurred summary until "New upload"
    let isDone = $derived(mode === 'files' && !!uploadResultId && !!lastUpload)
    let totalBytes = $derived(files.reduce((sum, file) => sum + file.size, 0))
    let overallPercent = $derived(uploadProgress && uploadProgress.total > 0
        ? Math.round((uploadProgress.loaded / uploadProgress.total) * 100) : 0)
    let filesDone = $derived(uploadProgress
        ? uploadProgress.files.filter((fp) => fp.total > 0 && fp.loaded >= fp.total).length : 0)
    let etaLabel = $derived.by(() => {
        if (!uploadProgress || !uploadStartedAt || uploadProgress.loaded === 0) return ''
        const elapsed = (performance.now() - uploadStartedAt) / 1000
        if (elapsed < 1) return ''
        const left = (uploadProgress.total - uploadProgress.loaded) / (uploadProgress.loaded / elapsed)
        return left < 1 ? '' : left < 60 ? `~${Math.ceil(left)} s` : `~${Math.ceil(left / 60)} min`
    })

    // the add tile rides along in the keyed list so it glides with the others when tiles come and go
    let trayItems = $derived<(File | null)[]>(!isFileLimitReached && !isUploading && !isDone ? [...files, null] : files)
    let publicLabelWidth = $state(0)
    let linkLabelWidth = $state(0)
    let chipWidth = $derived(isPublic ? publicLabelWidth : linkLabelWidth)
    let buttonLabelKey = $derived(isUploading
        ? (uploadProgress ? 'progress' : 'preparing')
        : `${mode}:${files.length}`)

    function thumbKind(file: File) {
        return file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'other'
    }

    function thumbUrl(file: File) {
        let url = thumbUrls.get(file)
        if (!url) {
            url = URL.createObjectURL(file)
            thumbUrls.set(file, url)
        }
        return url
    }

    function releaseThumb(file: File) {
        const url = thumbUrls.get(file)
        if (url) URL.revokeObjectURL(url)
        thumbUrls.delete(file)
    }

    function fileExt(file: File) {
        return /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1].toUpperCase() ?? 'FILE'
    }

    function tileState(index: number): 'idle' | 'queued' | 'active' | 'done' {
        const progress = fileProgress(index)
        if (progress && progress.total > 0 && progress.loaded >= progress.total) return 'done'
        if (!isUploading) return 'idle'
        return progress && progress.loaded > 0 ? 'active' : 'queued'
    }

    function trayDragLeave(event: DragEvent) {
        const card = event.currentTarget as HTMLElement
        if (!card.contains(event.relatedTarget as Node | null)) isDragging = false
    }

    function startNewUpload() {
        for (const file of files) releaseThumb(file)
        files = []
        title = ''
        description = ''
        uploadResultId = ''
        uploadProgress = undefined
        lastUpload = null
        clearProgressTimers()
    }

    async function copyResultLink() {
        try {
            await navigator.clipboard.writeText(new URL(`/${uploadResultId}`, window.location.href).href)
            spawnAlert('success', 'Link copied')
        } catch {
            spawnAlert('error', 'Could not copy link')
        }
    }
</script>

<svelte:head>
    <title>femboyz.cloud</title>
</svelte:head>

<div class="page-layout">
<div class="upload-sidebar">
<div
    class="upload-field"
    class:dragging={isDragging && mode === 'files'}
    role="region"
    aria-label="New upload"
    use:smoothHeight
    ondragover={(event) => { if (mode === 'files' && !isDone) handleDragOver(event) }}
    ondragleave={trayDragLeave}
    ondrop={(event) => { if (mode === 'files' && !isDone) handleDrop(event) }}
>
<div class="panel-inner">
    <div class="panel-head">
        <div class="mode-pills" role="tablist" style={`--mode-index: ${MODES.indexOf(mode)}`}>
            <span class="mode-pill-indicator" aria-hidden="true"></span>
            {#each MODES as m}
                <button
                    class="mode-pill"
                    class:active={mode === m}
                    role="tab"
                    aria-selected={mode === m}
                    type="button"
                    disabled={isUploading}
                    onclick={() => switchMode(m)}
                >{m === 'files' ? 'Files' : m === 'link' ? 'Link' : 'Note'}</button>
            {/each}
        </div>
    </div>

    <div class="compose">
        {#if mode !== 'link'}
            <div class="stage">
                <!-- inert under the summary: the finished upload is shown, not edited -->
                <div class="stage-content" inert={isDone}>
                    <input
                        class="title-input"
                        bind:value={title}
                        type="text"
                        name="title"
                        placeholder={mode === 'note' ? 'Untitled note' : 'Untitled upload'}
                        aria-label="Title"
                        maxlength={effectiveLimits?.max_title_length}
                        disabled={isUploading}
                    />
                    {#if mode === 'files'}
                        <div class="mode-body" in:fade={{ duration: ms(200) }}>
                        <textarea
                            class="desc-input"
                            bind:value={description}
                            name="description"
                            rows="1"
                            placeholder="Description"
                            aria-label="Description"
                            maxlength={uploadLimits?.max_desc_length}
                            disabled={isUploading}
                        ></textarea>

                        <ul class="tray" class:empty={files.length === 0} aria-label="Selected files" bind:this={trayEl}>
                            {#each trayItems as file, index (file ? fileKeys.get(file) : 'add')}
                                {@const key = file ? fileKeys.get(file) : undefined}
                                {@const reorderable = !!file && files.length > 1 && !isUploading}
                                <!-- a reorderable tile is focusable so the arrow keys can move it -->
                                <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
                                <li
                                    class="tile"
                                    class:add-tile={!file}
                                    class:reorderable
                                    class:reordering={key !== undefined && key === reorderKey}
                                    data-key={key}
                                    data-state={file ? tileState(index) : undefined}
                                    style={key !== undefined && key === reorderKey
                                        ? `transform: translate(${reorderOffset.x}px, ${reorderOffset.y}px) scale(1.05)` : undefined}
                                    tabindex={reorderable ? 0 : undefined}
                                    aria-label={reorderable && file
                                        ? `${file.name}, position ${index + 1} of ${files.length}. Use arrow keys to reorder` : undefined}
                                    animate:flip={{ duration: key !== undefined && key === reorderKey ? 0 : ms(300), easing: cubicOut }}
                                    in:scale={{ start: 0.8, duration: ms(260), easing: backOut }}
                                    out:scale={{ start: 0.85, duration: ms(160) }}
                                    onpointerdown={file ? (event) => reorderStart(event, file) : undefined}
                                    onpointermove={file ? reorderMove : undefined}
                                    onpointerup={file ? reorderEnd : undefined}
                                    onpointercancel={file ? reorderEnd : undefined}
                                    onkeydown={reorderable ? (event) => reorderKeydown(event, index) : undefined}
                                >
                                    {#if file}
                                        {@const state = tileState(index)}
                                        {@const kind = thumbKind(file)}
                                        {#if kind === 'image'}
                                            <img class="thumb" src={thumbUrl(file)} alt="" draggable="false" />
                                        {:else if kind === 'video'}
                                            <video class="thumb" src={`${thumbUrl(file)}#t=0.5`} muted preload="metadata" draggable="false"></video>
                                            <span class="kind-badge">{fileExt(file)}</span>
                                        {:else}
                                            <div class="thumb generic"><span>{fileExt(file)}</span></div>
                                        {/if}

                                        {#if state === 'active'}
                                            <div class="tile-overlay" transition:fade={{ duration: ms(180) }}>
                                                {#if kind === 'other'}<span class="ext">{fileExt(file)}</span>{/if}
                                                {progressPercent(index)}%
                                            </div>
                                            <div class="tile-bar" style={`width: ${progressPercent(index)}%`}></div>
                                        {:else if state === 'queued'}
                                            <div class="tile-overlay muted" transition:fade={{ duration: ms(180) }}>
                                                {#if kind === 'other'}<span class="ext">{fileExt(file)}</span>{/if}
                                                Queued
                                            </div>
                                        {:else if state === 'done'}
                                            <span class="tile-done" aria-label="Uploaded" in:scale={{ start: 0.3, duration: ms(320), easing: backOut }}>
                                                <svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>
                                            </span>
                                        {/if}

                                        <div class="tile-caption">
                                            <span class="name">{file.name}</span>
                                            <span class="size">{formatFileSize(file.size)}</span>
                                        </div>

                                        {#if !isUploading}
                                            <button class="tile-remove" type="button" aria-label={`Remove ${file.name}`} onclick={() => removeFile(index)}>
                                                <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
                                            </button>
                                        {/if}
                                    {:else}
                                        <label for="file_input">
                                            <svg class="add-icon" viewBox="0 0 24 24" aria-hidden="true">
                                                {#if files.length === 0}
                                                    <path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>
                                                {:else}
                                                    <path d="M12 5v14M5 12h14"/>
                                                {/if}
                                            </svg>
                                            {#if files.length === 0}
                                                <strong>Drop files or <u>browse</u></strong>
                                                {#if tokenLimits?.token}
                                                    <small class="token-note">{tokenSummary(tokenLimits.token)}</small>
                                                {:else if uploadLimits}
                                                    <small>Up to {uploadLimits.maxcount} files, {displayedFileSizeLimit(uploadLimits)} each</small>
                                                {/if}
                                            {:else}
                                                <span>Add more</span>
                                            {/if}
                                            <input class="file-input" type="file" id="file_input" multiple hidden onchange={addFiles} />
                                        </label>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                        </div>
                    {/if}
                </div>

                {#if isDone && lastUpload}
                    <div class="done-overlay" in:veil={{ duration: ms(420) }} out:veil={{ duration: ms(260) }}>
                        <div class="done-check" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>
                        </div>
                        <h2>Uploaded!</h2>
                        <p>
                            {lastUpload.count} {lastUpload.count === 1 ? 'file' : 'files'} · {formatFileSize(lastUpload.bytes)} · {lastUpload.isPublic ? 'public' : 'link access'}
                        </p>
                    </div>
                {/if}
            </div>
        {/if}

        {#if mode === 'files'}
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
            <label class="form-field mode-body" in:fade={{ duration: ms(200) }}>
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
        {:else}
            <label class="form-field mode-body" in:fade={{ duration: ms(200) }}>
                <input bind:value={linkUrl} type="url" name="link" placeholder="https://example.com" aria-label="Link to shorten" />
                <span class="field-hint">The short link is copied to your clipboard.</span>
            </label>
        {/if}

        {#if uploadError}
            <p in:slide|global out:slideOut|global class="error-message">Upload failed: {uploadError}</p>
        {/if}

        {#if uploadResultId && mode !== 'files'}
            <p in:slide|global out:slideOut|global class="success-message">
                {mode === 'link' ? 'Short link' : 'Note shared'}: <a href={`/${uploadResultId}`}>{uploadResultId}</a>
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

        <!-- the upload button and its meta row give way to the finished upload's link and actions -->
        <div class="action-slot">
            {#if isDone}
                <div class="result" in:fly={{ y: 8, duration: ms(320), delay: ms(120), easing: cubicOut }} out:fade={{ duration: ms(150) }}>
                    <div class="result-link">
                        <a href={`/${uploadResultId}`}><span class="host">femboyz.cloud/</span><b>{uploadResultId}</b></a>
                        <button class="fb-button copy" type="button" onclick={copyResultLink}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/></svg>
                            Copy
                        </button>
                    </div>
                    <div class="done-actions">
                        <a class="ghost-action" href={`/${uploadResultId}`}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>
                            Open
                        </a>
                        <button class="ghost-action" type="button" onclick={startNewUpload}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                            New upload
                        </button>
                    </div>
                </div>
            {:else}
                <div class="action-default" in:fade={{ duration: ms(220), delay: ms(100) }} out:fade={{ duration: ms(150) }}>
                <!-- aria-disabled instead of disabled: a disabled button gets no pointer events, and the token long-press must work before files are picked -->
                <button
                    class="upload-button"
                    class:busy={isUploading}
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
                    {#if isUploading && mode === 'files'}
                        <span class="upload-fill" class:indeterminate={!uploadProgress} style={uploadProgress ? `width: ${overallPercent}%` : undefined}></span>
                    {/if}
                    {#key buttonLabelKey}
                        <span class="upload-label" class:centered={!(isUploading && mode === 'files')} in:fly={{ y: 6, duration: ms(220), easing: cubicOut }}>
                            {#if isUploading && mode === 'files'}
                                <span>{uploadProgress ? `${Math.min(filesDone + 1, files.length)} of ${files.length}` : 'Preparing…'}</span>
                                {#if uploadProgress}
                                    <small>{overallPercent}% · {formatFileSize(uploadProgress.loaded)} / {formatFileSize(uploadProgress.total)}{etaLabel ? ` · ${etaLabel}` : ''}</small>
                                {/if}
                            {:else if mode === 'files'}
                                {#if files.length > 0}
                                    Upload {files.length} {files.length === 1 ? 'file' : 'files'} <small>· {formatFileSize(totalBytes)}</small>
                                {:else}
                                    Upload!
                                {/if}
                            {:else}
                                {isUploading ? 'Working…' : mode === 'note' ? 'Share note' : 'Shorten link'}
                            {/if}
                        </span>
                    {/key}
                </button>

                <div class="meta-row">
                    {#if mode !== 'link'}
                        {#snippet visibilityLabel(open: boolean)}
                            {#if open}
                                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>
                                Public
                            {:else}
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>
                                Link access
                            {/if}
                        {/snippet}
                        <!-- both labels, measured off-screen, so the chip can ease between their widths instead of snapping -->
                        <span class="chip-measure" aria-hidden="true">
                            <span class="chip-content" bind:offsetWidth={publicLabelWidth}>{@render visibilityLabel(true)}</span>
                            <span class="chip-content" bind:offsetWidth={linkLabelWidth}>{@render visibilityLabel(false)}</span>
                        </span>
                        <button
                            class="visibility-chip"
                            class:on={isPublic}
                            type="button"
                            aria-pressed={isPublic}
                            title={isPublic ? 'Listed in the public gallery' : 'Anyone with the link can open it, but it is not listed in the gallery'}
                            style={chipWidth ? `width: ${chipWidth}px` : undefined}
                            disabled={isUploading}
                            onclick={() => isPublic = !isPublic}
                        >
                            {#key isPublic}
                                <span class="chip-content" in:fly={{ y: 5, duration: ms(200), easing: cubicOut }}>
                                    {@render visibilityLabel(isPublic)}
                                </span>
                            {/key}
                        </button>
                    {:else}
                        <span></span>
                    {/if}
                    <span class="meta-limits">
                        {#if mode === 'files' && effectiveLimits}
                            {files.length} / {effectiveLimits.maxcount} files
                        {:else if mode === 'note'}
                            {isPublic ? 'Shown in the gallery' : 'Anyone with the link'}
                        {/if}
                    </span>
                </div>
                </div>
            {/if}
        </div>
    </div>
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
        position: relative;
        width: 25rem;
        box-sizing: border-box;
        padding: 1.1rem 1.25rem 1.1rem;
        border: 2px solid var(--color-accent);
        background: #221f20;
        transition: border-color 0.2s ease-out, box-shadow 0.2s ease-out;
    }

    /* the whole card is the drop target; it glows while something is dragged over it */
    .upload-field.dragging {
        border-color: var(--color-fb-white);
        box-shadow: 0 0 0 4px #c30f4555, 0 0 40px #c30f4533;
    }

    .panel-inner,
    .compose,
    .mode-body {
        display: grid;
        gap: 0.85rem;
    }

    .upload-field svg {
        display: block;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
    }

    .panel-head {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 1rem;
    }

    .mode-pills {
        position: relative;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        padding: 4px;
        border: 1px solid #3b3538;
        background: #171515;
    }

    .mode-pill-indicator {
        position: absolute;
        top: 4px;
        bottom: 4px;
        left: 4px;
        width: calc((100% - 8px) / 3);
        background: var(--color-accent);
        transform: translateX(calc(var(--mode-index, 0) * 100%));
        transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .mode-pill {
        position: relative;
        padding: 0.3rem 0.8rem;
        border: none;
        background: none;
        color: #8a8385;
        font: inherit;
        font-size: 0.8rem;
        cursor: pointer;
        transition: color 0.15s;
    }

    .mode-pill:hover:not(:disabled) {
        color: #f4f4f4;
    }

    .mode-pill.active {
        color: #fff;
    }

    .mode-pill:disabled {
        cursor: not-allowed;
    }

    /* title edited in place as the card's heading */
    .title-input,
    .desc-input {
        width: 100%;
        box-sizing: border-box;
        border: none;
        background: none;
        color: #f4f4f4;
        font: inherit;
        padding: 0;
    }

    /* dashed rule at rest; on focus it fades into a solid accent one */
    .title-input {
        margin-top: 0.15rem;
        padding-bottom: 0.3rem;
        border-bottom: 1px dashed #4b4246;
        box-shadow: inset 0 -2px 0 transparent;
        font-size: 1.35rem;
        font-weight: 700;
        transition: border-color 0.25s ease-out, box-shadow 0.25s ease-out;
    }

    .title-input:focus {
        border-bottom-color: transparent;
        box-shadow: inset 0 -2px 0 var(--color-accent);
    }

    .title-input::placeholder {
        color: #5c5558;
    }

    .desc-input {
        margin-top: -0.4rem;
        resize: none;
        field-sizing: content;
        min-height: 1.4em;
        max-height: 8rem;
        color: #c9c3c5;
        font-size: 0.85rem;
    }

    .desc-input::placeholder {
        color: #6a6468;
    }

    .desc-input:disabled {
        cursor: default;
    }

    /* ── tray ── */
    .tray {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.5rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .tile {
        position: relative;
        aspect-ratio: 1;
        overflow: hidden;
        border: 1px solid #3b3538;
        background: #191718;
    }

    .thumb {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .tile:hover .thumb {
        transform: scale(1.06);
    }

    .thumb.generic {
        display: grid;
        place-items: center;
        background: #262223;
    }

    .thumb.generic span,
    .kind-badge {
        padding: 0.15rem 0.35rem;
        background: #3b3420;
        color: #f5d27a;
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.04em;
    }

    .kind-badge {
        position: absolute;
        top: 0.35rem;
        left: 0.35rem;
        z-index: 3;
        padding: 0.1rem 0.3rem;
        background: #2b3a55;
        color: #9cc4ff;
        font-size: 0.6rem;
    }

    .tile-caption {
        position: absolute;
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 2;
        display: grid;
        padding: 1rem 0.4rem 0.3rem;
        background: linear-gradient(transparent, #000c);
        font-size: 0.68rem;
        line-height: 1.25;
    }

    .tile-caption .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tile-caption .size {
        color: #c9c3c5;
        opacity: 0;
        max-height: 0;
        transition: opacity 0.15s, max-height 0.15s;
    }

    .tile:hover .tile-caption .size {
        opacity: 1;
        max-height: 1rem;
    }

    .tile-overlay {
        position: absolute;
        inset: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0007;
        font-size: 0.85rem;
        font-weight: 700;
    }

    /* a non-media tile's overlay carries its own badge, stacked over the status, in place of the centred one */
    .tile:has(.tile-overlay) .thumb.generic span {
        visibility: hidden;
    }

    .tile-overlay {
        flex-direction: column;
        gap: 0.35rem;
    }

    .tile-overlay .ext {
        padding: 0.15rem 0.35rem;
        background: #3b3420;
        color: #f5d27a;
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.04em;
    }

    .tile-overlay.muted {
        background: #000a;
        color: #c9c3c5;
        font-weight: 500;
    }

    .tile-bar {
        position: absolute;
        bottom: 0;
        left: 0;
        z-index: 3;
        height: 3px;
        background: var(--color-fb-white);
        transition: width 0.4s ease-out;
    }

    .tile-done {
        position: absolute;
        top: 0.35rem;
        right: 0.35rem;
        z-index: 3;
        display: grid;
        place-items: center;
        width: 1.15rem;
        height: 1.15rem;
        border-radius: 50%;
        background: #5de899;
        color: #063;
    }

    .tile-done svg {
        width: 0.7rem;
        height: 0.7rem;
        stroke-width: 3.2;
    }

    .tile-remove {
        position: absolute;
        top: 0.3rem;
        right: 0.3rem;
        z-index: 4;
        display: grid;
        place-items: center;
        width: 1.5rem;
        height: 1.5rem;
        padding: 0;
        border: none;
        background: #000a;
        color: #f4f4f4;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s, background-color 0.15s;
    }

    .tile:hover .tile-remove,
    .tile-remove:focus-visible {
        opacity: 1;
    }

    .tile-remove:hover {
        background: var(--color-accent);
    }

    .tile-remove svg {
        width: 0.85rem;
        height: 0.85rem;
    }

    @media (hover: none) {
        .tile-remove {
            opacity: 1;
        }
    }

    .tile.reorderable {
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
        /* iOS: a long press on an image would open its save/share menu instead of picking the tile up */
        -webkit-touch-callout: none;
    }

    .tile.reorderable:focus-visible {
        outline: 2px solid var(--color-fb-white);
        outline-offset: 2px;
    }

    .tile.reordering {
        z-index: 20;
        cursor: grabbing;
        border-color: var(--color-fb-white-semi);
        box-shadow: 0 0.75rem 1.75rem rgba(0, 0, 0, 0.55);
        transition: box-shadow 0.18s ease-out;
    }

    /* the lifted tile shows what it is, not the hover zoom */
    .tile.reordering .thumb {
        transform: none;
    }

    .tile.reordering .tile-remove {
        opacity: 0;
    }

    .add-tile {
        border: 2px dashed #4b4246;
        background: none;
        transition: border-color 0.15s, background-color 0.15s;
    }

    .add-tile:hover,
    .upload-field.dragging .add-tile {
        border-color: #8a8385;
        background: #ffffff08;
    }

    .add-tile label {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.3rem;
        color: #8a8385;
        font-size: 0.75rem;
        text-align: center;
        cursor: pointer;
    }

    .add-tile svg {
        width: 1.3rem;
        height: 1.3rem;
    }

    /* no files yet: the add tile becomes the full-width drop zone */
    .tray.empty .add-tile {
        grid-column: 1 / -1;
        aspect-ratio: auto;
        height: 9.5rem;
        background: repeating-linear-gradient(135deg, #ffffff05 0 10px, transparent 10px 20px);
    }

    .tray.empty .add-tile:hover,
    .upload-field.dragging .tray.empty .add-tile {
        background: repeating-linear-gradient(135deg, #ffffff0a 0 10px, transparent 10px 20px);
    }

    /* the arrow bobs while something is dragged over the card */
    .upload-field.dragging .add-icon {
        animation: bob 0.9s ease-in-out infinite;
    }

    @keyframes bob {
        50% { transform: translateY(-4px); }
    }

    .tray.empty .add-tile svg {
        width: 1.9rem;
        height: 1.9rem;
        color: #a9a1a4;
        stroke-width: 1.8;
    }

    .tray.empty .add-tile strong {
        color: #f4f4f4;
        font-size: 0.95rem;
    }

    .tray.empty .add-tile u {
        text-decoration-color: #8a8385;
        text-underline-offset: 3px;
    }

    .tray.empty .add-tile small {
        color: #8a8385;
        font-size: 0.75rem;
    }

    .tray.empty .add-tile small.token-note,
    .token-note {
        color: #b7f0ce;
    }

    .file-input {
        opacity: 0;
        width: 0.1px;
        height: 0.1px;
        position: absolute;
    }

    /* ── upload button doubles as the progress bar ── */
    .upload-button {
        position: relative;
        overflow: hidden;
        width: 100%;
        min-height: 2.9rem;
        padding: 0;
        border: none;
        background: var(--color-accent);
        color: #fff;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        touch-action: manipulation;
        transition: color 0.2s ease-out, background-color 0.2s ease-out;
    }

    .upload-button:not(.busy):not([aria-disabled='true']):hover,
    .upload-button:not(.busy):focus-visible {
        color: #060606;
        background-color: var(--color-fb-white);
    }

    .upload-button.busy {
        background: #3a1623;
        cursor: progress;
    }

    .upload-button[aria-disabled='true']:not(.busy) {
        cursor: not-allowed;
        opacity: 0.55;
    }

    .upload-fill {
        position: absolute;
        inset: 0 auto 0 0;
        overflow: hidden;
        background: var(--color-accent);
        transition: width 0.4s ease-out;
    }

    /* a soft sheen runs along the filled part while bytes are moving */
    .upload-fill::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(100deg, transparent 20%, #ffffff2e 50%, transparent 80%) no-repeat;
        background-size: 12rem 100%;
        animation: sheen 1.4s linear infinite;
    }

    @keyframes sheen {
        from { background-position: -12rem 0; }
        to { background-position: calc(100% + 12rem) 0; }
    }

    /* hashing comes before the first progress event, so there is no width to show yet */
    .upload-fill.indeterminate {
        width: 35%;
        animation: indeterminate 1.1s cubic-bezier(0.45, 0, 0.55, 1) infinite alternate;
    }

    @keyframes indeterminate {
        from { left: 0; }
        to { left: 65%; }
    }

    .upload-label {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.75rem 0.9rem;
        white-space: nowrap;
    }

    .upload-label.centered {
        justify-content: center;
        gap: 0.35rem;
    }

    .upload-label small {
        font-weight: 500;
        opacity: 0.85;
    }

    .meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-top: -0.2rem;
        font-size: 0.75rem;
        color: #8a8385;
    }

    /* content-box, so the measured label width is the width; padding and border sit outside it */
    .visibility-chip {
        box-sizing: content-box;
        overflow: hidden;
        transition: width 0.25s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.15s, color 0.15s, background-color 0.15s;
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.25rem 0.55rem;
        border: 1px solid #4b4246;
        background: none;
        color: #c9c3c5;
        font: inherit;
        cursor: pointer;
    }

    .chip-content {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        white-space: nowrap;
    }

    .chip-measure {
        position: absolute;
        visibility: hidden;
        pointer-events: none;
    }

    .chip-measure .chip-content {
        position: absolute;
    }

    .visibility-chip svg,
    .chip-measure svg {
        width: 0.8rem;
        height: 0.8rem;
    }

    .visibility-chip:hover:not(:disabled) {
        border-color: var(--color-fb-white-semi);
        color: #fff;
    }

    .visibility-chip.on {
        border-color: #c30f45aa;
        background: #c30f4522;
        color: #ffd3df;
    }

    .visibility-chip:disabled {
        cursor: not-allowed;
        opacity: 0.6;
    }

    /* ── done ── */
    .stage {
        position: relative;
    }

    .stage-content {
        display: grid;
        gap: 0.85rem;
    }

    /* the finished tray stays put; the summary sits on a blurred, darkened veil over it */
    .done-overlay {
        position: absolute;
        inset: -0.4rem 0;
        z-index: 30;
        display: grid;
        align-content: center;
        justify-items: center;
        gap: 0.2rem;
        padding: 1rem;
        text-align: center;
        backdrop-filter: blur(10px) brightness(0.55);
        -webkit-backdrop-filter: blur(10px) brightness(0.55);
        background-color: rgb(20 18 19 / 0.45);
    }

    .done-check {
        display: grid;
        place-items: center;
        width: 2.8rem;
        height: 2.8rem;
        margin-bottom: 0.5rem;
        border-radius: 50%;
        background: #14301f;
        color: #5de899;
    }

    .done-check svg {
        width: 1.4rem;
        height: 1.4rem;
        stroke-width: 2.6;
    }

    /* circle pops, then the tick draws itself; the rest of the card follows in a short stagger */
    .done-check {
        animation: pop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }

    .done-check path {
        stroke-dasharray: 22;
        stroke-dashoffset: 22;
        animation: draw 0.35s 0.25s ease-out forwards;
    }

    .done-overlay > :nth-child(n + 2),
    .result > * {
        animation: rise 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
    }

    .done-overlay > :nth-child(2) { animation-delay: 0.1s; }
    .done-overlay > :nth-child(3) { animation-delay: 0.15s; }
    .result > :nth-child(1) { animation-delay: 0.2s; }
    .result > :nth-child(2) { animation-delay: 0.27s; }

    @keyframes pop {
        from { transform: scale(0.4); opacity: 0; }
    }

    @keyframes draw {
        to { stroke-dashoffset: 0; }
    }

    @keyframes rise {
        from { transform: translateY(6px); opacity: 0; }
    }

    .done-overlay h2 {
        margin: 0;
        font-size: 1.15rem;
        text-shadow: 0 1px 8px #0008;
    }

    .done-overlay p {
        margin: 0;
        color: #c9c3c5;
        font-size: 0.8rem;
    }

    /* the button and its replacement share one cell, so the swap crossfades in place */
    .action-slot {
        display: grid;
    }

    .action-slot > * {
        grid-area: 1 / 1;
    }

    .action-default,
    .result {
        display: grid;
        gap: 0.85rem;
        align-content: start;
    }

    .result {
        gap: 0.5rem;
    }

    .result-link {
        display: flex;
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #4b4246;
        background: #171515;
    }

    .result-link a {
        flex: 1;
        min-width: 0;
        padding: 0.65rem 0.75rem;
        overflow: hidden;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-decoration: none;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.85rem;
    }

    .result-link .host {
        color: #8a8385;
    }

    .result-link b {
        color: #ff6b93;
        font-weight: 600;
    }

    .result-link .copy {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0 0.85rem;
        font-size: 0.82rem;
    }

    .result-link .copy:hover {
        transform: none;
    }

    .result-link .copy svg {
        width: 0.85rem;
        height: 0.85rem;
    }

    .done-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.5rem;
    }

    .ghost-action {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        padding: 0.55rem;
        border: 1px solid #4b4246;
        background: none;
        color: #c9c3c5;
        font: inherit;
        font-size: 0.82rem;
        text-decoration: none;
        cursor: pointer;
        transition: border-color 0.15s, color 0.15s;
    }

    .ghost-action:hover {
        border-color: var(--color-fb-white);
        color: #fff;
    }

    .ghost-action svg {
        width: 0.85rem;
        height: 0.85rem;
    }

    /* ── note / link fields, token, messages ── */
    .form-field {
        display: grid;
        gap: 0.35rem;
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

    .form-field input:focus,
    .form-field textarea:focus {
        border-color: var(--color-accent);
    }

    .form-field .note-input {
        min-height: 12rem;
        max-height: 60vh;
        resize: vertical;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.85rem;
        line-height: 1.5;
    }

    .field-hint {
        color: #6a6468;
        font-size: 0.78rem;
    }

    .char-counter {
        display: block;
        text-align: right;
        font-size: 0.78rem;
        color: #6a6468;
    }

    .char-counter.near-limit {
        color: #f0b7ca;
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

    .error-message,
    .success-message,
    .error-list {
        margin: 0;
        font-size: 0.85rem;
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

    @media (prefers-reduced-motion: reduce) {
        .mode-pill-indicator,
        .upload-fill,
        .tile-bar,
        .thumb,
        .title-input,
        .visibility-chip {
            transition: none;
        }

        .upload-field.dragging .add-icon,
        .upload-fill::after,
        .done-check,
        .done-overlay > *,
        .result > * {
            animation: none;
        }

        .done-check path {
            animation: none;
            stroke-dashoffset: 0;
        }

        .upload-fill.indeterminate {
            animation: none;
            width: 100%;
            opacity: 0.5;
        }
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

    @media (max-width: 24rem) {
        .upload-label small {
            display: none;
        }
    }
</style>
