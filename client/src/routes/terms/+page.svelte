<script lang="ts">
    import '$lib/styles/account.css'
</script>

<svelte:head>
    <title>Rules · femboyz.cloud</title>
    <meta name="description" content="Rules for femboyz accounts and @femboyz.cloud mail." />
</svelte:head>

<section class="acct-page terms">
    <div class="acct-panel">
        <h1>Rules for femboyz accounts</h1>
        <p class="acct-muted">Last changed 19 October 2026</p>
        <p>
            A femboyz account comes with an @femboyz.cloud mailbox and webmail. It's free, invite-only and
            run by one person on one small server. Everyone shares that server's reputation, so one
            spammer can get mail from every account rejected. These rules exist to stop that.
        </p>
    </div>

    <div class="acct-panel">
        <h2>Don't</h2>
        <ul>
            <li>Send spam: bulk or unsolicited mail, newsletters to people who didn't ask, purchased lists.</li>
            <li>Phish, scam, impersonate someone, or send malware.</li>
            <li>Harass or threaten anyone.</li>
            <li>Send or store anything illegal. Sexual content involving minors is reported to the authorities.</li>
            <li>Use the account to mass-register on other services, or share, sell or hand it over.</li>
            <li>Try to break the server or get around its limits.</li>
        </ul>
    </div>

    <div class="acct-panel">
        <h2>Limits</h2>
        <p>
            Sending is capped per hour and per day, and lower during an account's first 14 days.
            One message can go to at most 25 recipients. Mailboxes have a storage quota. Normal personal
            mail never comes close.
        </p>
    </div>

    <div class="acct-panel">
        <h2>If the rules are broken</h2>
        <p>
            Accounts that break these rules are disabled, and can be deleted along with their mail.
            When there's an ongoing risk to the server, this happens first and without warning.
            Report abuse to <a href="mailto:abuse@femboyz.cloud">abuse@femboyz.cloud</a>.
        </p>
    </div>

    <div class="acct-panel">
        <h2>Your data</h2>
        <p>
            We store your username, a hash of your password, the optional recovery &amp; redirect address,
            and your mail. Mail isn't read, except to investigate an abuse report or when the law requires it.
            Mail is backed up, but this is a hobby service: keep your own copy of anything important.
        </p>
    </div>

    <div class="acct-panel">
        <h2>Changes</h2>
        <p>
            These rules can change. Important changes are announced to your @femboyz.cloud address.
            Questions go to <a href="mailto:admin@femboyz.cloud">admin@femboyz.cloud</a>.
        </p>
    </div>
</section>

<style>
    .terms {
        gap: 2rem;
        width: min(100%, 40rem);
        line-height: 1.55;
    }

    .terms ul {
        display: grid;
        gap: 0.4rem;
        margin: 0;
        padding-left: 1.2rem;
    }

    .terms a {
        color: inherit;
        text-decoration: underline;
    }
</style>
