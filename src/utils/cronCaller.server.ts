// Who is asking /api/bi/cron for a pass, when the answer is one of the two
// static tokens and needs no database round trip.
//
// FOUND FROM THE SURVEY (R95). The in-process scheduler used to be started only
// by this route, and the route's only regular caller was the notification bell,
// once, when a signed-in page mounted. So after every restart — the documented
// update command `docker compose up -d --build` included — nothing scheduled ran
// until somebody opened the app. server.mjs now makes the bell's call itself as
// each worker boots, in-process, carrying AGENTSWARMS_BOOT_TOKEN: a random value
// it generates per boot and that exists nowhere but this process group's
// environment. It buys exactly what a signed-in user's token buys — one pass -
// and never the forced pass that BI_CRON_TOKEN's external cron is trusted with.
import { timingSafeEqual } from "node:crypto";

export type CronCaller = "cron" | "boot";

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * "cron" for the operator's external cron, "boot" for this server starting its
 * own scheduler, null when the bearer is neither and must be checked as a user.
 */
export function staticCronCaller(
  bearer: string,
  env: { cronToken?: string | null; bootToken?: string | null },
): CronCaller | null {
  if (!bearer) return null;
  if (env.cronToken && sameSecret(bearer, env.cronToken)) return "cron";
  if (env.bootToken && sameSecret(bearer, env.bootToken)) return "boot";
  return null;
}
