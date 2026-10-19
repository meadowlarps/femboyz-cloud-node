<script lang="ts">
    import { onMount, tick } from 'svelte'
    import { page } from '$app/state'
    import { env } from '$env/dynamic/public'
    import { slide } from 'svelte/transition'
    import { cubicOut } from 'svelte/easing'
    import '$lib/styles/account.css'
    import CodeInput from '$lib/account/CodeInput.svelte'
    import { formatFileSize } from '$lib/upload/uploader'
    import { accountErrorText, accountFetch, AccountApiError, sessionStartUrl } from '$lib/account/api'

    type Me = {
        username: string
        email: string
        created: string
        external_email: { address: string; verified_at: string } | null
        redirect: { enabled: boolean; keep_copy: boolean }
        quota: { used_bytes: number | null; limit_bytes: number }
    }

    // ?embed=1: inside webmail settings. The layout drops the site chrome for it.
    const embed = page.url.searchParams.get('embed') === '1'
    const here = embed ? '/account?embed=1' : '/account'
    const reveal = { duration: 220, easing: cubicOut }
    const mailUrl = env.PUBLIC_MAIL_URL || 'https://mail.femboyz.cloud'

    let me = $state<Me | null>(null)
    let loadError = $state('')

    let editing = $state(false)
    let address = $state('')
    let codeSentTo = $state('')
    let code = $state('')
    let cooldown = $state(0)
    let cooldownTimer: ReturnType<typeof setInterval> | undefined
    let emailBusy = $state(false)
    let emailError = $state('')
    let emailNotice = $state('')
    let codeInput = $state<ReturnType<typeof CodeInput>>()

    let removing = $state(false)
    let removePassword = $state('')

    let redirectBusy = $state(false)
    let redirectError = $state('')
    let signingOut = $state(false)

    const quotaPercent = $derived(
        me && me.quota.used_bytes !== null ? Math.min(100, Math.round((me.quota.used_bytes / me.quota.limit_bytes) * 100)) : null)

    onMount(() => {
        void load()
        return () => clearInterval(cooldownTimer)
    })

    function signedOut(err: unknown) {
        if (err instanceof AccountApiError && err.status === 401) {
            location.assign(sessionStartUrl(here))
            return true
        }
        return false
    }

    async function load() {
        try {
            me = await accountFetch<Me>('/api/v2/account/me')
        } catch (err) {
            if (!signedOut(err)) loadError = accountErrorText(err)
        }
    }

    function startCooldown(seconds: number) {
        cooldown = seconds
        clearInterval(cooldownTimer)
        cooldownTimer = setInterval(() => {
            cooldown = Math.max(0, cooldown - 1)
            if (cooldown === 0) clearInterval(cooldownTimer)
        }, 1000)
    }

    function startEditing() {
        editing = true
        removing = false
        address = ''
        codeSentTo = ''
        code = ''
        emailError = ''
        emailNotice = ''
    }

    async function sendCode(event?: SubmitEvent) {
        event?.preventDefault()
        emailBusy = true
        emailError = ''
        try {
            const result = await accountFetch<{ sent: true; cooldown_s: number }>('/api/v2/account/me/email', {
                method: 'POST', body: { address }
            })
            codeSentTo = address.trim()
            code = ''
            startCooldown(result.cooldown_s)
            await tick()
            codeInput?.focus()
        } catch (err) {
            if (signedOut(err)) return
            emailError = accountErrorText(err)
            if (err instanceof AccountApiError && err.code === 'code_cooldown' && err.retryAfterS) startCooldown(err.retryAfterS)
        } finally {
            emailBusy = false
        }
    }

    async function verify(value = code) {
        if (!/^\d{4}$/.test(value)) return
        emailBusy = true
        emailError = ''
        try {
            const previous = me?.external_email?.address
            me = await accountFetch<Me>('/api/v2/account/me/email/verify', { method: 'POST', body: { address: codeSentTo, code: value } })
            editing = false
            emailNotice = previous ? `Changed. We told ${previous} about it.` : 'Verified.'
        } catch (err) {
            if (signedOut(err)) return
            emailError = accountErrorText(err)
            code = ''
        } finally {
            emailBusy = false
        }
    }

    async function remove(event: SubmitEvent) {
        event.preventDefault()
        emailBusy = true
        emailError = ''
        try {
            me = await accountFetch<Me>('/api/v2/account/me/email', { method: 'DELETE', body: { password: removePassword } })
            removing = false
            emailNotice = 'Removed. Forwarding is off.'
        } catch (err) {
            if (signedOut(err)) return
            emailError = accountErrorText(err)
        } finally {
            removePassword = ''
            emailBusy = false
        }
    }

    async function setRedirect(enabled: boolean, keep_copy: boolean) {
        if (!me) return
        redirectBusy = true
        redirectError = ''
        try {
            me = await accountFetch<Me>('/api/v2/account/me/redirect', { method: 'PATCH', body: { enabled, keep_copy } })
        } catch (err) {
            if (signedOut(err)) return
            redirectError = accountErrorText(err)
        } finally {
            redirectBusy = false
        }
    }

    async function signOut() {
        signingOut = true
        try {
            const result = await accountFetch<{ redirect: string }>('/api/v2/account/session/logout', { method: 'POST' })
            location.assign(result.redirect)
        } catch {
            location.assign('/')
        }
    }
