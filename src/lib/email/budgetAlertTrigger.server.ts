// Server-only helper that checks a user's month-to-date AI spend against
// their budget_settings cap and enqueues a "budget-alert" transactional
// email when a threshold (e.g. 50/75/90%) is crossed for the first time
// this month, or when the hard cap is first reached this month.
//
// Per-month idempotency is tracked via:
//   - budget_settings.notified_thresholds        INT[]   thresholds already emailed this period
//   - budget_settings.notified_period            DATE    first-of-month the thresholds array covers
//   - budget_settings.cap_exceeded_notified_period DATE  month the "exceeded" email was sent
//
// Designed to be called fire-and-forget from recordGatewayCall — it must
// never throw and never block the caller's request.

import * as React from "react";
import { render } from "@react-email/components";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { sendMail } from "@/lib/email/mailer.server";
import { monthStartIso, spendSince } from "@/utils/budgetSpend.server";

// Self-hosted: the instance's public URL (used for links inside the email).
const SITE_URL = process.env.SITE_URL || "http://localhost:8080";
const TEMPLATE_NAME = "budget-alert";

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function firstOfMonth(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

async function enqueueBudgetEmail(args: {
  userId: string;
  email: string;
  displayName: string | null;
  monthlyCapUsd: number;
  spentUsd: number;
  percentUsed: number;
  kind: "threshold" | "exceeded";
}) {
  const sb = supabaseAdmin;
  const normalized = args.email.toLowerCase();

  // Suppression check
  const { data: suppressed } = await sb
    .from("suppressed_emails")
    .select("id")
    .eq("email", normalized)
    .maybeSingle();
  if (suppressed) return;

  // Unsubscribe token (one per email)
  let unsubscribeToken: string;
  const { data: existing } = await sb
    .from("email_unsubscribe_tokens")
    .select("token, used_at")
    .eq("email", normalized)
    .maybeSingle();
  if (existing?.used_at) return;
  if (existing?.token) {
    unsubscribeToken = existing.token;
  } else {
    unsubscribeToken = generateToken();
    await sb
      .from("email_unsubscribe_tokens")
      .upsert(
        { token: unsubscribeToken, email: normalized },
        { onConflict: "email", ignoreDuplicates: true },
      );
    const { data: stored } = await sb
      .from("email_unsubscribe_tokens")
      .select("token")
      .eq("email", normalized)
      .maybeSingle();
    if (!stored?.token) return;
    unsubscribeToken = stored.token;
  }

  const entry = TEMPLATES[TEMPLATE_NAME];
  if (!entry) return;
  const data = {
    siteName: "AgentSwarms",
    siteUrl: SITE_URL,
    recipient: args.displayName || normalized.split("@")[0] || "there",
    monthlyCapUsd: args.monthlyCapUsd,
    spentUsd: args.spentUsd,
    percentUsed: args.percentUsed,
    kind: args.kind,
  };
  const element = React.createElement(entry.component, data);
  const html = await render(element);
  const text = await render(element, { plainText: true });
  const subject = typeof entry.subject === "function" ? entry.subject(data) : entry.subject;

  const messageId = crypto.randomUUID();

  // Send directly via the configured mailer (Resend / SMTP / no-op).
  // Per-month idempotency is already enforced by the caller via
  // budget_settings.notified_* columns, so no queue is needed here.
  const result = await sendMail({
    to: args.email,
    subject,
    html,
    text,
    headers: {
      "List-Unsubscribe": `<${SITE_URL}/email/unsubscribe?token=${unsubscribeToken}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });

  await sb.from("email_send_log").insert({
    message_id: messageId,
    template_name: TEMPLATE_NAME,
    recipient_email: args.email,
    status: result.sent ? "sent" : result.reason === "no_mailer_configured" ? "skipped" : "failed",
    error_message: result.sent ? null : result.reason,
  });
  if (!result.sent && result.reason !== "no_mailer_configured") {
    console.error("[budgetAlertTrigger] send failed:", result.reason);
  }
}

export async function checkAndNotifyBudget(userId: string): Promise<void> {
  if (!userId) return;
  try {
    const sb = supabaseAdmin;

    // 1. Load (or create) the user's budget settings.
    let { data: budget } = await sb
      .from("budget_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (!budget) {
      const { data: created } = await sb
        .from("budget_settings")
        .insert({ user_id: userId })
        .select("*")
        .maybeSingle();
      budget = created;
    }
    if (!budget || !budget.alerts_enabled) return;

    const cap = Number(budget.monthly_cap_usd ?? 0);
    if (cap <= 0) return;

    // 2. Month-to-date spend, through the shared aggregate.
    //
    // This used to SELECT every trace row for the month and add cost_usd up
    // here, reading the result as `traces ?? []`. A statement timeout — or any
    // error — therefore produced an empty array, which sums to $0, which is
    // 0% of the cap, which fires no alert and returns silently. The one path
    // whose entire job is to warn you would go quiet exactly when spend was
    // high enough to make the query slow.
    //
    // budgetGuard was fixed for this and the alert path was missed, which is
    // its own lesson: the same wrong idiom existed in five places and fixing
    // the one I was looking at did not fix the others.
    const result = await spendSince({ userId, since: monthStartIso() });
    if (!result.ok) {
      console.warn(`[budget-alert] spend lookup failed for ${userId}: ${result.error}`);
      return;
    }
    const mtd = result.spend;
    const pct = (mtd / cap) * 100;

    // 3. Reset per-period dedupe state if month rolled.
    const period = firstOfMonth();
    const samePeriod = budget.notified_period === period;
    const notified: number[] = samePeriod
      ? ((budget.notified_thresholds as number[] | null) ?? [])
      : [];
    const capExceededAlreadySent = budget.cap_exceeded_notified_period === period;

    // 4. Determine which alerts to fire.
    const thresholdsToFire: number[] = [];
    const sortedThresholds = [...((budget.alert_thresholds as number[] | null) ?? [])]
      .filter((t) => typeof t === "number" && t > 0 && t < 100)
      .sort((a, b) => a - b);
    for (const t of sortedThresholds) {
      if (pct >= t && !notified.includes(t)) thresholdsToFire.push(t);
    }
    const fireExceeded = pct >= 100 && !capExceededAlreadySent;

    if (thresholdsToFire.length === 0 && !fireExceeded) return;

    // 5. Look up recipient email + display name.
    const { data: authUser } = await sb.auth.admin.getUserById(userId);
    const email = authUser?.user?.email;
    if (!email) return;
    const { data: profile } = await sb
      .from("profiles")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    const displayName = (profile?.display_name as string | null) ?? null;

    // 6. Send the highest-crossed threshold (avoid spamming when several cross at once),
    //    and/or the "exceeded" email.
    if (thresholdsToFire.length > 0) {
      const top = thresholdsToFire[thresholdsToFire.length - 1];
      await enqueueBudgetEmail({
        userId,
        email,
        displayName,
        monthlyCapUsd: cap,
        spentUsd: mtd,
        percentUsed: pct,
        kind: "threshold",
      });
      // Persist that we've now notified every threshold up to and including `top`.
      const merged = Array.from(new Set([...notified, ...thresholdsToFire]));
      await sb
        .from("budget_settings")
        .update({
          notified_thresholds: merged,
          notified_period: period,
        })
        .eq("id", budget.id);
      // top is used by the upcoming exceeded branch via merged state.
      void top;
    }
    if (fireExceeded) {
      await enqueueBudgetEmail({
        userId,
        email,
        displayName,
        monthlyCapUsd: cap,
        spentUsd: mtd,
        percentUsed: pct,
        kind: "exceeded",
      });
      await sb
        .from("budget_settings")
        .update({ cap_exceeded_notified_period: period })
        .eq("id", budget.id);
    }
  } catch (e) {
    console.error("[checkAndNotifyBudget] failed:", e);
  }
}
