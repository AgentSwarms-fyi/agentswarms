// Transport-agnostic outbound mailer for the self-hosted build.
//
// NO THIRD PARTY IS REQUIRED. SMTP is built in: `nodemailer` is a dependency
// of this package, so any mail relay you already have — a corporate
// Exchange, SES, a provider's free tier, a box in the next rack — works with
// four environment variables and no account anywhere. Resend is offered
// first only because it needs no relay at all, not because it is preferred.
//
// Picks the first configured transport, in this order:
//   1. RESEND_API_KEY  — Resend's HTTPS API, for deployments with no relay
//   2. SMTP_HOST       — any SMTP server, over nodemailer
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
  } catch (e) {
    // nodemailer is a dependency of this package, so reaching here means the
    // runtime could not load it rather than that the operator forgot to
    // install it. Telling them to `npm install nodemailer` sent people after
    // a problem they did not have; the real cause is a bundler or a runtime
    // that cannot do a dynamic import.
    return {
      sent: false,
      reason:
        "SMTP_HOST is set but nodemailer could not be loaded in this runtime: " +
        (e instanceof Error ? e.message : String(e)),
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
