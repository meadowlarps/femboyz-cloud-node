<script lang="ts">
    import { onMount } from 'svelte'
    import { spawnAlert } from '$lib/alerts'
    import { formatFileSize } from '$lib/upload/uploader'
    import './accountViews.css'

    type User = {
        id_user: string
        username: string
        email: string
        external_email: { address: string; verified_at: string } | null
        status: 'active' | 'disabled'
        created: string
        invite_id: string | null
        services: {
            mail: {
                enabled: boolean
                stalwart_id: string | null
                quota_bytes: number
                redirect: { enabled: boolean; keep_copy: boolean; bounces: number }
            }
        }
    }

    const GB = 1024 ** 3

    let { adminFetch }: { adminFetch: <T>(path: string, init?: RequestInit) => Promise<T> } = $props()

    let items = $state<User[]>([])
    let search = $state('')
    let loading = $state(false)
    let errorMessage = $state('')
    let busy = $state(new Set<string>())

    onMount(() => void load())

    async function load(event?: SubmitEvent) {
        event?.preventDefault()
        loading = true
        errorMessage = ''
        try {
            items = (await adminFetch<{ items: User[] }>(`/api/v2/admin/account/users?search=${encodeURIComponent(search.trim())}`)).items
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : 'Could not load users'
        } finally {
            loading = false
        }
    }

    async function mutate(user: User, work: () => Promise<void>) {
        busy = new Set(busy).add(user.id_user)
        try {
            await work()
        } catch (error) {
            spawnAlert('error', error instanceof Error ? error.message : 'Request failed')
        } finally {
            const next = new Set(busy)
            next.delete(user.id_user)
            busy = next
        }
    }

    function update(user: User, change: { status?: User['status']; quota_bytes?: number }) {
        return mutate(user, async () => {
            const updated = await adminFetch<User>(`/api/v2/admin/account/users/${encodeURIComponent(user.id_user)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(change)
            })
            items = items.map((item) => item.id_user === updated.id_user ? updated : item)
        })
    }

    function toggleStatus(user: User) {
        const disabling = user.status === 'active'
        if (disabling && !confirm(`Disable ${user.username}? They're signed out everywhere and can't log in to mail.`)) return
        return update(user, { status: disabling ? 'disabled' : 'active' })
    }

    function changeQuota(user: User) {
        const answer = prompt(`Mailbox quota for ${user.username} in GB`, String(user.services.mail.quota_bytes / GB))
        if (answer === null) return
        const gb = Number(answer)
        if (!Number.isFinite(gb) || gb <= 0) return spawnAlert('error', 'Enter a positive number')
        return update(user, { quota_bytes: Math.round(gb * GB) })
    }

    function remove(user: User) {
        const typed = prompt(`This disables ${user.email} now and deletes ALL its mail in about 11 minutes, for good. Type the username to confirm.`)
        if (typed !== user.username) return
        return mutate(user, async () => {
            await adminFetch(`/api/v2/admin/account/users/${encodeURIComponent(user.id_user)}`, { method: 'DELETE' })
            items = items.filter((item) => item.id_user !== user.id_user)
            spawnAlert('success', `Deletion scheduled for ${user.username}`)
        })
    }

    const formatDate = (value: string) => new Date(value).toLocaleString()

    function redirectText(user: User) {
        const redirect = user.services.mail.redirect
        if (!redirect.enabled) return redirect.bounces > 0 ? `Off (${redirect.bounces} bounces)` : 'Off'
        return `On${redirect.keep_copy ? ', keeps copy' : ', no copy'}${redirect.bounces ? ` · ${redirect.bounces} bounces` : ''}`
    }
</script>

<form class="av-toolbar" onsubmit={load} aria-label="Search users">
    <label>
        <span>Search username or external email</span>
        <input bind:value={search} type="search" maxlength="100" />
    </label>
    <button class="fb-button" type="submit">Search</button>
</form>

{#if errorMessage}<p class="av-error" role="alert">{errorMessage}</p>{/if}

{#if loading && items.length === 0}
    <p class="av-state" aria-live="polite">Loading users…</p>
{:else if items.length === 0}
    <p class="av-state">No users{search ? ' match' : ' yet'}.</p>
{:else}
    <div class="av-list">
        {#each items as user (user.id_user)}
            <article class="av-row" class:av-inactive={user.status !== 'active'}>
                <header class="av-row-header">
                    <div class="av-title">
                        <span class="av-badge" class:av-ok={user.status === 'active'}>{user.status}</span>
                        <strong>{user.email}</strong>
                    </div>
                    <div class="av-actions">
                        <button class="av-quiet" type="button" disabled={busy.has(user.id_user)} onclick={() => changeQuota(user)}>Quota</button>
                        <button class="av-quiet" type="button" disabled={busy.has(user.id_user)} onclick={() => toggleStatus(user)}>
                            {user.status === 'active' ? 'Disable' : 'Enable'}
                        </button>
                        <button class="av-quiet av-danger" type="button" disabled={busy.has(user.id_user)} onclick={() => remove(user)}>Delete</button>
                    </div>
                </header>
                <dl class="av-meta">
                    <div><dt>External email</dt><dd>{user.external_email?.address ?? '—'}</dd></div>
                    <div><dt>Forwarding</dt><dd>{redirectText(user)}</dd></div>
                    <div><dt>Quota</dt><dd>{formatFileSize(user.services.mail.quota_bytes)}</dd></div>
                    <div><dt>Joined</dt><dd>{formatDate(user.created)}</dd></div>
                </dl>
            </article>
        {/each}
    </div>
{/if}
