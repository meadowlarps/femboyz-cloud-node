<script lang="ts">
    import { onMount, tick } from 'svelte'
    import { page } from '$app/state'
    import { fade, slide } from 'svelte/transition'
    import { cubicOut } from 'svelte/easing'
    import '$lib/styles/account.css'
    import CodeInput from '$lib/account/CodeInput.svelte'
    import ErrorScreen from '$lib/ErrorScreen.svelte'
    import { accountErrorText, accountFetch, AccountApiError, sessionStartUrl } from '$lib/account/api'

    type InviteInfo = { valid: true; email: string | null; expires: string }
    type Availability = { username: string; available: boolean; reason?: 'invalid' | 'reserved' | 'taken' }

    const MAIL_DOMAIN = 'femboyz.cloud'
    const invite = page.url.searchParams.get('invite') ?? ''
    const reveal = { duration: 220, easing: cubicOut }

    let info = $state<InviteInfo | null>(null)
    // why the invite can't be used: shown full-screen like the site's 404/500 pages
    let loadError = $state<{ status: number; title: string; text: string } | null>(null)

    let username = $state('')
    let password = $state('')
    let confirm = $state('')
    let availability = $state<Availability | null>(null)
    let checking = $state(false)
    let checkTimer: ReturnType<typeof setTimeout> | undefined

    let address = $state('')
    let codeSentTo = $state('')
    let code = $state('')
    let cooldown = $state(0)
    let cooldownTimer: ReturnType<typeof setInterval> | undefined
    let codeInput = $state<ReturnType<typeof CodeInput>>()

    let agreed = $state(false)
    let busy = $state(false)
    let error = $state('')
    let created = $state<{ username: string; email: string } | null>(null)

    const normalizedAddress = $derived(address.trim().toLowerCase())
    const preVerified = $derived(!!info?.email && normalizedAddress === info.email.toLowerCase())
    // the code field is open while the address it was sent to is still the one typed in
    const awaitingCode = $derived(normalizedAddress !== '' && !preVerified && codeSentTo === normalizedAddress)
    const needsVerify = $derived(normalizedAddress !== '' && !preVerified && !awaitingCode)

    const passwordHint = $derived(
        password.length > 0 && [...password].length < 12 ? 'Use at least 12 characters.'
        : confirm.length > 0 && confirm !== password ? "The passwords don't match."
        : ''
    )
    const accountReady = $derived(availability?.available === true && [...password].length >= 12 && password === confirm)
    const canSubmit = $derived(
        accountReady && agreed && !busy && (needsVerify ? cooldown === 0 : !awaitingCode || /^\d{4}$/.test(code)))

    onMount(() => {
        if (!invite) {
            loadError = { status: 404, title: 'This link is missing its invite', text: 'Open the signup link from your invite email, the whole thing.' }
            return
        }
        void (async () => {
            try {
                info = await accountFetch<InviteInfo>(`/api/v2/account/invite/${encodeURIComponent(invite)}`)
                address = info.email ?? ''
            } catch (err) {
                loadError = !(err instanceof AccountApiError) ? { status: 500, title: "We can't reach the server", text: 'Check your connection and reload the page.' }
                    : err.status === 404 ? { status: 404, title: "This invite doesn't work", text: 'It may be expired, already used, or copied only partly. Ask whoever invited you for a new one, or request access yourself.' }
                    : err.status === 429 ? { status: 429, title: 'Slow down a little', text: accountErrorText(err) }
                    : { status: err.status, title: 'We broke something...', text: 'Try again later or head back home' }
            }
        })()
        return () => { clearTimeout(checkTimer); clearInterval(cooldownTimer) }
    })

    function usernameChanged() {
        availability = null
        clearTimeout(checkTimer)
        const name = username.trim().toLowerCase()
        if (name.length < 3) return
        checkTimer = setTimeout(() => void checkAvailability(name), 350)
    }

    async function checkAvailability(name: string) {
        checking = true
        try {
            const result = await accountFetch<Availability>(
                `/api/v2/account/available?name=${encodeURIComponent(name)}&invite=${encodeURIComponent(invite)}`)
            if (username.trim().toLowerCase() === name) availability = result
        } catch (err) {
            error = accountErrorText(err)
        } finally {
            checking = false
        }
    }

    function availabilityText(result: Availability) {
        if (result.available) return `${result.username}@${MAIL_DOMAIN} is available.`
        if (result.reason === 'taken') return 'That username is taken.'
        if (result.reason === 'reserved') return 'That username is reserved.'
        return '3–32 characters: a–z, 0–9, dot, dash or underscore. Start and end with a letter or digit.'
    }

    function startCooldown(seconds: number) {
        cooldown = seconds
        clearInterval(cooldownTimer)
        cooldownTimer = setInterval(() => {
            cooldown = Math.max(0, cooldown - 1)
            if (cooldown === 0) clearInterval(cooldownTimer)
        }, 1000)
    }

    async function sendCode() {
        busy = true
        error = ''
        try {
            const result = await accountFetch<{ verified?: true; sent?: true; cooldown_s?: number }>(
                '/api/v2/account/signup/email-code', { method: 'POST', body: { invite, address } })
            if (result.sent) {
                codeSentTo = normalizedAddress
                code = ''
                startCooldown(result.cooldown_s ?? 60)
                busy = false
                await tick()
                codeInput?.focus()
            }
        } catch (err) {
            error = accountErrorText(err)
            if (err instanceof AccountApiError && err.code === 'code_cooldown' && err.retryAfterS) startCooldown(err.retryAfterS)
        } finally {
            busy = false
        }
    }

    async function createAccount() {
        busy = true
        error = ''
        const external = normalizedAddress ? { address, ...(preVerified ? {} : { code }) } : undefined
        try {
            created = await accountFetch<{ username: string; email: string }>('/api/v2/account/signup', {
                method: 'POST',
                body: { invite, username, password, ...(external ? { external_email: external } : {}) }
            })
            password = ''
            confirm = ''
        } catch (err) {
            error = accountErrorText(err)
            if (err instanceof AccountApiError && err.code.startsWith('code_')) code = ''
        } finally {
            busy = false
        }
    }

    function submit(event: SubmitEvent) {
        event.preventDefault()
        if (!canSubmit) return
        void (needsVerify ? sendCode() : createAccount())
    }
