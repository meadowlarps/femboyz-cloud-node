<script lang="ts">
    import { onMount } from 'svelte'
    import { formatFileSize } from '$lib/upload/uploader'

    type LogEntry = {
        index: number
        time: string
        level: number
        levelLabel: string
        msg: string
        type?: string
        message?: string
        statusCode?: number
        stack?: string
        extra?: string
        raw?: string
    }

    type LogResponse = {
        items: LogEntry[]
        page: number
        pageSize: number
        matchedCount: number
        totalCount: number
        totalPages: number
        file: { sizeBytes: number; modifiedAt: string; truncated: boolean; windowBytes: number }
    }

    let { adminFetch }: { adminFetch: <T>(path: string, init?: RequestInit) => Promise<T> } = $props()

    let data = $state<LogResponse | null>(null)
    let loading = $state(false)
    let errorMessage = $state('')
    let searchInput = $state('')
    let search = $state('')
    let statusFilter = $state<'all' | '4xx' | '5xx' | 'none'>('all')
    let sort = $state<'newest' | 'oldest'>('newest')
    let pageSize = $state(20)
    let currentPage = $state(1)

    onMount(() => {
        void loadLogs()
    })

    // The parent's adminFetch already signs out on 401; recognise its error by shape rather than
    // reaching for the class it is declared with.
    function statusOf(error: unknown) {
        return error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : undefined
    }

    async function loadLogs() {
        loading = true
        errorMessage = ''
        const params = new URLSearchParams({
            page: String(currentPage),
            limit: String(pageSize),
            search,
            status: statusFilter,
            sort
        })

        try {
            data = await adminFetch<LogResponse>(`/api/v2/admin/logs?${params}`)
        } catch (error) {
            if (statusOf(error) === 401) return
            errorMessage = error instanceof Error ? error.message : 'Could not load error logs.'
        } finally {
            loading = false
        }
    }

    function submitSearch(event: SubmitEvent) {
        event.preventDefault()
        search = searchInput.trim()
        currentPage = 1
        void loadLogs()
    }

    function controlsChanged() {
        currentPage = 1
        void loadLogs()
    }

    function goToPage(page: number) {
        currentPage = page
        void loadLogs()
    }

    function formatDate(value: string) {
        return value ? new Date(value).toLocaleString() : 'unknown'
    }

    function headline(entry: LogEntry) {
        return entry.msg || entry.message || entry.raw || '(no message)'
    }
</script>

<section class="summary" aria-label="Error log overview">
    <div><strong>{data?.totalCount ?? 0}</strong><span>Entries read</span></div>
    <div><strong>{data?.matchedCount ?? 0}</strong><span>Matching</span></div>
    <div><strong>{formatFileSize(data?.file.sizeBytes ?? 0)}</strong><span>Log file</span></div>
    <div><strong>{data ? formatDate(data.file.modifiedAt) : '—'}</strong><span>Last written</span></div>
</section>

<form class="controls" onsubmit={submitSearch} aria-label="Error log filters">
    <label class="search-control">
        <span>Search message, type, or stack</span>
        <div>
            <input bind:value={searchInput} type="search" maxlength="200" placeholder="ECONNREFUSED, route, IP, error type" />
            <button class="fb-button" type="submit">Search</button>
        </div>
    </label>
    <label>
        <span>Status</span>
        <select bind:value={statusFilter} onchange={controlsChanged}>
            <option value="all">All statuses</option>
            <option value="4xx">4xx client</option>
            <option value="5xx">5xx server</option>
            <option value="none">No status</option>
        </select>
    </label>
    <label>
        <span>Sort</span>
        <select bind:value={sort} onchange={controlsChanged}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
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
    <button class="quiet-button" type="button" disabled={loading} onclick={() => void loadLogs()}>
        {loading ? 'Refreshing…' : 'Refresh'}
    </button>
</form>

