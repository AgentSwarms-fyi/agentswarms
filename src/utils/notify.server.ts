// One chokepoint for user-facing alerts: the in-app notification row plus a
// best-effort mirror to every notification channel (Slack / Teams / Discord /
// generic webhook) the user has connected on the Integrations page.
//
// Channel delivery is strictly best-effort: a dead webhook must never fail the
// job that raised the alert (BI refresh, health check, schedule), so every
// failure is swallowed into a log line. The in-app row is written FIRST so the
// user always has the canonical copy even when every channel is down.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveIntegrationConfig } from "@/utils/providers/integrationConfig.server";

export type UserNotification = {
  title: string;
  body: string;
  link?: string;
  /** notifications.kind — "alert" fits system warnings; agents use "agent". */
  kind?: string;
};

export async function notifyUser(userId: string, n: UserNotification): Promise<void> {
  const { error } = await supabaseAdmin.from("notifications").insert({
    user_id: userId,
    kind: n.kind ?? "alert",
    title: n.title.slice(0, 200),
    body: n.body.slice(0, 2000),
    link: n.link ?? null,
  });
  if (error) console.warn("[notify] in-app insert failed:", error.message);
  await mirrorToChannels(userId, n);
}

/** Post to the user's connected channels; never throws. */
export async function mirrorToChannels(userId: string, n: UserNotification): Promise<void> {
  try {
    const { data: channels } = await supabaseAdmin
      .from("integrations")
      .select("id, provider, config")
      .eq("user_id", userId)
      .eq("type", "notification")
      .eq("is_active", true);
    if (!channels || channels.length === 0) return;
    const { postNotification } = await import("./integrations/testAdapters.server");
    await Promise.all(
      channels.map(async (ch) => {
        try {
          const cfg = (await resolveIntegrationConfig(
            userId,
            "notification",
            (ch.config ?? {}) as Record<string, unknown>,
          )) as { webhook_url?: string };
          if (!cfg.webhook_url) return;
          const res = await postNotification(ch.provider ?? "webhook", cfg.webhook_url, {
            title: n.title,
            body: n.body,
            link: n.link,
          });
          if (!res.ok) console.warn(`[notify] ${ch.provider} delivery failed: ${res.detail}`);
          // Stamp delivery health so the Integrations page can show a
          // "delivery failing" badge (channels are excluded from the
          // scheduled health pass — probing them would spam the channel).
          await stampChannelHealth(ch.id, res.ok, res.detail);
        } catch (e) {
          console.warn(`[notify] ${ch.provider} delivery errored:`, (e as Error).message);
          await stampChannelHealth(ch.id, false, (e as Error).message);
        }
      }),
    );
  } catch (e) {
    console.warn("[notify] channel mirror failed:", (e as Error).message);
  }
}

/** Merge health keys onto a fresh read of the channel row; never throws. */
async function stampChannelHealth(id: string, ok: boolean, detail: string): Promise<void> {
  try {
    const { data: fresh } = await supabaseAdmin
      .from("integrations")
      .select("config")
      .eq("id", id)
      .maybeSingle();
    if (!fresh) return;
    const cfg =
      fresh.config && typeof fresh.config === "object" && !Array.isArray(fresh.config)
        ? (fresh.config as Record<string, unknown>)
        : {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin.from("integrations") as any)
      .update({
        config: {
          ...cfg,
          health_status: ok ? "ok" : "error",
          health_detail: detail.slice(0, 300),
          health_checked_at: new Date().toISOString(),
        },
      })
      .eq("id", id);
  } catch {
    /* best-effort */
  }
}
