# femboyz accounts + mail — plan

Status: v8 · 2026-10-19 · phases 1–3 deployed and verified in production · phase 4 limits live in production; Postmaster Tools, SNDS and DMARC tightening left for the admin (DEPLOYMENT.md 16)

Invite-only **femboyz accounts** that come with an `@femboyz.cloud` mailbox, read at `https://mail.femboyz.cloud`. The same account will later log in to femboyz.cloud itself.

| Piece | What | Who builds it |
|---|---|---|
| **femboyz account** | Users, login page, request access, invites, OIDC provider | **us**, in femboyz-cloud-node + `client/` |
| **Mail server** | [Stalwart](https://stalw.art) 0.16: SMTP, IMAP, JMAP, spam filter, DKIM. Mail bodies in S3 (`femboyz-mail-blobs`, DEPLOYMENT.md 16.5) | upstream image, config only |
| **Webmail** | [Bulwark](https://bulwarkmail.org) (Next.js + JMAP) with a femboyz theme | pinned upstream source + small SSO patch, config + theme |

Decisions so far:
- Webmail lives at `mail.femboyz.cloud`. Stalwart gets a backend-only host, `mx.femboyz.cloud`, that users never see.
- One Hetzner VPS for everything. Hetzner has unblocked outbound port 25.
- Only the admin can approve requests and issue invites.
- DNS stays at Namecheap, with records added by hand.
- **femboyz-cloud-node owns the accounts.** Stalwart is a mailbox provider underneath it, not the account system.
- Request notifications go to the admin's femboyz mailbox (`admin@femboyz.cloud`). That mailbox redirects to the admin's verified external email.
- Default mailbox quota is **1 GiB**. Invites expire after **7 days**. Rejected requests get **no email**.
- **No IMAP/SMTP for mail apps** at launch; webmail only.
- **External email (optional):** a user can attach an address at another provider, at signup or later from webmail. It must be verified with a **4-digit code** emailed to it. Once verified it can be used for **redirecting** incoming mail and for account recovery (section 2.1).

---

## 1. Architecture

```text
                    ┌──────────────────────── Hetzner VPS ───────────────────────────────┐
 browser ──443──► nginx ─┬─ femboyz.cloud       → SvelteKit :3001  (site, /login, /signup)│
                         │                      → Fastify   :3000  (/api/v2/*, /oidc/*)   │
                         ├─ mail.femboyz.cloud  → Bulwark   :3100  (webmail UI)           │
                         └─ mx.femboyz.cloud    → Stalwart  :8443  (JMAP, admin)          │
 other mail servers ──25─────────────────────► Stalwart (direct)                         │
 mail apps ──465/587/993─────────────────────► Stalwart (direct, later phase)            │
                    │                                                                     │
                    │  Fastify ── JMAP mgmt API (service key) ──► Stalwart: create/disable│
                    │  Fastify ── SMTP 465 (noreply@) ──────────► Stalwart: system mail   │
                    │  Bulwark / Stalwart ── OIDC ──────────────► Fastify (/oidc)         │
                    └─────────────────────────────────────────────────────────────────────┘
```

### Hostnames

| Host | Who sees it | Serves |
|---|---|---|
| `femboyz.cloud` | users | Main site, the **login page** (`/login`), signup (`/signup`), the OIDC issuer (`/oidc/*`). Also the mail domain. |
| `mail.femboyz.cloud` | users | Bulwark webmail, the "frontend" |
| `mx.femboyz.cloud` | machines only | Stalwart, the "backend": the MX record, the PTR (reverse DNS) name, the TLS name for SMTP/IMAP, the JMAP API that Bulwark calls, and Stalwart's own admin UI |

Why Stalwart can't share `mail.`: both Bulwark and Stalwart serve `/api` and `/admin` paths, so they can't live on one HTTPS origin. Mail servers also expect the MX hostname to match the server's reverse DNS.

### Login flow

1. On femboyz.cloud, a **mail** button next to the logo links to `https://mail.femboyz.cloud`.
2. Bulwark (`OAUTH_ONLY` + `AUTO_SSO_ENABLED`) immediately redirects to `https://femboyz.cloud/login`, our page in femboyz design.
3. The login page shows username + password, a note that accounts are **invite-only**, and a **Request access** button.
4. On success our OIDC provider redirects back to Bulwark with tokens. Bulwark sends the access token to Stalwart (JMAP), and Stalwart validates it against our issuer.

### Request access → invite → signup

1. **Request access** form: contact email (required), optional "why / who are you" note, honeypot field, per-IP limit via `authlimit`.
2. Saved to `account_requests` and emailed from `noreply@femboyz.cloud` to `ADMIN_NOTIFY_EMAIL` (`admin@femboyz.cloud`). The email shows the address and note, plus a direct link to `/admin?tab=requests&id=…`. The admin mailbox redirects it to the admin's verified external email, like any user's redirect.
3. In `/admin` → Requests the admin chooses **Approve** or **Reject**. Approving creates a single-use invite valid for 7 days and emails the link to the requester. Rejecting is silent: the status changes and no email is sent.
4. The admin can also create an invite directly without a request (e.g. for a friend) and copy the link.
5. `femboyz.cloud/signup?invite=CODE` has two steps:
   - **Step 1, account:** the user picks a username (shown as `name@femboyz.cloud`, with a live availability check) and a password.
   - **Step 2, external email (optional, can be skipped):**
     - If the invite came from a request, the field is pre-filled with the request address and is **already verified**. Clicking the invite link that was sent there proves ownership.
     - Entering a different address sends a 4-digit code to it, and the user types the code in.
     - Skipping leaves the account with no external email.
6. The API then:
   - reserves the invite atomically,
   - creates the user in Mongo,
   - provisions the Stalwart account with `x:Account/set` and a 1 GiB quota,
   - stores the external email if one was verified,
   - marks the invite used,
   - and rolls back on any failure.
7. The user lands logged in at `mail.femboyz.cloud`.

---

## 2. femboyz account system (this repo)

### Why we run the identity provider ourselves

| Option | Verdict |
|---|---|
| Stalwart as the account system (its built-in OIDC provider) | Every account is tied to the mail server, and its login page can't carry our design or the request-access button. Rejected. |
| Separate identity provider (Authentik, Zitadel, Keycloak) | Another heavy service with its own database. Theming is partial, and request/approve flows would mean custom flows anyway. Rejected for now. |
| **femboyz-cloud-node as the OIDC provider** | Users live in our Mongo. The login, request and signup pages are SvelteKit, and the main site can use the same session later. Mail is one "service" on the account. **Chosen.** |

Use [`oidc-provider`](https://github.com/panva/node-oidc-provider) (OpenID-certified, Node) for the protocol, mounted in Fastify under `/oidc`. We write the user store, the login and consent interactions, and a Mongo adapter. We do **not** write any protocol or crypto code ourselves.

### 2.1 External email: verification and redirect

**Purpose of a verified external email**
- **Redirect:** an optional per-user switch forwards incoming femboyz mail to the external address. By default a copy is also kept in the femboyz mailbox (`keep_copy`, default on).
- **Recovery:** the password-reset target (phase 5).

**Rules**
- At most one external email per account.
- It can't be an `@femboyz.cloud` address.
- An address can be verified on only one account. The admin can override this.
- Addresses are normalised: trimmed, domain lowercased.

**Where it's managed**
- During signup (step 2).
- Later at `femboyz.cloud/account`, which is also embedded in webmail settings (section 3, Bulwark).

**Changing or removing it**
- Changing requires verifying the new address first. The old address stays active until then.
- After a change, a "your external email was changed" notice goes to the **old** address.
- Removing it needs the account password and turns redirect off.

**4-digit codes**

A 4-digit code has only 10,000 values, so the limits do the security work:

| Limit | Value |
|---|---|
| Code lifetime | 10 minutes, single use; a new code invalidates the previous one |
| Wrong attempts per code | 5, then the code is burned and a new one must be requested |
| Resend cooldown | 60 seconds |
| Codes per account (or invite, during signup) | 5 per hour, 10 per day |
| Codes per destination address | 5 per day, so the feature can't be used to spam someone |
| Codes per IP | `authlimit` |

- Codes are generated with `crypto.randomInt(0, 10000)` and zero-padded.
- They're stored as `HMAC-SHA256(EMAIL_CODE_SECRET, code + address + subject)`, never in plaintext. A plain SHA-256 of 4 digits could be reversed instantly.
- Comparison is constant-time.
- The email comes from `noreply@femboyz.cloud` with the code in the subject and body, and says "if this wasn't you, ignore it".

**How the redirect works in Stalwart** (verified against 0.16.27 in phase 1)
- 0.16 has **no native per-account forwarding**: the Account object has no forwarding field, and masked emails only forward to local accounts. Redirect is a per-user **Sieve** script, managed by our backend through JMAP (`urn:ietf:params:jmap:sieve`: blob upload, then `SieveScript/set` with `onSuccessActivateScript`). With `keep_copy` it runs `redirect :copy "<external>";`, otherwise `redirect "<external>";`. `deploy/mail/admin-redirect.sieve` is the template, and `deploy/mail/stwjmap.py sieve` shows the calls.
- The JMAP Sieve calls run **as the user's account**. Decided in phase 2: the service account holds the `impersonate` permission, which lets its API key address any `accountId` (Stalwart's `is_member` check). `x:SieveUserScript` is a global script library, not per account. This adds no real power: the API is the identity provider and can already sign tokens for any user.
- Only mail that **passes the spam filter** is redirected. The script must test `header :matches "X-Spam-Score" "spam*"`. `X-Spam-Status` is only added at mailbox ingest, after Sieve has run, so a test on it never matches. This was found the hard way in phase 1, when a GTUBE test was forwarded.
- **No SRS, and no ARC sealing:**
  - Stalwart does not implement SRS.
  - It deliberately dropped ARC sealing after the IETF wound the experiment down; it only verifies ARC.
  - What it does do: a user-Sieve redirect is sent with the **mailbox's own address as envelope sender** (e.g. `admin@femboyz.cloud`). SPF is therefore checked against femboyz.cloud and passes once our SPF record exists.
  - The `From:` header stays the original sender's, so DMARC at the receiver passes only through the original sender's DKIM signature, which survives because we only prepend a `Received:` header. Gmail and Outlook senders sign, so this covers the common case.
  - We also DKIM-sign redirected mail as femboyz.cloud (`SieveUserInterpreter.dkimSignDomain`), for reputation.
- Bounces: the phase-1 test redirect was rejected by Gmail, and Stalwart logged `delivery.dsn-perm-fail`, but no DSN appeared in admin's mailbox. The original sender gets nothing either. The "turn redirect off after 3 hard bounces" rule therefore can't read bounce mail. Built in phase 2: a Stalwart **webhook** on `delivery.dsn-perm-fail`, HMAC-signed, posts to `/api/v2/account/stalwart/webhook`. A bounce counts when `data.from` is the user's address and `data.to` their external one. Verified on dev with a null-MX destination (`schema/frontend_account_admin.md`).
- Redirected mail counts toward the outbound volume we monitor.

### Data model (Mongo)

| Collection | Fields |
|---|---|
| `users` | `id_user` (UUID, the OIDC `sub`, never changes) · `username` (unique, lowercase, also the mail local part, immutable) · `password_hash` (argon2id) · `external_email?: { address, verified }` (unique sparse index on `address`) · `status` (`active` / `disabled`) · `created` · `invite_id` · `services.mail: { enabled, stalwart_id, quota_bytes, redirect: { enabled, keep_copy, bounces } }` |
| `email_codes` | `id` · `subject` (`user:<id_user>` or `invite:<id>`) · `address` · `code_hmac` · `attempts` · `created` · `expires` (TTL index) · `used` |
| `account_requests` | `id` · `email` · `note` · `issuer` (IP / UA, as in tokens) · `created` · `status` (`pending` / `approved` / `rejected`) · `decided` · `invite_id` |
| `invites` | `id` · `code_hash` (stored as SHA-256, not plaintext) · `email?` (the request address, treated as pre-verified) · `request_id?` · `quota_bytes` (default 1 GiB) · `expires` (default 7 days) · `used` · `used_by` |
| `oidc_*` | Storage for the oidc-provider adapter (sessions, grants, interactions, codes) with TTL indexes |

Mail services are optional per user, so non-mail accounts stay possible later.

### Backend modules

- `src/accounts.ts`: users, argon2id hashing, username rules, request/invite/signup logic, admin CRUD.
- `src/oidc.ts`: oidc-provider setup and Mongo adapter. Clients are `bulwark` and later `femboyz-web`. Claims: `sub`, `preferred_username`, `email` (`username@femboyz.cloud`), `name`. JWT access tokens with audience `stalwart`, because Stalwart requires `aud=stalwart` and scopes `openid email` by default.
- `src/stalwart.ts`: thin JMAP management client (`x:Account/set` create/update/destroy, quota usage) using `STALWART_API_KEY`.
- `src/mailer.ts`: nodemailer over SMTP 465 (implicit TLS, `127.0.0.1:465`; Stalwart has no 587 listener by default) to Stalwart as `noreply@femboyz.cloud`. Sends the admin notification, invite, rejection and (later) password reset emails.

### Username rules

- Must match `^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$`, with no `..`.
- Reserved names: `admin`, `administrator`, `root`, `postmaster`, `abuse`, `hostmaster`, `webmaster`, `noreply`, `no-reply`, `mailer-daemon`, `dmarc`, `security`, `support`, `info`, `femboyz`, `mail`, `mx`, … These are kept in one list in code.
- Impersonation and profanity filter: basic, editable list.

### Routes

| Method | Path | Description |
|---|---|---|
| ALL | `/oidc/*` | OIDC provider: discovery, authorize, token, userinfo, jwks, end_session |
| POST | `/api/v2/account/login` | Finish the OIDC login interaction (username + password). Uses `authlimit`. |
| POST | `/api/v2/account/request` | Request access: `{ email, note }`. Rate-limited, honeypot. |
| GET | `/api/v2/account/invite/:code` | Check an invite without spending it |
| GET | `/api/v2/account/available?name=` | Username availability (rate-limited) |
| POST | `/api/v2/account/signup/email-code` | Signup step 2: `{ invite, address }` sends a code (rate-limited per invite, address and IP) |
| POST | `/api/v2/account/signup` | `{ invite, username, password, external_email?: { address, code? } }`. The code is required unless the address equals the invite's request address. |
| GET | `/api/v2/account/me` | Logged-in account: username, external email, redirect state, quota usage |
| POST | `/api/v2/account/me/email` | `{ address }` sends a code to a new or replacement external address |
| POST | `/api/v2/account/me/email/verify` | `{ address, code }` verifies the address and makes it the external email; notifies the old address |
| DELETE | `/api/v2/account/me/email` | `{ password }` removes the external email and turns redirect off |
| PATCH | `/api/v2/account/me/redirect` | `{ enabled, keep_copy }`; requires a verified external email; updates the Sieve script in Stalwart |
| GET | `/api/v2/admin/account/requests` | List requests, filtered by status |
| POST | `/api/v2/admin/account/requests/:id/approve` · `/reject` | Approve (creates an invite and emails it) or reject |
| GET/POST/DELETE | `/api/v2/admin/account/invites[/:id]` | Manual invites |
| GET/PATCH/DELETE | `/api/v2/admin/account/users[/:id]` | List users, disable/enable (also in Stalwart), change quota, delete |

Static `/oidc` and `/api` routes take priority over Fastify's `/:id`, and upload IDs (`123XABCD`) can't collide with them.

Each protocol gets a doc in `schema/` (`frontend_account_*.md`, `mongo_user.md`, `mongo_account_request.md`, `mongo_invite.md`).

### Frontend (`client/`)

- `src/routes/login/+page.svelte`: login form, the invite-only note and a **Request access** button that opens a form for email + note.
- `src/routes/signup/+page.svelte`: invite landing page. Step 1 is username + password. Step 2 is the optional external email with a 4-digit code input (four boxes, paste-friendly, `autocomplete="one-time-code"`), with a resend button that shows the cooldown.
- `src/routes/account/+page.svelte`: account settings: external email (add, change, remove, verify), redirect switch with "keep a copy", quota usage. With `?embed=1` it renders without the site chrome so it can sit inside webmail. It needs a femboyz.cloud session, so a small `femboyz-web` OIDC client and session are pulled forward from phase 5.
- Layout: a **mail** button next to the logo that links to `mail.femboyz.cloud`. Later it shows the logged-in username.
- `/admin` gets new tabs: **Requests** (pending first, approve/reject), **Invites**, **Users**.
- i18n strings in `src/lib/lang`.

### Security checklist

- argon2id password hashes, at least 12 characters, rejecting the top 10k common passwords.
- Passwords are never logged: redact them in Pino.
- `authlimit` on login, invite checks, availability checks and requests.
- Cookies are `HttpOnly`, `Secure` and `SameSite=Lax`. CSRF protection on the interaction POSTs.
- OIDC client secrets and the provider's signing keys are generated once, stored in `.env.prod` / a key file, and rotatable.
- Run `/security-review` before merging phase 2.

### Config additions (`src/config.ts`)

The full list with defaults is in `src/config.ts` and `.env.temp`; production values are in DEPLOYMENT.md 14.2. Accounts are off unless `OIDC_ISSUER` is set, so the code deploys before the rollout.

### Tests

- Username rules and the reserved list.
- Invites under concurrency: one use only.
- Signup rollback when Stalwart rejects.
- Login rate limit.
- Request honeypot and rate limit.
- An OIDC token carries `aud=stalwart` and the right claims.
- Email codes:
  - expiry, the 5-attempt burn and single use;
  - a new code invalidating the old one;
  - per-account, per-address and cooldown limits;
  - the stored value being HMAC'd, not the plain code;
  - the request address being pre-verified at signup while a different address needs a code;
  - rejection of `@femboyz.cloud` and duplicate addresses.
- Redirect: the Sieve script is generated with and without `:copy`; it can't be enabled without a verified address; it is disabled when the address is removed.
- Mocked Stalwart and SMTP.

---

## 3. Mail infrastructure

### DNS at Namecheap (Advanced DNS)

Under **Mail Settings**, choose **Custom MX**. Otherwise Namecheap ignores or overrides MX records. Host fields are relative (`@`, `mx`, `_dmarc`).

| Type | Host | Value |
|---|---|---|
| A / AAAA | `mx` | VPS IPv4 / IPv6 |
| A / AAAA | `mail` | VPS IPv4 / IPv6 (already created) |
| MX | `@` | `mx.femboyz.cloud` (priority 10) |
| TXT | `@` | `v=spf1 mx -all` |
| TXT | `<selector>._domainkey` | DKIM public key generated by Stalwart (one record per algorithm) |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@femboyz.cloud`, then `quarantine`, then `reject` |
| TXT | `_mta-sts` + `_smtp._tls` | MTA-STS id + TLS-RPT (policy served at `mta-sts.femboyz.cloud`) |
| CNAME/SRV | `autoconfig`, `autodiscover`, `_imaps._tcp`, `_submissions._tcp` | Only when IMAP for mail apps is enabled |

- **Hetzner Cloud console:** set the reverse DNS (PTR) of the IPv4 and IPv6 to `mx.femboyz.cloud`.
- DNS stays manual, and DKIM auto-rotation is switched off (`dkimManagement: Manual`), because rotation needs automatic DNS. Stalwart 0.16 does list Namecheap as a DNS provider, but Namecheap's API needs account eligibility and a whitelisted IP. **Optional later:** use that, or move the nameservers to Cloudflare (free; Namecheap stays the registrar).
- The exact records, with the generated DKIM keys, are in `DEPLOYMENT.md` 13.10. Leave out the TLSA records from Stalwart's zone file: there's no DNSSEC, and certbot rotates the key on every renewal.

### TLS

nginx already runs certbot and owns ports 80/443, and Stalwart's own ACME stays off.
- `certbot certonly --nginx -d mx.femboyz.cloud` gives a separate certificate for mx. `mail.` gets its own in phase 3.
- A deploy hook (`deploy/mail/certbot-deploy-hook.sh`) copies just that lineage into `/etc/femboyz-mail/tls` as UID 2000 and restarts Stalwart. We don't mount `/etc/letsencrypt`: its keys are root-only, and it also holds the femboyz.cloud key.
- Stalwart loads the copy through a Certificate object with `File` references. It serves the copy on SMTP STARTTLS and on its HTTPS listener, and nginx verifies it when re-encrypting.

### Stalwart

- `deploy/mail/docker-compose.yml`:
  - Image `stalwartlabs/stalwart:v0.16`.
  - Publish 25, and `127.0.0.1:465` for the mailer (public 465/993 later).
  - HTTPS bound to `127.0.0.1:8443` behind nginx.
  - Volumes `/etc/stalwart` and `/var/lib/stalwart` (RocksDB).
  - `STALWART_PUBLIC_URL=https://mx.femboyz.cloud`.
- Bootstrap with `STALWART_RECOVERY_ADMIN`, run the wizard, save the permanent admin credential, remove the env var and close `:8080`. Done in phase 1, runbook in `DEPLOYMENT.md` section 13.
- Stalwart resolves DNS through a host **unbound** on the mail bridge gateway. Hetzner's shared resolvers are refused by Spamhaus, DNSWL and the other blocklists, which turns those spam checks off.
- **Directory:** user accounts for `femboyz.cloud` authenticate through an **OIDC directory** pointing at `https://femboyz.cloud/oidc`, with `claimUsername=preferred_username` and `usernameDomain=femboyz.cloud`. We pre-create each mailbox on signup through the JMAP API, with its quota. Stalwart **does** provision just-in-time on the first OIDC login it hasn't seen (`synchronize_account`), so any username our provider would issue maps onto a Stalwart account of that name. That makes the reserved username list a security boundary: it must hold every internal account and alias (`admin`, `noreply`, `femboyz-api`, `postmaster`, …), or a token for `admin` would land in the admin mailbox.
- System accounts `admin` (Stalwart admin role) and `noreply` are internal Stalwart accounts. `postmaster@`, `abuse@`, `dmarc@`, `hostmaster@` and `webmaster@` are aliases on `admin`. Once the OIDC directory is on, these accounts can't log in with a password (see below).
- Service API key: a dedicated account `femboyz-api` with `impersonate`, `sysAccountCreate`, `sysAccountUpdate`, `sysAccountDestroy`, `sysAccountGet`, `sysAccountQuery` and `sysDomainGet`. It has no password; an admin creates the key with `x:ApiKey/set` on its `accountId`.
- Backups: nightly snapshot of the Stalwart volumes next to the Mongo/storage backups. Do one restore drill.

**OIDC directory + internal accounts** (verified in the 0.16.27 source, phase 1). They coexist, with one catch:
- The community edition has **one directory for everything**: `Authentication.directoryId`. A per-domain `Domain.directoryId` is Enterprise-only.
- Recipient lookup still works for every local account. An OIDC directory can't look up recipients, so Stalwart falls back to its own accounts. Pre-created user mailboxes and the system accounts all receive mail.
- **Passwords stop working for internal accounts.** With an OIDC directory set, every username + password login is passed to that directory, which rejects it ("Unsupported credentials type for OIDC backend").
- These are still checked locally, before the directory: **app passwords** (password-style secrets beginning `app`), **API keys** (`Bearer API_…`), Stalwart's own OAuth tokens (fallback after OIDC), and the recovery admin.
- What this means for us:
  - `noreply@` submits SMTP with an **app password**, not its account password. An admin can create app passwords and API keys on another account even after the switch (`x:AppPassword/set` with its `accountId`), but no longer set passwords.
  - `admin@` gets an API key before the switch; the runbook (`stwjmap.py`, `STW_TOKEN`) uses it afterwards.
  - The backend's service credential is an **API key** on a dedicated account. That was already the plan.
  - The Stalwart WebUI admin becomes the admin's own **femboyz account**: signs in through our OIDC, then gets promoted with the admin role (the documented "external directory promotion"). `STALWART_RECOVERY_ADMIN` stays the break-glass login.
  - No femboyz accounts are needed for `noreply`/`postmaster`. `admin@` stays an internal mailbox, readable only through the WebUI as recovery admin, or through an app password if IMAP is ever enabled. It redirects to the admin's personal address anyway.
- Verified on the dev Stalwart (phase 2): our JWT is accepted for JMAP with the directory on; API key and recovery admin still work; app-password SMTP submission for `noreply@` works; disabling (withdrawing `authenticate`) refuses an already-issued token at once. Still open: Stalwart WebUI sign-in through OIDC and promoting the admin's own femboyz account.

### Bulwark

- Image `femboyz/bulwark:1.15.0-femboyz.4`, built from exact upstream 1.15.0 source plus `deploy/mail/bulwark/auto-sso.patch`, on `127.0.0.1:3100`. The patch removes the repeat-login SSO click; source and build instructions are preserved.
- Runtime configuration: `deploy/mail/bulwark.env.example`. Register each supported locale’s exact `https://mail.femboyz.cloud/<locale>/auth/callback`; the published image uses locale paths. Token authentication is `client_secret_post`.
- **femboyz theme** in `mail/theme/`, built into a Bulwark theme ZIP and pinned for all users. It maps tokens from `client/src/lib/styles/global.css` onto Bulwark's CSS variables:
  - `--color-primary`, `--color-accent`, `--color-ring` → `#c30f45`
  - `--color-background` → `#1b1a1a`
  - `--color-foreground` → `#fff0f3`
  - `--color-muted-foreground` → `#fff0f3bf`
  - Plus the site font, square corners and the `.fb-button` hover inversion. Dark only.

  The ZIP format isn't in Bulwark's docs; read the theme loader in Bulwark's source first.
- Logos go in `mail/branding/`, exported from `client/src/lib/assets`.
- **femboyz account shortcut**: Bulwark 1.15's managed sidebar app embeds `https://femboyz.cloud/account?embed=1` directly. Policy lives in `mail/config/policy.json`. The native frame preserves same-site cookies; the account page also has an **Open account** link to a separate tab. No plugin or token access is needed.
  - `/account` allows `frame-ancestors 'self' https://mail.femboyz.cloud`; Bulwark derives its frame origin policy from the managed app.

---

## 4. Phases

**Phase 0: prerequisites**
- [x] Hetzner outbound port 25 unblocked.
- [x] PTR of `167.233.218.194` → `mx.femboyz.cloud` (verified 2026-10-19).
- [x] Namecheap: Custom MX, `MX @ → mx.femboyz.cloud` (prio 10), `A mx` and `A mail` → `167.233.218.194`. No IPv6 on the server, so **no AAAA records**.
- [x] Blocklists: not listed on Spamhaus, Barracuda or SpamCop.
- [ ] Old `protonmail-verification` TXT on `femboyz.cloud`: confirm Proton mail isn't in use (the MX now points at the VPS), then delete it. (2026-10-19: `dig TXT femboyz.cloud` already returns nothing, so it is probably gone.)

VPS facts: Hetzner CX23 `femboyz-cloud-node-a`, IPv4 `167.233.218.194`, IPv4 only. Production layout is in `DEPLOYMENT.md`: admin user `ops` with sudo, app user `femboyz` with restricted sudo, Mongo compose in `/etc/femboyz-cloud/`.

**Phase 1: Stalwart, receive-only**

Run it the same way as Mongo: compose in `/etc/femboyz-mail/` (root-owned, mode 600 for secrets), driven from `ops` with sudo. Don't create a new login user and don't run it as `femboyz`. The container already runs as its own unprivileged UID 2000; named volumes get correct ownership automatically, and bind mounts need `chown 2000:2000`.

- [x] Compose, cert + renew hook, nginx `mx.` vhost, unbound resolver, bootstrap, domain, DKIM keys (2026-10-19, Stalwart 0.16.27). Port 25 is reachable from outside, and STARTTLS presents the Let's Encrypt cert.
- [x] System accounts `admin@` and `noreply@`. Aliases `postmaster@`, `abuse@`, `dmarc@`, `hostmaster@`, `webmaster@` on admin. `:8080` listener deleted, recovery admin removed. Credentials are in root-only `/etc/femboyz-mail/credentials.txt` until moved to the password manager.
- [x] Confirmed: no SRS, and no ARC sealing; redirects use the mailbox address as envelope sender. No native forwarding, so Sieve. OIDC directory + internal accounts coexist, but internal passwords stop working. See sections 2.1 and 3.
- [x] Admin redirect script installed (`redirect-admin`, spam-guarded, keeps a copy).
- [x] TXT records from `DEPLOYMENT.md` 13.10 added at Namecheap, resolving on 1.1.1.1 and 8.8.8.8 (2026-10-19).
- [x] Admin redirect activated (2026-10-19).
- [x] `noreply@` → Gmail via JMAP submission: accepted by Gmail (`250 OK`). Check "Show original" for SPF/DKIM/DMARC pass.
- [x] Test: external mail to `admin@` is redirected to the admin's Gmail (confirmed by the admin, 2026-10-19). `noreply@` → mail-tester.com scored **10/10**: SPF pass, SPF_HELO pass, DKIM valid and aligned, rDNS `mx.femboyz.cloud`, SpamAssassin −0.2.
- [x] Backups: nightly restic to Hetzner Object Storage (`femboyz-cloud-bucket/femboyz-mail`), encrypted, 7d/4w/6m retention; restore drill passed 2026-10-19 (`DEPLOYMENT.md` 13.13).

**Phase 2: femboyz accounts (this repo)**
- [x] `accounts.ts`, `oidc.ts`, `stalwart.ts`, `mailer.ts`, `emailcodes.ts`, `accountApi.ts`, plus schema docs and tests (vitest with an in-memory MongoDB, and a full OIDC code-flow test).
- [x] `/login`, `/signup` (with the external email step), request access, `/admin` tabs Requests / Invites / Users.
- [x] `/account` (external email + redirect) and the `femboyz-web` session.
- [x] Email codes and the redirect Sieve management, plus the bounce webhook.
- [x] Dev: Stalwart OIDC directory pointed at our issuer (`docker-compose.yml` `mail` profile, DEPLOYMENT.md 14.8).
- [x] Dev test: invite → signup → OIDC login → Stalwart accepts our JWT for JMAP → refresh → site session SSO. Request → approve; signup with the pre-verified address and with a code; add/change/remove the address; toggle redirect; three bounces turn it off. (2026-10-19)
- [x] Prod rollout per DEPLOYMENT.md 14: service/admin API keys, noreply app password, env, nginx, deploy, signed webhook and OIDC directory switch (2026-10-19).
- [x] Prod test: request → admin mailbox (Gmail redirect accepted) → approve → external invite → signup → OIDC/JMAP, refresh, site SSO, mail delivery, external-email changes, both forwarding modes, three real bounces, disable/delete token rejection. 16 checks passed; account DB and signing-key restore drill passed (2026-10-19, DEPLOYMENT.md 14.9).
- [x] Security review before merging: fixed six findings covering verification races, stale forwarding, JWT-safe deletion, signup activation and rollback. Regression coverage: 127 backend tests + 29 client preview tests; Svelte check/build and production CI passed. Security fixes merged in PR #2.

**Phase 3: webmail**
- [x] Bulwark 1.15.0 pinned container, theme, branding, nginx vhost, SSO env and webmail-only JMAP CORS (2026-10-19).
- [x] Mail button next to the logo on femboyz.cloud links to webmail.
- [x] Native managed femboyz account sidebar app embeds settings; Open account link provides the separate-tab fallback.
- [x] Production browser: logged-out visit → femboyz login → inbox; controlled message read; account iframe SSO; mobile view; logout clears webmail/provider/site sessions, fresh visit requires login. Backup/restore validates config, secrets, ownership and decryptable user settings (DEPLOYMENT.md 15.4).

**Phase 4: outbound for users + abuse controls**
- [x] Stalwart per-sender throttles, counted in recipients: 60/hour and 300/day for everyone, 20/hour and 100/day for accounts on the `femboyz-new-senders` list. The API keeps that list at accounts younger than `MAIL_NEW_SENDER_DAYS` (14). `noreply@` is exempt. Verified on dev and in production for webmail (JMAP) submission (2026-10-19, DEPLOYMENT.md 16.4).
- [x] Cap recipients per message: 25 for logged-in senders.
- [ ] ~~Spam-score outbound mail~~: not possible in Stalwart 0.16, which never classifies authenticated sessions. An rspamd milter is the option if it's ever needed (DEPLOYMENT.md 16.1).
- [ ] Google Postmaster Tools and Microsoft SNDS: the admin signs up personally (DEPLOYMENT.md 16.3).
- [ ] DMARC: `dmarc@*` added to Stalwart's report addresses, plus `deploy/mail/dmarc-summary.py`. Tighten `p=none` → `quarantine` → `reject` after clean reports (16.3).
- [x] Rules page `/terms`; signup requires ticking "I agree". `/admin` → Users already had **Disable** (one click + confirm) and now shows each account's sending tier. `abuse@` triage runbook in DEPLOYMENT.md 16.2.

**Phase 5: later**
- [ ] femboyz.cloud features that use the account (the `femboyz-web` session already exists from phase 2): uploads owned by users, a profile page.
- [ ] Password reset via the verified external email (4-digit code + new password). TOTP.
- [ ] IMAP/SMTP for desktop and phone mail apps through Stalwart app passwords. First verify that app passwords work for OIDC-directory accounts; otherwise issue them ourselves.

---

## 5. Repo layout changes

```text
MAIL_PLAN.md
deploy/mail/docker-compose.yml        stalwart + bulwark (pinned)
deploy/mail/bulwark.env.example
deploy/mail/nginx-mx.conf             mx. vhost (mail. / mta-sts. later)
deploy/mail/certbot-deploy-hook.sh    copies the mx cert to Stalwart (UID 2000)
deploy/mail/unbound-femboyz-mail.conf local resolver for DNS blocklists
deploy/mail/stwjmap.py                JMAP helper for the runbook
deploy/mail/admin-redirect.sieve      admin@ redirect template
deploy/mail/backup.sh + femboyz-mail-backup.{service,timer}  nightly restic backup to S3
DEPLOYMENT.md                         + mail section: DNS, PTR, certs, bootstrap, backups
mail/theme/  mail/branding/           Bulwark theme + logos
mail/config/policy.json               Managed account sidebar app and theme policy
DEPLOYMENT.md section 14             accounts rollout: Stalwart credentials, env, nginx, directory switch
src/accounts.ts  src/accountApi.ts  src/oidc.ts  src/oidckeygen.ts
src/emailcodes.ts  src/stalwart.ts  src/mailer.ts
data/common-passwords.txt             10k most common 12+ char passwords (SecLists, MIT)
schema/frontend_account_{login,signup,settings,admin}.md  schema/mongo_{user,account_request,invite}.md
client/src/routes/login/  client/src/routes/signup/  client/src/routes/account/  client/src/routes/admin/… (tabs)
client/src/lib/account/               API helper, 4-digit code input
src/tests/accounts.test.ts  src/tests/oidc.test.ts
docker-compose.yml (profile mail)     dev Stalwart
```

Mail containers run from `/etc/femboyz-mail/` and are upgraded by hand with pinned tags. GitHub Actions `deploy.sh` does not touch them.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| We now own authentication code | The protocol comes from `oidc-provider`. argon2id, rate limits, CSRF, a security review before launch, no custom crypto. |
| Mail lands in spam | PTR, SPF, DKIM, DMARC and MTA-STS done right. Receive-first rollout, slow warm-up. |
| A spammer account gets `femboyz.cloud` blocklisted, hurting the file site too | Invite-only with manual approval, new-account throttles, one-click disable |
| Login is down → webmail is unusable | Same VPS and process as the site anyway; Stalwart's own admin login stays internal |
| Redirect forwards spam, or gets rejected for failing SPF | Redirect only mail that passes the spam filter; SRS + ARC; auto-disable after repeated bounces |
| 4-digit codes are guessed, or used to spam someone's inbox | 5 attempts per code, 10-minute expiry, HMAC storage, per-account, per-address and per-IP limits |
| The request-access form is used for spam | Honeypot, per-IP limits, a cap on pending requests; add Cloudflare Turnstile if needed |
| Upstream changes break things | Pin minor tags, read changelogs, test on the dev box first |
| AGPL | Patched Bulwark source, license and build scripts are downloadable through its Source link |

## 7. Decided

| Question | Answer |
|---|---|
| Request notifications | `admin@femboyz.cloud`, redirected to the admin's external email |
| Default quota | 1 GiB |
| Invite expiry | 7 days |
| IMAP for mail apps | Not at launch (phase 5) |
| Rejected requests | Silent, no email |
| External email | Optional, verified with a 4-digit code; used for redirect and recovery |

## 8. Open questions

1. Should redirect keep a copy in the femboyz mailbox by default? The plan assumes **yes**.
2. Should requesters get a "your request was received" email? The plan assumes **no**: the only email a requester ever gets is the invite.

## References

- Stalwart Docker: https://stalw.art/docs/install/platform/docker/
- Stalwart OIDC directory: https://stalw.art/docs/auth/backend/oidc/
- Stalwart Account object: https://stalw.art/docs/ref/object/account/
- Stalwart DNS records: https://stalw.art/docs/domains/dns-records/
- Stalwart ACME challenges: https://stalw.art/docs/server/tls/acme/challenges/
- Stalwart app passwords: https://stalw.art/docs/auth/authentication/app-password
- Bulwark env reference: https://bulwarkmail.org/docs/getting-started/configuration/environment-reference
- Bulwark customization: https://bulwarkmail.org/docs/guides/customization
- oidc-provider: https://github.com/panva/node-oidc-provider