</script>

<svelte:head>
    <title>Account · femboyz.cloud</title>
    <meta name="robots" content="noindex" />
</svelte:head>

<section class="acct-page" class:embed>
    {#if loadError}
        <div class="acct-panel acct-fade-in">
            <p class="acct-error" role="alert">{loadError}</p>
            <div class="acct-actions"><button class="acct-quiet" type="button" onclick={load}>Retry</button></div>
        </div>
    {:else if !me}
        <!-- nothing while loading (or while bouncing to sign-in); the panels fade in after -->
    {:else}
        <div class="acct-panel acct-fade-in">
            <div class="title-row">
                <div>
                    <h1>{me.username}</h1>
                    <p class="acct-muted">{me.email}</p>
                </div>
                {#if embed}
                    <a class="acct-quiet" href="/account" target="_blank" rel="noopener noreferrer">Open account</a>
                {:else}
                    <div class="title-actions">
                        <a class="acct-quiet acct-icon-button" href={mailUrl} aria-label="Mail" title="Mail">
                            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="5" width="18" height="14" rx="1" />
                                <path d="m3.5 6 8.5 7 8.5-7" />
                            </svg>
                        </a>
                        <button class="acct-quiet" type="button" onclick={signOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>
                    </div>
                {/if}
            </div>
            <div class="acct-field">
                <span>Mailbox storage</span>
                {#if quotaPercent !== null}
                    <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={quotaPercent} aria-label="Mailbox storage used">
                        <div style:width={`${quotaPercent}%`}></div>
                    </div>
                    <span>{formatFileSize(me.quota.used_bytes ?? 0)} of {formatFileSize(me.quota.limit_bytes)} used</span>
                {:else}
                    <span>{formatFileSize(me.quota.limit_bytes)} total</span>
                {/if}
            </div>
        </div>

        <div class="acct-panel acct-fade-in">
            <h2>External email</h2>
            <p class="acct-muted">An address at another provider. It can receive a copy of your mail, and it's where account recovery goes.</p>

            {#if me.external_email && !editing}
                <p><strong>{me.external_email.address}</strong> <span class="acct-badge">Verified</span></p>
            {:else if !me.external_email && !editing}
                <p class="acct-muted">None set.</p>
            {/if}

            {#if emailNotice}<p class="acct-ok" role="status" transition:slide={reveal}>{emailNotice}</p>{/if}

            {#if editing}
                <form class="acct-form" onsubmit={sendCode} transition:slide={reveal}>
                    <label class="acct-field">
                        <span>{me.external_email ? 'New address' : 'Address'}</span>
                        <input bind:value={address} type="email" autocomplete="email" maxlength="254" required disabled={emailBusy} />
                    </label>
                    {#if codeSentTo && codeSentTo === address.trim()}
                        <div class="acct-field" transition:slide={reveal}>
                            <span>Enter the 4-digit code we sent to {codeSentTo}</span>
                            <CodeInput bind:this={codeInput} bind:value={code} disabled={emailBusy} oncomplete={(value) => void verify(value)} />
                        </div>
                    {/if}
                    {#if emailError}<p class="acct-error" role="alert" transition:slide={reveal}>{emailError}</p>{/if}
                    <div class="acct-actions">
                        <button class="fb-button" type="submit" disabled={emailBusy || cooldown > 0 || !address.trim()}>
                            {emailBusy ? 'Working…' : cooldown > 0 ? `Resend in ${cooldown}s` : codeSentTo === address.trim() ? 'Resend code' : 'Send code'}
                        </button>
                        <button class="acct-quiet" type="button" onclick={() => (editing = false)} disabled={emailBusy}>Cancel</button>
                    </div>
                    {#if me.external_email}<p class="acct-muted">{me.external_email.address} stays active until the new address is verified.</p>{/if}
                </form>
            {:else if removing}
                <form class="acct-form" onsubmit={remove} transition:slide={reveal}>
                    <label class="acct-field">
                        <span>Confirm with your password</span>
                        <input bind:value={removePassword} type="password" autocomplete="current-password" required disabled={emailBusy} />
                    </label>
                    {#if emailError}<p class="acct-error" role="alert" transition:slide={reveal}>{emailError}</p>{/if}
                    <div class="acct-actions">
                        <button class="delete-button" type="submit" disabled={emailBusy}>{emailBusy ? 'Removing…' : 'Remove address'}</button>
                        <button class="acct-quiet" type="button" onclick={() => (removing = false)} disabled={emailBusy}>Cancel</button>
                    </div>
                </form>
            {:else}
                <div class="acct-actions">
                    <button class="acct-quiet" type="button" onclick={startEditing}>{me.external_email ? 'Change' : 'Add address'}</button>
                    {#if me.external_email}
                        <button class="acct-quiet" type="button" onclick={() => { removing = true; emailError = ''; emailNotice = '' }}>Remove</button>
                    {/if}
                </div>
            {/if}
        </div>

        <div class="acct-panel acct-fade-in">
            <h2>Forwarding</h2>
            {#if !me.external_email}
                <p class="acct-muted">Add an external email to forward your mail there.</p>
            {:else}
                <label class="toggle">
                    <input
                        type="checkbox"
                        checked={me.redirect.enabled}
                        disabled={redirectBusy}
                        onchange={(event) => setRedirect((event.currentTarget as HTMLInputElement).checked, me!.redirect.keep_copy)}
                    />
                    <span>Forward incoming mail to {me.external_email.address}</span>
                </label>
                <label class="toggle">
                    <input
                        type="checkbox"
                        checked={me.redirect.keep_copy}
                        disabled={redirectBusy || !me.redirect.enabled}
                        onchange={(event) => setRedirect(true, (event.currentTarget as HTMLInputElement).checked)}
                    />
                    <span>Keep a copy here</span>
                </label>
                <p class="acct-muted">Messages the spam filter flags stay here and are never forwarded. If forwarded mail keeps bouncing, forwarding turns itself off.</p>
                {#if redirectError}<p class="acct-error" role="alert" transition:slide={reveal}>{redirectError}</p>{/if}
            {/if}
        </div>
    {/if}
</section>

<style>
    .embed {
        width: 100%;
        max-width: 36rem;
        padding: 0;
    }

    .title-row {
        display: flex;
        align-items: flex-start;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 1rem;
    }

    .title-row > div {
        min-width: 0;
        overflow-wrap: anywhere;
    }

    .title-row :global(a.acct-quiet) {
        display: inline-flex;
        align-items: center;
        text-decoration: none;
    }

    .title-actions {
        display: flex;
        gap: 0.5rem;
    }

    /* square, as tall as the Sign out button next to it */
    .title-row :global(a.acct-icon-button) {
        justify-content: center;
        width: 2.75rem;
        padding: 0;
        box-sizing: border-box;
    }

    .title-row p {
        margin-top: 0.25rem;
    }

    .meter {
        height: 0.5rem;
        background: #171515;
        border: 1px solid #4a4447;
    }

    .meter > div {
        height: 100%;
        background: var(--color-accent);
    }

    .toggle {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        cursor: pointer;
    }

    .toggle input {
        width: 1.1rem;
        height: 1.1rem;
        margin: 0;
    }

    .delete-button {
        min-height: 2.75rem;
        padding: 0.55rem 0.8rem;
        color: #ffb3c7;
        background: transparent;
        border: 1px solid #9e3152;
        font: inherit;
        cursor: pointer;
    }
</style>
