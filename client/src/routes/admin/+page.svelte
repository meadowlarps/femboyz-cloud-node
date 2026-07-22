<script lang="ts">
    import { onMount } from 'svelte'
    import { spawnAlert } from '$lib/alerts'
    import { formatFileSize } from '$lib/upload/uploader'

    type AdminFile = {
        index: number
        filename: string
        size: number
        mime: string
        url: string
        stat_dl: number
    }

    type AdminUpload = {
        id: string
        type: 'files' | 'album' | 'playlist' | 'link'
        public: boolean
        status: 'processing' | 'ready' | 'error' | 'removed'
        meta: { title: string; desc: string }
        issuer: { ip: string; ua: string; uuid: string }
        when: string
        stats: { views: number; up: number; down: number }
        fileCount: number
        totalSize: number
        files: AdminFile[]
        link?: string
    }

    type AdminResponse = {
        items: AdminUpload[]
        page: number
        pageSize: number
        matchedCount: number
        totalCount: number
        totalPages: number
        storage: { usedBytes: number; limitBytes: number; freeBytes: number }
    }

    type DeleteResponse = {
        deleted: true
        id: string
        reclaimedBytes: number
        sharedFilesKept: number
        cleanupFailures: number
    }

    class AdminRequestError extends Error {
        status: number

        constructor(status: number, message: string) {
            super(message)
            this.status = status
        }
    }

    const apiEndpoint = (import.meta.env.VITE_API_ENDPOINT ?? '').replace(/\/$/, '')
    const sessionKeyName = 'femboyz-admin-key'

    let adminKey = $state('')
    let authenticated = $state(false)
    let data = $state<AdminResponse | null>(null)
    let loading = $state(false)
    let errorMessage = $state('')
    let searchInput = $state('')
    let search = $state('')
    let typeFilter = $state<'all' | AdminUpload['type']>('all')
    let sort = $state<'newest' | 'oldest' | 'largest' | 'smallest'>('newest')
    let pageSize = $state(20)
    let currentPage = $state(1)
    let deleting = $state(new Set<string>())

    onMount(() => {
        adminKey = sessionStorage.getItem(sessionKeyName) ?? ''
        if (adminKey) {
            authenticated = true
            void loadUploads()
        }
    })

    function signOut(message = '') {
        sessionStorage.removeItem(sessionKeyName)
        adminKey = ''
        authenticated = false
        data = null
        errorMessage = message
    }

    async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
        const response = await fetch(`${apiEndpoint}${path}`, {
            ...init,
            headers: { ...init.headers, Authorization: `Bearer ${adminKey}` }
        })
        const body = await response.json().catch(() => ({})) as { error?: string }

        if (response.status === 401) {
            signOut('The admin key was rejected.')
            throw new AdminRequestError(401, 'Unauthorized')
        }
        if (!response.ok) {
            const message = response.status === 503
                ? 'AUTH_ADMIN_KEY is not configured on the API server.'
                : body.error ?? `Request failed (${response.status})`
            throw new AdminRequestError(response.status, message)
        }
        return body as T
    }

    async function signIn(event: SubmitEvent) {
        event.preventDefault()
        if (!adminKey) return
        sessionStorage.setItem(sessionKeyName, adminKey)
        authenticated = true
        currentPage = 1
        await loadUploads()
    }

    async function loadUploads() {
        loading = true
        errorMessage = ''
        const params = new URLSearchParams({
            page: String(currentPage),
            limit: String(pageSize),
            search,
            type: typeFilter,
            sort
        })

        try {
            data = await adminFetch<AdminResponse>(`/api/v2/admin/uploads?${params}`)
        } catch (error) {
            if (error instanceof AdminRequestError && error.status === 401) return
            errorMessage = error instanceof Error ? error.message : 'Could not load uploads.'
        } finally {
            loading = false
        }
    }

    function submitSearch(event: SubmitEvent) {
        event.preventDefault()
        search = searchInput.trim()
        currentPage = 1
        void loadUploads()
    }

    function controlsChanged() {
        currentPage = 1
        void loadUploads()
    }

    function goToPage(page: number) {
        currentPage = page
        void loadUploads()
    }

    async function deleteUpload(upload: AdminUpload) {
        if (!confirm(`Permanently delete upload ${upload.id}? This cannot be undone.`)) return
        deleting = new Set(deleting).add(upload.id)

        try {
            const result = await adminFetch<DeleteResponse>(`/api/v2/admin/uploads/${encodeURIComponent(upload.id)}`, {
                method: 'DELETE'
            })
            if (result.cleanupFailures > 0)
                spawnAlert('warning', `Deleted ${upload.id}, but ${result.cleanupFailures} blob cleanup task(s) failed.`)
            else
                spawnAlert('success', `Deleted ${upload.id}; reclaimed ${formatFileSize(result.reclaimedBytes)}.`)

            if (data?.items.length === 1 && currentPage > 1) currentPage--
            await loadUploads()
        } catch (error) {
            if (error instanceof AdminRequestError && error.status === 401) return
            if (error instanceof AdminRequestError && error.status === 404) {
                spawnAlert('info', `${upload.id} was already deleted.`)
                await loadUploads()
            } else {
                spawnAlert('error', error instanceof Error ? error.message : 'Deletion failed.')
            }
        } finally {
            const next = new Set(deleting)
            next.delete(upload.id)
            deleting = next
        }
    }

    function formatDate(value: string) {
        return new Date(value).toLocaleString()
    }

    function fileDownloads(upload: AdminUpload) {
        return upload.files.reduce((sum, file) => sum + file.stat_dl, 0)
    }
