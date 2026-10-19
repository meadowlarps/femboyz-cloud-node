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

<section class="acct-page login">
    <!-- without a uid the page is only a hop to the provider: render nothing, so the
         form fades in once, when the provider sends the browser back -->
    {#if uid || expired}
    <!-- requesting access takes the whole page: sign-in folds away, and comes back on Cancel -->
    {#if !requestOpen && !requestSent}
    <div class="login-signin" transition:slide={reveal}>
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
    </div>
    {/if}

    {#if requestSent}
        <!-- waits for the request panel to fold away before unfolding -->
        <div class="login-sent" role="status" in:slide={{ ...reveal, delay: reveal.duration }} out:slide={reveal}>
            <svg class="login-sent-icon" viewBox="0 0 48 48" aria-hidden="true">
                <circle cx="24" cy="24" r="22" pathLength="1" />
                <path d="M14 24h19M25 16l8 8-8 8" />
            </svg>
            <div class="login-sent-text">
                <p class="login-sent-title">Your request was successfully sent</p>
                <p class="acct-muted">Await confirmation in your mailbox</p>
                <p class="login-sent-mail">{requestEmail}</p>
            </div>
        </div>
    {:else}
    <div class="acct-panel acct-fade-in" class:login-takeover={requestOpen} transition:slide={reveal}>
        <h2>No account?</h2>
        <p class="acct-muted">femboyz.cloud accounts are invite-only. Each one comes with a @femboyz.cloud mailbox.</p>

        {#if !requestOpen}
            <div class="acct-actions" in:slide={reveal}>
                <button class="fb-button fb-button-ghost" type="button" onclick={() => (requestOpen = true)}>Request access</button>
            </div>
        {:else}
            <form class="acct-form" onsubmit={sendRequest} aria-busy={requestBusy} transition:slide={reveal}>
                <label class="acct-field">
                    <span>Your email</span>
                    <input
                        bind:value={requestEmail}
                        type="email"
                        autocomplete="email"
                        maxlength="254"
                        required
                        disabled={requestBusy}
                        {@attach (input) => input.focus({ preventScroll: true })}
                    />
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
    {/if}
</section>

<style>
    /* the space between sign-in and the request panel lives inside the sign-in wrapper,
       so it folds away with it instead of snapping shut at the end */
    .login {
        gap: 0;
    }

    .login-signin {
        padding-bottom: 3rem;
    }

    /* with sign-in gone, the request heading grows into the page title */
    .acct-panel h2 {
        transition: font-size var(--acct-ease);
    }

    .login-takeover h2 {
        font-size: 1.6rem;
    }

    /* Request sent: a green arrow in a circle beside three lines of text. */
    .login-sent {
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: center;
        gap: 1.25rem;
    }

    .login-sent p {
        margin: 0;
    }

    .login-sent-icon {
        width: 3.5rem;
        height: 3.5rem;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
    }

    /* the circle draws itself, then the arrow slides in, once the block has unfolded */
    .login-sent-icon circle {
        fill: #b8f0c80f;
        stroke: #3f7a52;
        stroke-width: 2;
        stroke-dasharray: 1;
        transform: rotate(-90deg);
        transform-origin: center;
        animation: login-sent-ring 0.5s 0.4s ease-out both;
    }

    .login-sent-icon path {
        stroke: #b8f0c8;
        stroke-width: 2.5;
        animation: login-sent-arrow 0.35s 0.7s cubic-bezier(0.2, 0.8, 0.3, 1.2) both;
    }

    .login-sent-text {
        display: grid;
        gap: 0.3rem;
        min-width: 0;
    }

    .login-sent-title {
        color: #b8f0c8;
        font-weight: 600;
    }

    .login-sent-mail {
        color: #f4f4f4;
        overflow-wrap: anywhere;
    }

    @keyframes login-sent-ring {
        from {
            stroke-dashoffset: 1;
        }
        to {
            stroke-dashoffset: 0;
        }
    }

    @keyframes login-sent-arrow {
        from {
            opacity: 0;
            translate: -0.35rem 0;
        }
        to {
            opacity: 1;
            translate: 0 0;
        }
    }

    @media (max-width: 42rem) {
        .login-signin {
            padding-bottom: 2.5rem;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .login-sent-icon circle,
        .login-sent-icon path {
            animation: none;
        }
    }
</style>