{#if errorMessage}
    <p class="error" role="alert">{errorMessage}</p>
{/if}

{#if data?.file.truncated}
    <p class="notice">
        The log has no rotation — showing only the last {formatFileSize(data.file.windowBytes)}
        of a {formatFileSize(data.file.sizeBytes)} file.
    </p>
{/if}

{#if loading && !data}
    <p class="state" aria-live="polite">Loading error logs…</p>
{:else if data?.totalCount === 0}
    <p class="state">Nothing has been written to the error log yet.</p>
{:else if data?.items.length === 0}
    <p class="state">No log entries match these controls.</p>
{:else if data}
    <div class:updating={loading} class="log-list" aria-busy={loading}>
        {#each data.items as entry (entry.index)}
            <article class="log-row">
                <header class="log-row-header">
                    <div class="title-line">
                        <span class="badge muted">{entry.levelLabel}</span>
                        {#if entry.statusCode !== undefined}
                            <span class="badge" class:muted={entry.statusCode < 500}>{entry.statusCode}</span>
                        {/if}
                        {#if entry.type}<span class="badge muted">{entry.type}</span>{/if}
                    </div>
                    <span class="timestamp">{formatDate(entry.time)}</span>
                </header>

                <p class="headline">{headline(entry)}</p>

                {#if entry.message && entry.msg && !entry.msg.includes(entry.message)}
                    <p class="detail">{entry.message}</p>
                {/if}

                {#if entry.extra}
                    <dl class="metadata">
                        <div class="wide"><dt>Extra</dt><dd>{entry.extra}</dd></div>
                    </dl>
                {/if}

                {#if entry.stack}
                    <details>
                        <summary>Stack trace</summary>
                        <pre>{entry.stack}</pre>
                    </details>
                {/if}
            </article>
        {/each}
    </div>

    <nav class="pagination" aria-label="Error log pages">
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

<style>
    /* Svelte scopes styles per component, so the admin page's element rules do not reach here. */
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
    summary:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
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
        overflow-wrap: anywhere;
    }

    .summary span,
    .controls label > span,
    .timestamp {
        color: #8a8385;
        font-size: 0.82rem;
    }

    .controls {
        display: grid;
        grid-template-columns: minmax(18rem, 1fr) repeat(3, minmax(8rem, auto)) auto;
        align-items: end;
        gap: 0.75rem;
        margin-bottom: 1.5rem;
    }

    .controls label {
        display: grid;
        gap: 0.4rem;
    }

    .search-control > div {
        display: flex;
    }

    .search-control input {
        width: 100%;
    }

    .quiet-button {
        min-height: 2.5rem;
        padding: 0.55rem 0.8rem;
        color: #f4f4f4;
        background: transparent;
        border: 1px solid #5b5357;
        font: inherit;
        cursor: pointer;
    }

    button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    .error {
        color: #ffb3c7;
    }

    .notice {
        padding: 0.75rem;
        color: #9e9699;
        background: #191718;
        border: 1px solid #3b3538;
        font-size: 0.85rem;
    }

    .state {
        padding: 3rem 1rem;
        text-align: center;
        color: #9e9699;
    }

    .log-list {
        display: grid;
        gap: 0.75rem;
        transition: opacity 120ms ease;
    }

    .log-list.updating {
        opacity: 0.55;
    }

    .log-row {
        padding: 1rem;
        background: #221f20;
        border: 1px solid #3b3538;
    }

    .log-row-header,
    .pagination {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
    }

    .title-line {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.45rem;
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
        text-transform: none;
    }

    .timestamp {
        white-space: nowrap;
    }

    .headline,
    .detail {
        margin: 0.65rem 0 0;
        overflow-wrap: anywhere;
    }

    .detail {
        color: #9e9699;
        font-size: 0.85rem;
    }

    .metadata {
        display: grid;
        gap: 0.75rem;
        margin: 0.75rem 0 0;
        padding: 0.75rem;
        background: #191718;
    }

    .metadata .wide {
        min-width: 0;
    }

    dt {
        color: #8a8385;
        font-size: 0.75rem;
        text-transform: uppercase;
    }

    dd {
        margin: 0.2rem 0 0;
        overflow-wrap: anywhere;
        font-size: 0.85rem;
    }

    details {
        margin-top: 0.75rem;
    }

    summary {
        color: #9e9699;
        cursor: pointer;
        font-size: 0.82rem;
    }

    summary:hover {
        color: #c9c3c5;
    }

    pre {
        margin: 0.5rem 0 0;
        padding: 0.75rem;
        overflow-x: auto;
        background: #191718;
        border: 1px solid #3b3538;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.78rem;
        line-height: 1.5;
        white-space: pre;
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

        .summary {
            grid-template-columns: 1fr 1fr;
        }
    }

    @media (max-width: 38rem) {
        .log-row-header {
            align-items: stretch;
            flex-direction: column;
            gap: 0.5rem;
        }

        .summary,
        .controls {
            grid-template-columns: 1fr;
        }

        .search-control {
            grid-column: auto;
        }

        .search-control > div {
            align-items: stretch;
            flex-direction: column;
        }
    }
</style>
