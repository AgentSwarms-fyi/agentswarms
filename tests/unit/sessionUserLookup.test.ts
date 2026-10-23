// The browser's own "who is signed in", without a round trip that can fail.
//
// FOUND IN R297, FIXED IN R298. Browser code asked supabase.auth.getUser() -
// a request to the auth server - and read any failure as "nobody". Driven with
// that one request failing: Save in the skill editor toasted "Not signed in"
// and saved nothing, and "Duplicate to my skills" did nothing at all, no
// toast, while the person was signed in. The SQL engine, which decides by the
// caller's id which tables are shared with them, read a shared dataset as
// their own - which RLS no longer serves - so it came back empty.
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string } },
  getUserCalls: 0,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: auth.session }, error: null }),
      getUser: async () => {
        auth.getUserCalls++;
        return { data: { user: null }, error: new Error("Failed to fetch") };
      },
    },
  },
}));

const { sessionUser } = await import("@/lib/sessionUser");

beforeEach(() => {
  auth.session = null;
  auth.getUserCalls = 0;
});

describe("sessionUser", () => {
  it("reads the signed-in user from the stored session, asking the auth server nothing", async () => {
    auth.session = { user: { id: "u-1", email: "a@example.com" } };
    expect(await sessionUser()).toEqual({ id: "u-1", email: "a@example.com" });
    expect(auth.getUserCalls).toBe(0);
  });

  it("is null only when there is no session", async () => {
    expect(await sessionUser()).toBeNull();
  });
});

describe("the browser code that asked the auth server", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("reads the session instead, everywhere it did", () => {
    for (const f of [
      "src/components/skills/SkillEditorDialog.tsx",
      "src/lib/sqlEngine.ts",
      "src/lib/swarmRuntime.ts",
      "src/routes/_authenticated/dashboard.tsx",
      "src/routes/_authenticated/skills.tsx",
    ]) {
      const src = read(f);
      expect(src, f).not.toContain("auth.getUser(");
      expect(src, f).toContain("sessionUser()");
    }
  });

  it("the SQL engine takes the caller's id from the session", () => {
    expect(read("src/lib/sqlEngine.ts")).toContain(
      "const myId = (await sessionUser())?.id ?? null;",
    );
  });

  it("Duplicate to my skills says so when nobody is signed in, instead of doing nothing", () => {
    expect(read("src/routes/_authenticated/skills.tsx")).toMatch(
      /const user = await sessionUser\(\);[\s\S]{0,120}if \(!user\) \{\s*toast\.error\("Not signed in"\);\s*return;\s*\}/,
    );
  });
});
