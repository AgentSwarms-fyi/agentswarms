// Transport-agnostic outbound mailer for the self-hosted build.
//
// Picks the first configured transport, in this order:
//   1. RESEND_API_KEY  — Resend's HTTPS API
//   2. SMTP_HOST       — SMTP via nodemailer (Node/Docker deployments only;
//                        `npm install nodemailer` if it isn't already present)
//   3. none            — no-op: the send is logged and skipped. The app must
//                        keep working without any mailer configured.
//
// The From address comes from EMAIL_FROM, e.g. `AgentSwarms <noreply@your-domain.com>`.

export interface MailArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Extra SMTP headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface MailResult {
  sent: boolean;
  /** Present when the send was skipped (no transport) or failed. */
  reason?: string;
}

function fromAddress(): string {
  return process.env.EMAIL_FROM || "AgentSwarms <noreply@example.com>";
}

export function isMailerConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.SMTP_HOST);
}

async function sendViaResend(args: MailArgs): Promise<MailResult> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
      headers: args.headers,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { sent: false, reason: `Resend ${res.status}: ${body.slice(0, 300)}` };
  }
  return { sent: true };
}

async function sendViaSmtp(args: MailArgs): Promise<MailResult> {
  let nodemailer: {
    createTransport: (opts: Record<string, unknown>) => {
      sendMail: (mail: Record<string, unknown>) => Promise<unknown>;
    };
  };
  try {
    // @vite-ignore keeps the bundler from trying to resolve this at build time;
    // it resolves at runtime on Node when nodemailer is installed.
    nodemailer =
      (await import(/* @vite-ignore */ "nodemailer")).default ??
      (await import(/* @vite-ignore */ "nodemailer"));
  } catch {
    return {
      sent: false,
      reason:
        "SMTP_HOST is set but nodemailer is not available in this runtime. " +
        "Run `npm install nodemailer` (Node deployments), or use RESEND_API_KEY instead.",
    };
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  try {
    await transport.sendMail({
      from: fromAddress(),
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      headers: args.headers,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Send an email through whichever transport is configured.
 * Never throws — callers treat email as best-effort.
 */
export async function sendMail(args: MailArgs): Promise<MailResult> {
  try {
    if (process.env.RESEND_API_KEY) return await sendViaResend(args);
    if (process.env.SMTP_HOST) return await sendViaSmtp(args);
    console.log(
      `[mailer] No mailer configured (set RESEND_API_KEY or SMTP_HOST) — skipping email "${args.subject}" to ${args.to}`,
    );
    return { sent: false, reason: "no_mailer_configured" };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
