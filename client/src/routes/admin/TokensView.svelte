<script lang="ts">
    import { onMount } from 'svelte'
    import { spawnAlert } from '$lib/alerts'
    import { formatFileSize } from '$lib/upload/uploader'

    type TokenStatus = 'active' | 'revoked' | 'expired' | 'exhausted'

    type UploadToken = {
        id_token: string
        token: string
        label: string
        limits: { max_files: number | null; max_bytes: number | null }
        uses_max: number | null
        uses_count: number
        expires_at: string | null
        revoked: boolean
        when: string
        status: TokenStatus
    }

    type TokenUse = {
        id_token: string
        outcome: 'ok' | 'failed' | 'rejected'
        reason?: string
        id_upload_pub?: string
        files: number
        bytes: number
        issuer: { ip: string; ua: string; uuid: string }
        when: string
    }

    type TokenUsesResponse = {
        items: TokenUse[]
        page: number
        pageSize: number
        total: number
        totalPages: number
    }

    const GB = 1024 ** 3

    let { adminFetch }: { adminFetch: <T>(path: string, init?: RequestInit) => Promise<T> } = $props()

    let tokens = $state<UploadToken[]>([])
    let loading = $state(false)
    let errorMessage = $state('')
    let creating = $state(false)
    let busy = $state(new Set<string>())
    let uses = $state<Record<string, TokenUsesResponse>>({})

    let formLabel = $state('')
    let formToken = $state('')
    let formMaxFiles = $state<number | null>(null)
    let formMaxGb = $state<number | null>(null)
    let formUsesMax = $state<number | null>(null)
    let formExpires = $state('')

    onMount(() => {
        void tokensLoad()
    })

    function errorText(error: unknown, fallback: string) {
        return error instanceof Error ? error.message : fallback
    }

    // number inputs bind to null when empty, which is exactly "unlimited"
    function optionalInt(value: number | null) {
        return value === null ? null : Math.floor(value)
    }

    async function tokensLoad() {
        loading = true
        errorMessage = ''
        try {
            tokens = (await adminFetch<{ items: UploadToken[] }>('/api/v2/admin/tokens')).items
        } catch (error) {
            errorMessage = errorText(error, 'Could not load tokens')
        } finally {
            loading = false
        }
    }

    async function tokenCreate(event: SubmitEvent) {
        event.preventDefault()
        const body = {
            ...(formToken.trim() ? { token: formToken.trim() } : {}),
            label: formLabel,
            limits: {
                max_files: optionalInt(formMaxFiles),
                max_bytes: formMaxGb === null ? null : Math.round(formMaxGb * GB)
            },
            uses_max: optionalInt(formUsesMax),
            expires_at: formExpires ? new Date(formExpires).toISOString() : null
        }

        creating = true
        try {
            const token = await adminFetch<UploadToken>('/api/v2/admin/tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            tokens = [token, ...tokens]
            formLabel = formToken = formExpires = ''
            formMaxFiles = formMaxGb = formUsesMax = null
            await tokenCopy(token)
        } catch (error) {
            spawnAlert('error', `Token not created: ${errorText(error, 'request failed')}`)
        } finally {
            creating = false
        }
    }

    async function tokenMutate(token: UploadToken, work: () => Promise<void>) {
        busy = new Set(busy).add(token.id_token)
        try {
            await work()
        } catch (error) {
            spawnAlert('error', errorText(error, 'Request failed'))
        } finally {
            const next = new Set(busy)
            next.delete(token.id_token)
            busy = next
        }
    }

    function tokenRevokeToggle(token: UploadToken) {
        return tokenMutate(token, async () => {
            const updated = await adminFetch<UploadToken>(`/api/v2/admin/tokens/${encodeURIComponent(token.id_token)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ revoked: !token.revoked })
            })
            tokens = tokens.map((item) => item.id_token === updated.id_token ? updated : item)
        })
    }

    function tokenDelete(token: UploadToken) {
        if (!confirm(`Delete token ${token.label || token.id_token}? Its usage log is kept.`)) return
        return tokenMutate(token, async () => {
            await adminFetch(`/api/v2/admin/tokens/${encodeURIComponent(token.id_token)}`, { method: 'DELETE' })
            tokens = tokens.filter((item) => item.id_token !== token.id_token)
        })
    }

    async function tokenCopy(token: UploadToken) {
        try {
            await navigator.clipboard.writeText(token.token)
            spawnAlert('success', 'Token copied')
        } catch {
            spawnAlert('error', 'Could not copy token')
        }
    }

    async function tokenUsesLoad(token: UploadToken, page = 1) {
        try {
            const response = await adminFetch<TokenUsesResponse>(
                `/api/v2/admin/tokens/${encodeURIComponent(token.id_token)}/uses?page=${page}&limit=20`)
            uses = { ...uses, [token.id_token]: response }
        } catch (error) {
            spawnAlert('error', `Usage log not loaded: ${errorText(error, 'request failed')}`)
        }
    }

    function tokenUsesToggle(event: Event, token: UploadToken) {
        const details = event.currentTarget as HTMLDetailsElement
        if (details.open && !uses[token.id_token]) void tokenUsesLoad(token)
    }

    function limitsText(token: UploadToken) {
        const files = token.limits.max_files === null ? 'Unlimited files' : `${token.limits.max_files} files`
        const size = token.limits.max_bytes === null ? 'unlimited size' : formatFileSize(token.limits.max_bytes)
        return `${files} / ${size}`
    }

    function formatDate(value: string) {
        return new Date(value).toLocaleString()
    }
</script>

<form class="create" onsubmit={tokenCreate} aria-label="Create upload token">
    <label class="span-label">
        <span>Label</span>
        <input bind:value={formLabel} maxlength="100" placeholder="Who is it for" />
    </label>
    <label class="span-token">
        <span>Custom token (empty = random)</span>
        <input
            bind:value={formToken}
            minlength="8"
            maxlength="64"
            pattern={'[A-Za-z0-9_\\-]{8,64}'}
            title="8–64 characters: letters, digits, _ and -"
            placeholder="Random 32 characters"
            autocomplete="off"
            spellcheck="false"
            class="mono"
        />
    </label>
    <label>
        <span>Max files</span>
        <input bind:value={formMaxFiles} type="number" min="1" step="1" placeholder="Unlimited" />
    </label>
    <label>
        <span>Max size (GB)</span>
        <input bind:value={formMaxGb} type="number" min="0.001" step="any" placeholder="Unlimited" />
    </label>
    <label>
        <span>Max uses</span>
        <input bind:value={formUsesMax} type="number" min="1" step="1" placeholder="Unlimited" />
    </label>
    <label>
        <span>Expires</span>
        <input bind:value={formExpires} type="datetime-local" />
    </label>
    <button class="fb-button" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create'}</button>
</form>

{#if errorMessage}
    <p class="error" role="alert">{errorMessage}</p>
{/if}

{#if loading && tokens.length === 0}
    <p class="state" aria-live="polite">Loading tokens…</p>
{:else if tokens.length === 0}
    <p class="state">No upload tokens yet.</p>
{:else}
    <div class="token-list">
        {#each tokens as token (token.id_token)}
            <article class="token-row" class:inactive={token.status !== 'active'}>
                <header class="token-row-header">
                    <div class="title-line">
                        <span class="badge" class:muted={token.status === 'active'}>{token.status}</span>
                        <strong>{token.label || 'Unlabeled'}</strong>
                        <span class="muted-text">{token.id_token}</span>
                    </div>
                    <div class="actions">
                        <button class="quiet-button" type="button" onclick={() => tokenCopy(token)}>Copy</button>
                        <button class="quiet-button" type="button" disabled={busy.has(token.id_token)} onclick={() => tokenRevokeToggle(token)}>
                            {token.revoked ? 'Unrevoke' : 'Revoke'}
                        </button>
                        <button class="quiet-button danger" type="button" disabled={busy.has(token.id_token)} onclick={() => tokenDelete(token)}>Delete</button>
                    </div>
                </header>

                <code class="secret">{token.token}</code>

                <dl class="metadata">
                    <div><dt>Limits</dt><dd>{limitsText(token)}</dd></div>
                    <div><dt>Uses</dt><dd>{token.uses_count} / {token.uses_max ?? '∞'}</dd></div>
                    <div><dt>Expires</dt><dd>{token.expires_at ? formatDate(token.expires_at) : 'Never'}</dd></div>
                    <div><dt>Created</dt><dd>{formatDate(token.when)}</dd></div>
                </dl>

                <details ontoggle={(event) => tokenUsesToggle(event, token)}>
                    <summary>Usage log</summary>
                    {#if !uses[token.id_token]}
                        <p class="muted-text">Loading…</p>
                    {:else if uses[token.id_token]!.items.length === 0}
                        <p class="muted-text">Never used.</p>
                    {:else}
                        {@const log = uses[token.id_token]!}
                        <table>
                            <thead>
                                <tr><th>When</th><th>Outcome</th><th>Upload</th><th>Files</th><th>Size</th><th>IP</th><th>User agent</th></tr>
                            </thead>
                            <tbody>
                                {#each log.items as use, index (use.when + index)}
                                    <tr>
                                        <td>{formatDate(use.when)}</td>
                                        <td>
                                            <span class="badge" class:muted={use.outcome === 'ok'}>{use.outcome}</span>
                                            {#if use.reason}<span class="reason">{use.reason}</span>{/if}
                                        </td>
                                        <td>{#if use.id_upload_pub}<a href={`/${use.id_upload_pub}`} target="_blank" rel="noreferrer">{use.id_upload_pub}</a>{:else}—{/if}</td>
                                        <td>{use.files}</td>
                                        <td>{formatFileSize(use.bytes)}</td>
                                        <td>{use.issuer.ip}</td>
                                        <td class="ua">{use.issuer.ua}</td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                        {#if log.totalPages > 1}
                            <nav class="pagination" aria-label="Usage log pages">
                                <button class="quiet-button" type="button" disabled={log.page <= 1} onclick={() => tokenUsesLoad(token, log.page - 1)}>Previous</button>
                                <span>Page {log.page} of {log.totalPages}</span>
                                <button class="quiet-button" type="button" disabled={log.page >= log.totalPages} onclick={() => tokenUsesLoad(token, log.page + 1)}>Next</button>
                            </nav>
                        {/if}
                    {/if}
                </details>
            </article>
        {/each}
    </div>
{/if}

<style>
    /* Svelte scopes styles per component, so the admin page's element rules do not reach here. */
    input {
        min-height: 2.75rem;
        box-sizing: border-box;
        padding: 0.65rem 0.75rem;
        color: #f4f4f4;
        background: #171515;
        border: 1px solid #4a4447;
        font: inherit;
    }

    input:focus-visible,
    button:focus-visible,
    summary:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
    }

    /* two rows: label + token, then the four limits + Create */
    .create {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
        align-items: end;
        gap: 0.75rem;
        margin: 1.5rem 0;
    }

    .create input {
        width: 100%;
        min-width: 0;
    }

    .create .span-label {
        grid-column: span 2;
    }

    .create .span-token {
        grid-column: span 3;
    }

    .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .create label {
        display: grid;
        gap: 0.4rem;
    }

    .create label > span,
    .muted-text,
    dt {
        color: #8a8385;
        font-size: 0.82rem;
    }

    .quiet-button {
        min-height: 2.25rem;
        padding: 0.4rem 0.7rem;
        color: #f4f4f4;
        background: transparent;
        border: 1px solid #5b5357;
        font: inherit;
        font-size: 0.85rem;
        cursor: pointer;
    }

    .quiet-button.danger {
        color: #ffb3c7;
        border-color: #9e3152;
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

    .token-list {
        display: grid;
        gap: 0.75rem;
    }

    .token-row {
        padding: 1rem;
        background: #221f20;
        border: 1px solid #3b3538;
    }

    .token-row.inactive {
        opacity: 0.7;
    }

    .token-row-header,
    .pagination {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
    }

    .title-line,
    .actions {
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
        color: #b7f0ce;
        border-color: #3f6b52;
    }

    .secret {
        display: block;
        margin-top: 0.65rem;
        padding: 0.5rem 0.65rem;
        background: #191718;
        border: 1px solid #3b3538;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.82rem;
        overflow-wrap: anywhere;
        user-select: all;
    }

    .metadata {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.75rem;
        margin: 0.65rem 0 0;
    }

    dt {
        font-size: 0.72rem;
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

    table {
        width: 100%;
        margin-top: 0.5rem;
        border-collapse: collapse;
        font-size: 0.8rem;
    }

    th,
    td {
        padding: 0.35rem 0.5rem;
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid #3b3538;
    }

    th {
        color: #8a8385;
        font-weight: 400;
    }

    td.ua {
        max-width: 18rem;
        overflow-wrap: anywhere;
        color: #9e9699;
    }

    .reason {
        display: block;
        margin-top: 0.2rem;
        color: #9e9699;
        overflow-wrap: anywhere;
    }

    a {
        color: inherit;
    }

    .pagination {
        justify-content: center;
        margin-top: 0.75rem;
        font-size: 0.85rem;
    }

    @media (max-width: 60rem) {
        .create {
            grid-template-columns: 1fr 1fr;
        }

        .create .span-label,
        .create .span-token {
            grid-column: 1 / -1;
        }

        .metadata {
            grid-template-columns: 1fr 1fr;
        }

        details {
            overflow-x: auto;
        }
    }

    @media (max-width: 38rem) {
        .token-row-header {
            align-items: stretch;
            flex-direction: column;
            gap: 0.5rem;
        }

        .create {
            grid-template-columns: 1fr;
        }

        .create .span-label,
        .create .span-token {
            grid-column: auto;
        }
    }
</style>
