<script lang="ts">
    import { onMount, tick } from 'svelte'
    import { spawnAlert } from '$lib/alerts'
    import './accountViews.css'

    type AccountRequest = {
        id: string
        email: string
        note: string
        issuer: { ip: string; ua: string }
        created: string
        status: 'pending' | 'approved' | 'rejected'
        decided: string | null
        invite_id: string | null
    }

    type ApproveResponse = { request: AccountRequest; link: string; mailed: boolean }

    let {
        adminFetch,
        focusId = null
    }: { adminFetch: <T>(path: string, init?: RequestInit) => Promise<T>; focusId?: string | null } = $props()

    let status = $state<'pending' | 'all' | 'approved' | 'rejected'>('pending')
    let items = $state<AccountRequest[]>([])
    let loading = $state(false)
    let errorMessage = $state('')
    let busy = $state(new Set<string>())
    let links = $state<Record<string, string>>({})

    onMount(() => {
        // a link from the notification email may point at a request that's no longer pending
        if (focusId) status = 'all'
        void load()
    })

    async function load() {
        loading = true
        errorMessage = ''
        try {
            items = (await adminFetch<{ items: AccountRequest[] }>(`/api/v2/admin/account/requests?status=${status}`)).items
            if (focusId) {
                await tick()
                document.getElementById(`request-${focusId}`)?.scrollIntoView({ block: 'center' })
            }
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : 'Could not load requests'
        } finally {
            loading = false
        }
    }

    async function decide(request: AccountRequest, decision: 'approve' | 'reject') {
        if (decision === 'reject' && !confirm(`Reject the request from ${request.email}? They won't be told.`)) return
        busy = new Set(busy).add(request.id)
        try {
            if (decision === 'approve') {
                const result = await adminFetch<ApproveResponse>(`/api/v2/admin/account/requests/${encodeURIComponent(request.id)}/approve`, { method: 'POST' })
                items = items.map((item) => item.id === request.id ? result.request : item)
                links = { ...links, [request.id]: result.link }
                spawnAlert(result.mailed ? 'success' : 'warning',
                    result.mailed ? `Invite sent to ${request.email}` : `Approved, but the invite email failed. Send the link yourself.`)
            } else {
                const result = await adminFetch<AccountRequest>(`/api/v2/admin/account/requests/${encodeURIComponent(request.id)}/reject`, { method: 'POST' })
                items = items.map((item) => item.id === request.id ? result : item)
                spawnAlert('info', `Rejected ${request.email}`)
            }
        } catch (error) {
            spawnAlert('error', error instanceof Error ? error.message : 'Request failed')
        } finally {
            const next = new Set(busy)
            next.delete(request.id)
            busy = next
        }
    }

    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text)
            spawnAlert('success', 'Invite link copied')
        } catch {
            spawnAlert('error', 'Could not copy')
        }
    }

    const formatDate = (value: string) => new Date(value).toLocaleString()
</script>

<div class="av-toolbar">
    <label>
        <span>Show</span>
        <select bind:value={status} onchange={load}>
            <option value="pending">Pending</option>
            <option value="all">All</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
        </select>
    </label>
</div>

{#if errorMessage}<p class="av-error" role="alert">{errorMessage}</p>{/if}

{#if loading && items.length === 0}
    <p class="av-state" aria-live="polite">Loading requests…</p>
{:else if items.length === 0}
    <p class="av-state">{status === 'pending' ? 'No pending requests.' : 'No requests.'}</p>
{:else}
    <div class="av-list">
        {#each items as request (request.id)}
            <article id={`request-${request.id}`} class="av-row" class:av-highlight={request.id === focusId} class:av-inactive={request.status === 'rejected'}>
                <header class="av-row-header">
                    <div class="av-title">
                        <span class="av-badge" class:av-ok={request.status === 'approved'} class:av-dim={request.status === 'rejected'}>{request.status}</span>
                        <strong>{request.email}</strong>
                    </div>
                    {#if request.status === 'pending'}
                        <div class="av-actions">
                            <button class="fb-button" type="button" disabled={busy.has(request.id)} onclick={() => decide(request, 'approve')}>Approve</button>
                            <button class="av-quiet av-danger" type="button" disabled={busy.has(request.id)} onclick={() => decide(request, 'reject')}>Reject</button>
                        </div>
                    {/if}
                </header>
                <p class="av-note">{request.note || '(no note)'}</p>
                {#if links[request.id]}
                    <code class="av-secret">{links[request.id]}</code>
                    <div class="av-actions" style="margin-top: 0.5rem">
                        <button class="av-quiet" type="button" onclick={() => copy(links[request.id]!)}>Copy invite link</button>
                    </div>
                {/if}
                <dl class="av-meta">
                    <div><dt>Requested</dt><dd>{formatDate(request.created)}</dd></div>
                    <div><dt>Decided</dt><dd>{request.decided ? formatDate(request.decided) : '—'}</dd></div>
                    <div><dt>IP</dt><dd>{request.issuer.ip}</dd></div>
                    <div><dt>User agent</dt><dd>{request.issuer.ua}</dd></div>
                </dl>
            </article>
        {/each}
    </div>
{/if}
