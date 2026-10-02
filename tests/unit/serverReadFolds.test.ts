// Two server-side reads whose failure became an answer.
//
// credentials.server: loadCredentialRowShared caught a failed read of the
// user's OWN credential as "no own credential", fell through to the grants,
// and the call then failed downstream with "No credentials configured. Add
// them in Provider Integrations." — the wrong reason, at the wrong place.
// getProviderDefaultModel folded the same read into "no default model", which
// silently changes which model a call uses.
//
// audit.functions: emailMap paged the Auth admin API and `break`-ed on error,
// so a failed page left the map short and the audit list attributed trace and
// swarm rows to an 8-character id where it should show a person — under an
// ok: true answer. adminSpendBreakdown did the same with three reads.
//
// The credential half is behavioural: the real functions against an admin
// client whose provider_credentials read fails. The audit half is
// source-anchored: the handlers are server functions.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const admin = vi.hoisted(() => ({
  responses: {} as Record<string, Resp>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const resp = admin.responses[table] ?? { data: [], error: null };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = () => Promise.resolve(resp);
      b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resp).then(res, rej);
      return b;
    },
  },
}));

const FAILED = { data: null, error: { message: "connection reset" } };

describe("loadCredentialRowShared, when the user's own credential cannot be read", () => {
  it("fails with the read's reason instead of 'no credentials configured'", async () => {
    admin.responses = { provider_credentials: FAILED };
    const { loadCredentialRowShared } = await import("@/utils/providers/credentials.server");
    await expect(loadCredentialRowShared("u1", "openai" as never)).rejects.toThrow(
      /connection reset/,
    );
  });

  it("still answers null when there genuinely is no credential anywhere", async () => {
    admin.responses = { provider_credentials: { data: null, error: null } };
    const { loadCredentialRowShared } = await import("@/utils/providers/credentials.server");
    await expect(loadCredentialRowShared("u1", "openai" as never)).resolves.toBeNull();
  });
});

describe("getProviderDefaultModel, when the credential read fails", () => {
  it("does not answer 'no default model' over a failed read", async () => {
    admin.responses = { provider_credentials: FAILED };
    const { getProviderDefaultModel } = await import("@/utils/providers/credentials.server");
    await expect(getProviderDefaultModel("u1", "openai" as never)).rejects.toThrow(
      /connection reset/,
    );
  });
});

describe("the audit handlers, when the user list cannot be read", () => {
  const SRC = readFileSync("src/utils/audit.functions.ts", "utf8");

  it("emailMap reports a failed page instead of stopping short", () => {
    const fn = SRC.slice(
      SRC.indexOf("async function emailMap("),
      SRC.indexOf("export type AuditRow"),
    );
    expect(fn).toMatch(/Promise<\{ map: Map<string, string>; error: string \| null \}>/);
    expect(fn).toMatch(
      /if \(error\) return \{ map, error: `could not list users for attribution: \$\{error\.message\}` \};/,
    );
    expect(fn).not.toMatch(/if \(error \|\| !data\.users\.length\) break;/);
  });

  it("the event list answers ok: false rather than attributing rows to ids", () => {
    expect(SRC).toMatch(
      /const people = await emailMap\(\);\s*if \(people\.error\) return \{ ok: false, error: people\.error \};\s*emails = people\.map;/,
    );
  });

  it("the spend breakdown answers ok: false for any of its four reads", () => {
    expect(SRC).toMatch(/if \(emails\.error\) return \{ ok: false, error: emails\.error \};/);
    expect(SRC).toMatch(
      /if \(groupsRes\.error\) return \{ ok: false, error: groupsRes\.error\.message \};/,
    );
    expect(SRC).toMatch(
      /if \(membersRes\.error\) return \{ ok: false, error: membersRes\.error\.message \};/,
    );
    expect(SRC).toMatch(/email: emails\.map\.get\(s\.user_id\) \?\? null,/);
  });
});
