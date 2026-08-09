// A headless turn must write its trace, because the budget cap reads that table.
//
// execution_traces is RLS'd to `auth.uid() = user_id`. Every trace insert went
// through the anon key carrying the caller's JWT — but a headless turn has no
// JWT. Deployed API keys, schedules, evals and public embeds authenticate with
// the internal run secret and a server-resolved `internalUserId`, so
// `auth.uid()` was null and Postgres refused every insert. The only evidence
// was a console line: "[trace] insert failed: new row violates row-level
// security policy for table execution_traces".
//
// The missing row is not the damage. budget_spend_since() SUMS
// execution_traces, so spend that never lands there is spend the monthly hard
// cap cannot see. Measured on this instance before the fix: four headless runs
// cost $0.0181 while budget_spend_since() reported $0.0000 for the same day.
// A deployed API key or a public embed could burn tokens forever without ever
// moving the number that is supposed to stop it — on exactly the two surfaces
// designed to be exposed to people who are not the account owner.
//
// Verified end to end by minting a key and calling /api/swarm/run:
//   with the fix     traces 2 -> 7,  budget $0.0000 -> $0.0080
//   mutation applied traces 7 -> 8,  budget $0.0080 -> $0.0080  (unbilled)
//
// This test pins the CHOICE OF CLIENT, which is the whole bug, by reading the
// source. The behaviour itself needs a live Postgres enforcing RLS plus a
// paid model call, so it is measured deliberately (above) rather than on every
// push.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chat = readFileSync(resolve("src/routes/api/chat.ts"), "utf8");

/** The statement that picks the client used to insert the trace row. */
function traceClientLine(): string {
  // Anchored on the assignment immediately before the "[trace] skipped — no
  // supabase client" guard, so it cannot drift onto one of the ~12 other
  // getServerSupabase call sites in this file.
  const i = chat.indexOf('console.warn("[trace] skipped — no supabase client")');
  expect(i, "the trace-writer guard moved; this test needs re-anchoring").toBeGreaterThan(0);
  const before = chat.slice(0, i);
  const start = before.lastIndexOf("const sb =");
  return before.slice(start).replace(/\s+/g, " ").trim();
}

describe("headless turns write their trace, so their spend is billable", () => {
  it("uses the service role when the run is internal and has no JWT", () => {
    const line = traceClientLine();
    expect(line).toContain("supabaseAdmin");
    expect(line).toMatch(/internalRun/);
  });

  it("still uses the caller's JWT for an ordinary signed-in turn", () => {
    // The service role must NOT become the blanket writer: a normal browser
    // turn should keep writing under its own identity so RLS stays meaningful.
    expect(traceClientLine()).toContain("getServerSupabase(trace.authToken)");
  });

  it("carries the internal-run flag onto the trace context", () => {
    expect(chat).toMatch(/internalRun\?:\s*boolean/);
    expect(chat).toMatch(/internalRun:\s*isInternalRun/);
  });

  it("only trusts internalUserId behind the internal secret", () => {
    // This is what makes writing as the service role safe: the id is resolved
    // by this server, never taken from the request body on its own. If this
    // ever stops being true, the fix above becomes a way to attribute spend
    // to an arbitrary account.
    const i = chat.indexOf("const isInternalRun");
    expect(i).toBeGreaterThan(0);
    const window = chat.slice(i, i + 400).replace(/\s+/g, " ");
    expect(window).toContain("internalSecretMatches");
    expect(window).toMatch(/isInternalRun\s*\?\s*\(?body\.internalUserId/);
  });
});
