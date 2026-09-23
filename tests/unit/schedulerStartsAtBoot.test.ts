// The in-process scheduler starts when the server does, not when somebody signs in.
//
// FOUND FROM THE SURVEY (R95). ensureScheduler() was only reached through
// /api/bi/cron, and the only regular caller of that was the notification bell,
// once, when a signed-in page mounted. After every restart nothing scheduled ran
// until someone opened the app.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { staticCronCaller } from "@/utils/cronCaller.server";

const srv = readFileSync("server.mjs", "utf8");
const route = readFileSync("src/routes/api/bi.cron.ts", "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("who may run a pass without being a user", () => {
  const env = { cronToken: "c".repeat(64), bootToken: "b".repeat(64) };

  it("recognises the external cron and the boot call, and nothing else", () => {
    expect(staticCronCaller("c".repeat(64), env)).toBe("cron");
    expect(staticCronCaller("b".repeat(64), env)).toBe("boot");
    expect(staticCronCaller("b".repeat(63), env)).toBeNull();
    expect(staticCronCaller("someone-else", env)).toBeNull();
    expect(staticCronCaller("", env)).toBeNull();
  });

  it("recognises neither when the tokens are unset, however empty the bearer", () => {
    expect(staticCronCaller("", {})).toBeNull();
    expect(staticCronCaller("anything", { cronToken: "", bootToken: null })).toBeNull();
  });

  it("only the external cron forces a pass; the boot call is a catch-up", () => {
    expect(flat(route)).toContain(
      'const result = await runCronPass({ force: caller === "cron" });',
    );
    expect(flat(route)).not.toContain("force: bearer === cronToken");
  });

  it("the route accepts the per-boot token alongside the operator's", () => {
    expect(flat(route)).toContain("bootToken: process.env.AGENTSWARMS_BOOT_TOKEN,");
    expect(flat(route)).toContain("let allowed = caller !== null;");
  });
});

describe("each worker starts its own scheduler as it boots", () => {
  it("mints a random per-boot token before any worker is forked", () => {
    const mint = srv.indexOf(
      'process.env.AGENTSWARMS_BOOT_TOKEN = randomBytes(32).toString("hex");',
    );
    expect(mint).toBeGreaterThan(-1);
    expect(mint).toBeLessThan(srv.indexOf("cluster.fork()"));
    expect(mint).toBeLessThan(srv.lastIndexOf("await startWorker();"));
  });

  it("calls the route in-process with it, unless scheduling is external", () => {
    const f = flat(srv);
    expect(f).toContain(
      'if (!/^(1|true|yes)$/i.test(process.env.DISABLE_INPROCESS_SCHEDULER ?? "")) {',
    );
    expect(f).toContain("new Request(`http://${HOSTNAME}:${PORT}/api/bi/cron`, {");
    expect(f).toContain("Authorization: `Bearer ${process.env.AGENTSWARMS_BOOT_TOKEN}`");
  });

  it("does not hold up the SIGTERM handler while that pass runs", () => {
    const start = srv.indexOf("void (async () => {");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(srv.indexOf('for (const signal of ["SIGTERM", "SIGINT"]) {'));
  });

  it("says so in the log either way, and what a failure means", () => {
    expect(srv).toContain("scheduler started; catch-up pass");
    // BOTH failure branches - a refused call and a thrown one - say what it means.
    const said =
      flat(srv).match(/scheduled work will wait for the first signed-in page load/g) ?? [];
    expect(said.length).toBe(2);
  });
});
