<script lang="ts">
    import { onMount } from 'svelte'
    import { spawnAlert } from '$lib/alerts'
    import { formatFileSize } from '$lib/upload/uploader'
    import './accountViews.css'

    type Invite = {
        id: string
        label: string
        email: string | null
        request_id: string | null
        quota_bytes: number
        created: string
        expires: string
        used: boolean
        used_by: string | null
        used_at: string | null
        revoked: boolean
        status: 'active' | 'used' | 'expired' | 'revoked'
    }

    const GB = 1024 ** 3

    let { adminFetch }: { adminFetch: <T>(path: string, init?: RequestInit) => Promise<T> } = $props()

    let items = $state<Invite[]>([])
    let loading = $state(false)
    let errorMessage = $state('')
    let creating = $state(false)
    let busy = $state(new Set<string>())
    // the code exists only in the create response, so links are shown for this page view only
    let links = $state<Record<string, string>>({})

    let formLabel = $state('')
    let formEmail = $state('')
    let formQuotaGb = $state<number | null>(null)
    let formDays = $state<number | null>(null)

    onMount(() => void load())

    async function load() {
        loading = true
        errorMessage = ''
        try {
            items = (await adminFetch<{ items: Invite[] }>('/api/v2/admin/account/invites')).items
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : 'Could not load invites'
        } finally {
            loading = false
        }
    }

    async function create(event: SubmitEvent) {
        event.preventDefault()
        creating = true
        try {
            const result = await adminFetch<{ invite: Invite; link: string }>('/api/v2/admin/account/invites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: formLabel,
                    email: formEmail.trim() || null,
                    ...(formQuotaGb ? { quota_bytes: Math.round(formQuotaGb * GB) } : {}),
                    ...(formDays ? { ttl_days: Math.floor(formDays) } : {})
                })
            })
            items = [result.invite, ...items]
            links = { ...links, [result.invite.id]: result.link }
            formLabel = formEmail = ''
            formQuotaGb = formDays = null
            await copy(result.link)
        } catch (error) {
            spawnAlert('error', `Invite not created: ${error instanceof Error ? error.message : 'request failed'}`)
        } finally {
            creating = false
        }
    }

    async function revoke(invite: Invite) {
        if (!confirm(`Revoke invite ${invite.label || invite.id}? The link stops working.`)) return
        busy = new Set(busy).add(invite.id)
        try {
            await adminFetch(`/api/v2/admin/account/invites/${encodeURIComponent(invite.id)}`, { method: 'DELETE' })
            items = items.map((item) => item.id === invite.id ? { ...item, revoked: true, status: 'revoked' } : item)
        } catch (error) {
            spawnAlert('error', error instanceof Error ? error.message : 'Request failed')
        } finally {
            const next = new Set(busy)
            next.delete(invite.id)
            busy = next
        }
    }

    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text)
            spawnAlert('success', 'Invite link copied')
        } catch {
            spawnAlert('warning', 'Copy the invite link below')
        }
    }

    const formatDate = (value: string) => new Date(value).toLocaleString()
</script>

<form class="av-toolbar" onsubmit={create} aria-label="Create invite">
    <label>
        <span>Label</span>
        <input bind:value={formLabel} maxlength="100" placeholder="Who is it for" />
    </label>
    <label>
        <span>Their email (optional, pre-verified)</span>
        <input bind:value={formEmail} type="email" maxlength="254" placeholder="Only shown on the signup page" />
    </label>
    <label>
        <span>Quota (GB)</span>
        <input bind:value={formQuotaGb} type="number" min="0.1" step="any" placeholder="1" style="width: 7rem" />
    </label>
    <label>
        <span>Valid (days)</span>
        <input bind:value={formDays} type="number" min="1" max="90" step="1" placeholder="7" style="width: 7rem" />
    </label>
    <button class="fb-button" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create invite'}</button>
</form>
<p class="av-muted">Invites made here aren't emailed: copy the link and send it yourself. Only the person who receives a link can use it, once.</p>

{#if errorMessage}<p class="av-error" role="alert">{errorMessage}</p>{/if}

{#if loading && items.length === 0}
    <p class="av-state" aria-live="polite">Loading invites…</p>
{:else if items.length === 0}
    <p class="av-state">No invites yet.</p>
{:else}
    <div class="av-list" style="margin-top: 1rem">
        {#each items as invite (invite.id)}
            <article class="av-row" class:av-inactive={invite.status !== 'active'}>
                <header class="av-row-header">
                    <div class="av-title">
                        <span class="av-badge" class:av-ok={invite.status === 'active'} class:av-dim={invite.status !== 'active'}>{invite.status}</span>
                        <strong>{invite.label || 'Unlabeled'}</strong>
                        <span class="av-muted">{invite.id}</span>
                    </div>
                    {#if invite.status === 'active'}
                        <div class="av-actions">
                            <button class="av-quiet av-danger" type="button" disabled={busy.has(invite.id)} onclick={() => revoke(invite)}>Revoke</button>
                        </div>
                    {/if}
                </header>
                {#if links[invite.id]}
                    <code class="av-secret">{links[invite.id]}</code>
                    <div class="av-actions" style="margin-top: 0.5rem">
                        <button class="av-quiet" type="button" onclick={() => copy(links[invite.id]!)}>Copy link</button>
                    </div>
                {/if}
                <dl class="av-meta">
                    <div><dt>Email</dt><dd>{invite.email ?? '—'}</dd></div>
                    <div><dt>Quota</dt><dd>{formatFileSize(invite.quota_bytes)}</dd></div>
                    <div><dt>Expires</dt><dd>{formatDate(invite.expires)}</dd></div>
                    <div><dt>{invite.used ? 'Used' : 'Created'}</dt><dd>{formatDate(invite.used_at ?? invite.created)}</dd></div>
                </dl>
            </article>
        {/each}
    </div>
{/if}