</script>

<svelte:head>
    <title>Create your account · femboyz.cloud</title>
    <meta name="robots" content="noindex" />
    <!-- link preview for invite links pasted into chats -->
    <meta name="description" content="Accept your femboyz account invitation" />
    <meta property="og:site_name" content="femboyz.cloud" />
    <meta property="og:title" content="femboyz.cloud" />
    <meta property="og:description" content="Accept your femboyz account invitation" />
    <meta property="og:type" content="website" />
</svelte:head>

{#if loadError}
    <ErrorScreen status={loadError.status} title={loadError.title} text={loadError.text}>
        {#snippet actions()}
            <a class="fb-button" href="/login">Request access</a>
            <a class="fb-button fb-button-ghost" href="/">Back to home</a>
        {/snippet}
    </ErrorScreen>
{:else}
<section class="acct-page">
    <!-- nothing until the invite is checked, then the panel fades in (and again on success) -->
    {#if info}
    {#key created ? 'done' : 'form'}
    <div class="acct-panel acct-fade-in">
        {#if created}
            <h1>Welcome, {created.username}</h1>
            <p>Your account and mailbox <strong>{created.email}</strong> are ready.</p>
            <div class="acct-actions">
                <a class="fb-button" href={sessionStartUrl('/account')}>Sign in</a>
            </div>
        {:else}
            <h1>Create your <span class="acct-brand">femboyz</span> account</h1>
            <form class="acct-form" onsubmit={submit} aria-busy={busy}>
                <label class="acct-field">
                    <span>Username</span>
                    <div class="acct-suffix">
                        <input
                            bind:value={username}
                            oninput={usernameChanged}
                            autocomplete="username"
                            autocapitalize="none"
                            spellcheck="false"
                            maxlength="32"
                            required
                            disabled={busy}
                        />
                        <span>@{MAIL_DOMAIN}</span>
                    </div>
                    {#if checking}
                        <span class="acct-status" transition:slide={reveal}>Checking…</span>
                    {:else if availability}
                        <span class="acct-status {availability.available ? 'acct-ok' : 'acct-error'}" transition:slide={reveal}>{availabilityText(availability)}</span>
                    {/if}
                </label>
                <label class="acct-field">
                    <span>Password</span>
                    <input bind:value={password} type="password" autocomplete="new-password" required disabled={busy} />
                </label>
                <label class="acct-field">
                    <span>Repeat password</span>
                    <input bind:value={confirm} type="password" autocomplete="new-password" required disabled={busy} />
                </label>
                {#if passwordHint}<p class="acct-error" transition:slide={reveal}>{passwordHint}</p>{/if}

                <label class="acct-field">
                    <span>Recovery &amp; Redirect email (optional)</span>
                    <div class="acct-badged">
                        <input bind:value={address} type="email" autocomplete="email" maxlength="254" placeholder="example@gmail.com" disabled={busy} />
                        {#if preVerified}
                            <span class="acct-badge acct-tip" data-tip="Your invite was sent here." tabindex="-1" transition:fade={{ duration: 180 }}>Verified</span>
                        {/if}
                    </div>
                </label>

                {#if awaitingCode}
                    <div class="acct-field" transition:slide={reveal}>
                        <span>Enter the 4-digit code we sent to {address.trim()}</span>
                        <div class="acct-code-row">
                            <CodeInput bind:this={codeInput} bind:value={code} disabled={busy} />
                            <button class="acct-quiet acct-resend" type="button" onclick={sendCode} disabled={busy || cooldown > 0}>
                                {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                            </button>
                        </div>
                    </div>
                {/if}

                <label class="acct-check">
                    <input bind:checked={agreed} type="checkbox" required disabled={busy} />
                    <span>I agree to the <a href="/terms" target="_blank" rel="noopener">rules</a>: no spam, no abuse, and the account can be closed if I break them.</span>
                </label>

                {#if error}<p class="acct-error" role="alert" transition:slide={reveal}>{error}</p>{/if}
                <div class="acct-actions">
                    <button class="fb-button" type="submit" disabled={!canSubmit}>
                        {#if busy}
                            Working…
                        {:else if needsVerify}
                            {cooldown > 0 ? `Verify email (${cooldown}s)` : 'Verify email'}
                        {:else}
                            Create account
                        {/if}
                    </button>
                </div>
            </form>
        {/if}
    </div>
    {/key}
    {/if}
</section>
{/if}