</script>

<svelte:head>
    <title>Admin · femboyz.cloud</title>
    <meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if !authenticated}
    <section class="login-panel" aria-labelledby="admin-login-title">
        <h1 id="admin-login-title">Admin</h1>
        <form onsubmit={signIn}>
            <label>
                <span>Key</span>
                <input bind:value={adminKey} type="password" autocomplete="current-password" required />
            </label>
            <button class="fb-button" type="submit">Sign in</button>
        </form>
        {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
    </section>
{:else}
    <section class="admin-page">
        <header class="admin-header">
            <div>
                <h1>Upload administration</h1>
                <p>Private upload inventory and storage controls.</p>
            </div>
            <button class="quiet-button" type="button" onclick={() => signOut()}>Log out</button>
        </header>

        {#if data}
            <section class="summary" aria-label="Storage overview">
                <div><strong>{data.totalCount}</strong><span>Total uploads</span></div>
                <div><strong>{data.matchedCount}</strong><span>Matching</span></div>
                <div><strong>{formatFileSize(data.storage.usedBytes)}</strong><span>Used</span></div>
                <div><strong>{formatFileSize(data.storage.freeBytes)}</strong><span>Free of {formatFileSize(data.storage.limitBytes)}</span></div>
            </section>
        {/if}

        <form class="controls" onsubmit={submitSearch} aria-label="Upload filters">
            <label class="search-control">
                <span>Search issuer, ID, or title</span>
                <div>
                    <input bind:value={searchInput} type="search" maxlength="200" placeholder="IP, UUID, user agent, ID, title" />
                    <button class="fb-button" type="submit">Search</button>
                </div>
            </label>
            <label>
                <span>Type</span>
                <select bind:value={typeFilter} onchange={controlsChanged}>
                    <option value="all">All types</option>
                    <option value="files">Files</option>
                    <option value="album">Albums</option>
                    <option value="playlist">Playlists</option>
                    <option value="link">Links</option>
                </select>
            </label>
            <label>
                <span>Sort</span>
                <select bind:value={sort} onchange={controlsChanged}>
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                    <option value="largest">Largest</option>
                    <option value="smallest">Smallest</option>
                </select>
            </label>
            <label>
                <span>Per page</span>
                <select bind:value={pageSize} onchange={controlsChanged}>
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                </select>
            </label>
        </form>

        {#if errorMessage}
            <p class="error" role="alert">{errorMessage}</p>
        {/if}

        {#if loading && !data}
            <p class="state" aria-live="polite">Loading uploads…</p>
        {:else if data?.items.length === 0}
            <p class="state">No uploads match these controls.</p>
        {:else if data}
            <div class:updating={loading} class="upload-list" aria-busy={loading}>
                {#each data.items as upload (upload.id)}
                    <article class="upload-row">
                        <header class="upload-row-header">
                            <div>
                                <div class="title-line">
                                    <a href={`/${upload.id}`} target="_blank" rel="noopener noreferrer">
                                        {upload.meta.title || upload.id}
                                    </a>
                                    <span class="badge">{upload.type}</span>
                                    <span class="badge muted">{upload.status}</span>
                                    <span class="badge muted">{upload.public ? 'public' : 'private'}</span>
                                </div>
                                <p class="upload-id">{upload.id} · {formatDate(upload.when)}</p>
                                {#if upload.meta.desc}<p class="description">{upload.meta.desc}</p>{/if}
                            </div>
                            <button
                                class="delete-button"
                                type="button"
                                disabled={deleting.has(upload.id)}
                                onclick={() => deleteUpload(upload)}
                            >
                                {deleting.has(upload.id) ? 'Deleting…' : 'Delete permanently'}
                            </button>
                        </header>

                        <dl class="metadata">
                            <div><dt>Size</dt><dd>{formatFileSize(upload.totalSize)} · {upload.fileCount} file(s)</dd></div>
                            <div><dt>Activity</dt><dd>{upload.stats.views} views · {fileDownloads(upload)} file downloads</dd></div>
                            <div><dt>IP</dt><dd>{upload.issuer.ip}</dd></div>
                            <div><dt>UUID</dt><dd>{upload.issuer.uuid}</dd></div>
                            <div class="wide"><dt>User agent</dt><dd>{upload.issuer.ua}</dd></div>
                        </dl>

                        {#if upload.type === 'link' && upload.link}
                            <a class="external-link" href={upload.link} target="_blank" rel="noopener noreferrer">{upload.link}</a>
                        {:else if upload.files.length > 0}
                            <div class="file-grid">
                                {#each upload.files as file (file.index)}
                                    <section class="file-card">
                                        <div class="preview">
                                            {#if file.mime.startsWith('image/')}
                                                <img src={file.url} alt={file.filename} loading="lazy" />
                                            {:else if file.mime.startsWith('video/')}
                                                <!-- User uploads do not include caption resources. -->
                                                <!-- svelte-ignore a11y_media_has_caption -->
                                                <video src={file.url} controls playsinline preload="metadata"></video>
                                            {:else if file.mime.startsWith('audio/')}
                                                <audio src={file.url} controls preload="none"></audio>
                                            {:else}
                                                <a href={file.url} target="_blank" rel="noopener noreferrer">Open file</a>
                                            {/if}
                                        </div>
                                        <div class="file-details">
                                            <strong>{file.filename}</strong>
                                            <span>{file.mime} · {formatFileSize(file.size)} · {file.stat_dl} downloads</span>
                                        </div>
                                    </section>
                                {/each}
                            </div>
                        {/if}
                    </article>
                {/each}
            </div>

            <nav class="pagination" aria-label="Upload pages">
                <button
                    class="quiet-button"
                    type="button"
                    disabled={currentPage <= 1 || loading}
                    onclick={() => goToPage(currentPage - 1)}
                >Previous</button>
                <span>Page {data.page} of {Math.max(1, data.totalPages)}</span>
                <button
                    class="quiet-button"
                    type="button"
                    disabled={currentPage >= data.totalPages || loading}
                    onclick={() => goToPage(currentPage + 1)}
                >Next</button>
            </nav>
        {/if}
    </section>
{/if}

<style>
    .login-panel,
    .admin-page {
        width: min(100%, 82rem);
        margin: 0 auto;
    }

    .login-panel {
        width: min(100%, 28rem);
        padding: 1.5rem;
        box-sizing: border-box;
        background: #221f20;
        border: 1px solid #3b3538;
    }

    .login-panel h1,
    .admin-header h1 {
        margin: 0;
    }

    .login-panel form,
    .login-panel label,
    .controls label {
        display: grid;
        gap: 0.4rem;
    }

    .login-panel form {
        gap: 1rem;
    }

    input,
    select {
        min-height: 2.75rem;
        box-sizing: border-box;
        padding: 0.65rem 0.75rem;
        color: #f4f4f4;
        background: #171515;
        border: 1px solid #4a4447;
        font: inherit;
    }

    input:focus-visible,
    select:focus-visible,
    button:focus-visible,
    a:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }

    .admin-header,
    .upload-row-header,
    .pagination {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
    }

    .admin-header p {
        margin: 0.35rem 0 0;
        color: #9e9699;
    }

    .summary {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 1px;
        margin: 1.5rem 0;
        background: #3b3538;
        border: 1px solid #3b3538;
    }

    .summary div {
        display: grid;
        gap: 0.25rem;
        padding: 1rem;
        background: #221f20;
    }

    .summary strong {
        font-size: 1.25rem;
    }

    .summary span,
    .controls label > span,
    .upload-id,
    .file-details span {
        color: #8a8385;
        font-size: 0.82rem;
    }

    .controls {
        display: grid;
        grid-template-columns: minmax(18rem, 1fr) repeat(3, minmax(8rem, auto));
        align-items: end;
        gap: 0.75rem;
        margin-bottom: 1.5rem;
    }

    .search-control > div {
        display: flex;
    }

    .search-control input {
        width: 100%;
    }

    .quiet-button,
    .delete-button {
        min-height: 2.5rem;
        padding: 0.55rem 0.8rem;
        color: #f4f4f4;
        background: transparent;
        border: 1px solid #5b5357;
        font: inherit;
        cursor: pointer;
    }

    .delete-button {
        color: #ffb3c7;
        border-color: #9e3152;
        white-space: nowrap;
    }

    button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    .error {
        color: #ffb3c7;
    }

    .state {
        padding: 3rem 1rem;
        text-align: center;
        color: #9e9699;
    }

    .upload-list {
        display: grid;
        gap: 1rem;
        transition: opacity 120ms ease;
    }

    .upload-list.updating {
        opacity: 0.55;
    }

    .upload-row {
        padding: 1rem;
        background: #221f20;
        border: 1px solid #3b3538;
    }

    .title-line {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.45rem;
    }

    .title-line > a {
        font-size: 1.15rem;
        font-weight: 700;
    }

    .badge {
        padding: 0.15rem 0.4rem;
        color: #ffb3c7;
        border: 1px solid #9e3152;
        font-size: 0.7rem;
        text-transform: uppercase;
    }

    .badge.muted {
        color: #aaa2a5;
        border-color: #5b5357;
    }

    .upload-id,
    .description {
        margin: 0.4rem 0 0;
        overflow-wrap: anywhere;
    }

    .metadata {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.75rem;
        margin: 1rem 0;
        padding: 0.75rem;
        background: #191718;
    }

    .metadata div {
        min-width: 0;
    }

    .metadata .wide {
        grid-column: 1 / -1;
    }

    dt {
        color: #8a8385;
        font-size: 0.75rem;
        text-transform: uppercase;
    }

    dd {
        margin: 0.2rem 0 0;
        overflow-wrap: anywhere;
    }

    .external-link {
        display: block;
        padding: 0.75rem;
        overflow-wrap: anywhere;
        background: #191718;
    }

    .file-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
        gap: 0.75rem;
    }

    .file-card {
        min-width: 0;
        overflow: hidden;
        background: #191718;
        border: 1px solid #3b3538;
    }

    .preview {
        display: grid;
        place-items: center;
        min-height: 7rem;
        max-height: 18rem;
        overflow: hidden;
        background: #0d0c0c;
    }

    .preview img,
    .preview video {
        display: block;
        width: 100%;
        max-height: 18rem;
        object-fit: contain;
    }

    .preview audio {
        width: calc(100% - 1rem);
    }

    .file-details {
        display: grid;
        gap: 0.25rem;
        padding: 0.65rem;
    }

    .file-details strong,
    .file-details span {
        overflow-wrap: anywhere;
    }

    .pagination {
        justify-content: center;
        margin-top: 1.5rem;
    }

    @media (max-width: 60rem) {
        .controls {
            grid-template-columns: 1fr 1fr;
        }

        .search-control {
            grid-column: 1 / -1;
        }

        .summary,
        .metadata {
            grid-template-columns: 1fr 1fr;
        }
    }

    @media (max-width: 38rem) {
        .admin-header,
        .upload-row-header {
            align-items: stretch;
            flex-direction: column;
        }

        .summary,
        .controls,
        .metadata {
            grid-template-columns: 1fr;
        }

        .metadata .wide,
        .search-control {
            grid-column: auto;
        }

        .search-control > div {
            align-items: stretch;
            flex-direction: column;
        }
    }
</style>
