import nodemailer, { type Transporter } from "nodemailer"
import { envs, site_origin } from "./config.js"
import { errorFileLogger, scope } from "./logger.js"

const scopelog = scope("mailer")

export type MailMessage = { to: string, subject: string, text: string, html: string }

let transport: Transporter | null = null

// Without SMTP_HOST (dev) messages are only logged, codes and links included.
function transport_get(): Transporter | null {
    if (!envs.SMTP_HOST) {
        if (process.env.NODE_ENV === "prod") throw Object.assign(new Error("SMTP_HOST is required in production"), { statusCode: 503 })
        return null
    }
    transport ??= nodemailer.createTransport({
        host: envs.SMTP_HOST,
        port: envs.SMTP_PORT,
        secure: envs.SMTP_SECURE,
        requireTLS: true,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
        ...(envs.SMTP_USER ? { auth: { user: envs.SMTP_USER, pass: envs.SMTP_PASS ?? "" } } : {}),
        tls: {
            ...(envs.SMTP_TLS_SERVERNAME ? { servername: envs.SMTP_TLS_SERVERNAME } : {}),
            rejectUnauthorized: !envs.SMTP_TLS_INSECURE
        }
    })
    return transport
}

/** Sends one message. Throws on failure; callers decide whether that fails their request. */
export async function mail_send(message: MailMessage): Promise<void> {
    const smtp = transport_get()
    if (!smtp) {
        scopelog.info(`[not sent, SMTP_HOST unset] to ${message.to}: ${message.subject}\n${message.text}`)
        return
    }
    try {
        await smtp.sendMail({ from: envs.MAIL_FROM, ...message })
        scopelog.info(`Sent "${message.subject}" to ${message.to}`)
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        scopelog.error(`Failed to send "${message.subject}" to ${message.to}: ${reason}`)
        errorFileLogger.error({ err }, `Failed to send mail "${message.subject}" to ${message.to}`)
        throw Object.assign(new Error("Mail delivery failed"), { statusCode: 502 })
    }
}

// ---- TEMPLATES ----

function escape_html(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function layout(paragraphs: string[], action?: { label: string, url: string }): string {
    const body = paragraphs.map(text => `<p style="margin:0 0 1em">${escape_html(text).replace(/\n/g, "<br>")}</p>`).join("")
    const button = action
        ? `<p style="margin:1.5em 0"><a href="${escape_html(action.url)}" style="background:#c30f45;color:#fff;padding:.75em 1.25em;text-decoration:none;font-weight:700">${escape_html(action.label)}</a></p>`
        : ""
    return `<!DOCTYPE html><html><body style="margin:0;padding:2em;background:#060606;color:#fff0f3;font-family:Inter,system-ui,sans-serif;font-size:15px;line-height:1.5">`
        + `<div style="max-width:32em">${body}${button}<p style="color:#fff0f3bf;font-size:13px">femboyz.cloud</p></div></body></html>`
}

export function mail_request_notification(request: { id: string, email: string, note: string }): MailMessage {
    const url = `${site_origin()}/admin?tab=requests&id=${encodeURIComponent(request.id)}`
    const note = request.note || "(no note)"
    return {
        to: envs.ADMIN_NOTIFY_EMAIL,
        subject: `Access request from ${request.email}`,
        text: `New access request.\n\nEmail: ${request.email}\nNote: ${note}\n\nReview it: ${url}\n`,
        html: layout([`New access request.`, `Email: ${request.email}\nNote: ${note}`], { label: "Review request", url })
    }
}

export function mail_invite(to: string, link: string, expires: string): MailMessage {
    const until = new Date(expires).toUTCString()
    return {
        to,
        subject: "Your femboyz.cloud invite",
        text: `You're invited to femboyz.cloud. Create your account and @${envs.MAIL_DOMAIN} mailbox here:\n\n${link}\n\n`
            + `The link works once and expires ${until}.\n`,
        html: layout([
            `You're invited to femboyz.cloud. Create your account and @${envs.MAIL_DOMAIN} mailbox with the button below.`,
            `The link works once and expires ${until}.`
        ], { label: "Create account", url: link })
    }
}

export function mail_email_code(to: string, code: string): MailMessage {
    const text = `Your femboyz.cloud verification code is ${code}.\n\nIt expires in ${envs.EMAIL_CODE_TTL_MINUTES} minutes. `
        + `If you didn't ask for it, ignore this email.\n`
    return {
        to,
        subject: `${code} is your femboyz.cloud code`,
        text,
        html: layout([
            `Your femboyz.cloud verification code is`,
            code,
            `It expires in ${envs.EMAIL_CODE_TTL_MINUTES} minutes. If you didn't ask for it, ignore this email.`
        ])
    }
}

export function mail_external_email_changed(to: string, username: string, new_address: string | null): MailMessage {
    const what = new_address === null
        ? `was removed from the femboyz.cloud account ${username}.`
        : `was replaced on the femboyz.cloud account ${username} by ${new_address}.`
    const text = `This address ${what}\n\nIf you didn't do this, reply to admin@${envs.MAIL_DOMAIN}.\n`
    return {
        to,
        subject: "Your femboyz.cloud external email changed",
        text,
        html: layout([`This address ${what}`, `If you didn't do this, reply to admin@${envs.MAIL_DOMAIN}.`])
    }
}

export function mail_redirect_disabled(to: string, external: string): MailMessage {
    const text = `Mail forwarding to ${external} was turned off because messages sent there kept bouncing.\n\n`
        + `Your mail is still delivered to this mailbox. You can turn forwarding back on at ${site_origin()}/account.\n`
    return {
        to,
        subject: "Mail forwarding was turned off",
        text,
        html: layout([
            `Mail forwarding to ${external} was turned off because messages sent there kept bouncing.`,
            `Your mail is still delivered to this mailbox. You can turn forwarding back on from your account page.`
        ], { label: "Account settings", url: `${site_origin()}/account` })
    }
}
