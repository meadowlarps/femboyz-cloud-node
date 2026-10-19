<script lang="ts">
    import { onMount } from 'svelte'
    import { page } from '$app/state'
    import { slide } from 'svelte/transition'
    import { cubicOut } from 'svelte/easing'
    import '$lib/styles/account.css'
    import { accountErrorText, accountFetch, AccountApiError, sessionStartUrl } from '$lib/account/api'

    // The OIDC provider sends people here with ?uid=<interaction>. Without one there is
    // nothing to sign in to yet, so start a femboyz.cloud session, which comes back with a uid.
    const uid = page.url.searchParams.get('uid')
    const startError = page.url.searchParams.get('error')

    let username = $state(page.url.searchParams.get('username') ?? '')
    let password = $state('')
    let busy = $state(false)
    let error = $state(
        startError === 'expired' ? 'This sign-in took too long. Start again.'
        : startError === 'session' ? "Signing in didn't work. Try again."
        : ''
    )
    let expired = $state(startError !== null)

    let requestOpen = $state(false)
    let requestEmail = $state('')
    let requestNote = $state('')
    let requestWebsite = $state('')
    let requestBusy = $state(false)
    let requestError = $state('')
    let requestSent = $state(false)

    const reveal = { duration: 220, easing: cubicOut }

    onMount(() => {
        if (!uid && !startError) location.replace(sessionStartUrl('/account'))
    })

    async function signIn(event: SubmitEvent) {
        event.preventDefault()
        if (!uid) return
        busy = true
        error = ''
        try {
            const result = await accountFetch<{ redirect: string }>(`/oidc/interaction/${encodeURIComponent(uid)}/login`, {
                method: 'POST',
                body: { username, password }
            })
            location.assign(result.redirect)
        } catch (err) {
            busy = false
            password = ''
            error = accountErrorText(err)
            if (err instanceof AccountApiError && err.code === 'interaction_expired') expired = true
        }
    }

    async function sendRequest(event: SubmitEvent) {
        event.preventDefault()
        requestBusy = true
        requestError = ''
        try {
            await accountFetch('/api/v2/account/request', {
                method: 'POST',
                body: { email: requestEmail, note: requestNote, website: requestWebsite }
            })
            requestSent = true
        } catch (err) {
            requestError = accountErrorText(err)
        } finally {
            requestBusy = false
        }
    }
</script>

<svelte:head>
    <title>Sign in · femboyz.cloud</title>
    <meta name="robots" content="noindex" />
</svelte:head>

<section class="acct-page">
    <!-- without a uid the page is only a hop to the provider: render nothing, so the
         form fades in once, when the provider sends the browser back -->
    {#if uid || expired}
    <div class="acct-panel acct-fade-in">
        <h1>Sign in</h1>

        {#if expired}
            <p class="acct-error" role="alert">{error}</p>
            <div class="acct-actions">
                <a class="fb-button" href={sessionStartUrl('/account')}>Start again</a>
            </div>
        {:else if uid}
            <form class="acct-form" onsubmit={signIn} aria-busy={busy}>
                <label class="acct-field">
                    <span>Username</span>
                    <div class="acct-suffix">
                        <input
                            bind:value={username}
                            name="username"
                            autocomplete="username"
                            autocapitalize="none"
                            spellcheck="false"
                            placeholder="name"
                            required
                            disabled={busy}
                        />
                        <span>@femboyz.cloud</span>
                    </div>
                </label>
                <label class="acct-field">
                    <span>Password</span>
                    <input bind:value={password} name="password" type="password" autocomplete="current-password" required disabled={busy} />
                </label>
                {#if error}<p class="acct-error" role="alert" transition:slide={reveal}>{error}</p>{/if}
                <div class="acct-actions">
                    <button class="fb-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
                </div>
            </form>
        {/if}
    </div>

    <div class="acct-panel acct-fade-in">
        <h2>No account?</h2>
        <p class="acct-muted">femboyz.cloud accounts are invite-only. Each one comes with a @femboyz.cloud mailbox.</p>

        {#if requestSent}
            <p class="acct-ok" role="status" in:slide={reveal}>Request sent. If it's approved, the invite goes to {requestEmail}.</p>
        {:else if !requestOpen}
            <div class="acct-actions" in:slide={reveal}>
                <button class="fb-button fb-button-ghost" type="button" onclick={() => (requestOpen = true)}>Request access</button>
            </div>
        {:else}
            <form class="acct-form" onsubmit={sendRequest} aria-busy={requestBusy} transition:slide={reveal}>
                <label class="acct-field">
                    <span>Your email</span>
                    <input bind:value={requestEmail} type="email" autocomplete="email" maxlength="254" required disabled={requestBusy} />
                </label>
                <label class="acct-field">
                    <span>Who are you, and why do you want in? (optional)</span>
                    <textarea bind:value={requestNote} maxlength="1000" disabled={requestBusy}></textarea>
                </label>
                <label class="acct-honeypot" aria-hidden="true">
                    Website <input bind:value={requestWebsite} tabindex="-1" autocomplete="off" />
                </label>
                {#if requestError}<p class="acct-error" role="alert" transition:slide={reveal}>{requestError}</p>{/if}
                <div class="acct-actions">
                    <button class="fb-button" type="submit" disabled={requestBusy}>{requestBusy ? 'Sending…' : 'Send request'}</button>
                    <button class="acct-quiet" type="button" onclick={() => (requestOpen = false)} disabled={requestBusy}>Cancel</button>
                </div>
            </form>
        {/if}
    </div>
    {/if}
</section>
