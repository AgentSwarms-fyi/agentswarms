// "You are not signed in" when it was the check that failed.
//
// FOUND IN R295, FIXED IN R297. Every server function and API route asks the
// auth server whose token it was handed, and read ANY error from that question
// as a refusal: a network blip, a rate limit or an auth outage told a signed-in
// person "Unauthorized" or "Not signed in". src/utils/callerLookup.server.ts
// tells the two apart from supabase-js's own error classes; every server-side
// lookup goes through it now.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  AuthApiError,
  AuthInvalidJwtError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  callerFailure,
  callerFailureStatus,
  checkFailed,
  isCallerRefusal,
} from "@/utils/callerLookup.server";

const CHECK_FAILED =
  /^Could not check who you are just now \(.+\)\. Nothing was done; try again in a moment\.$/;

describe("telling a refusal from a lookup that failed", () => {
  it("a refusal keeps the call site's own message, and 401", () => {
    for (const e of [
      null,
      new AuthSessionMissingError(),
      new AuthApiError("invalid JWT: unable to parse or verify signature", 401, "bad_jwt"),
      new AuthApiError("User from sub claim in JWT does not exist", 403, "user_not_found"),
      // getClaims reading a junk token: found by the drive, after a first
      // version answered it with 503.
      new AuthInvalidJwtError("Invalid JWT structure"),
    ]) {
      expect(isCallerRefusal(e)).toBe(true);
      expect(callerFailure(e, "Not signed in")).toBe("Not signed in");
      expect(callerFailureStatus(e)).toBe(401);
    }
  });

  it("a helper answering user-or-null hears about a failed check, and only that", () => {
    expect(checkFailed(new AuthRetryableFetchError("fetch failed", 0))).toEqual({
      checkFailed: expect.stringMatching(CHECK_FAILED),
    });
    expect(checkFailed(null)).toBeNull();
    expect(checkFailed(new AuthApiError("invalid JWT", 401, "bad_jwt"))).toBeNull();
  });

  it("a lookup that failed says so, and 503", () => {
    for (const e of [
      new AuthRetryableFetchError("fetch failed", 0),
      new AuthRetryableFetchError("Bad Gateway", 502),
      new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"),
      new AuthApiError("Internal Server Error", 500),
      new Error("socket hang up"),
    ]) {
      expect(isCallerRefusal(e)).toBe(false);
      expect(callerFailure(e, "Not signed in")).toMatch(CHECK_FAILED);
      expect(callerFailureStatus(e)).toBe(503);
    }
  });
});

// One real server function end to end, with the framework's builder and the
// admin client faked.
const auth = vi.hoisted(() => ({ reply: { data: { user: null }, error: null } as unknown }));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      inputValidator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (h: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        h({ data: validate(opts.data) }),
    };
    return b;
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: { getUser: async () => auth.reply },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: null, error: null });
      return q;
    },
  },
}));

describe("a server function whose caller could not be looked up", () => {
  const call = async () => {
    const { biReportGet } = await import("@/utils/biReports.functions");
    return (biReportGet as unknown as (o: { data: unknown }) => Promise<unknown>)({
      data: { accessToken: "t", id: "83538a80-b309-44aa-a56d-78cb087a6f50" },
    });
  };

  it("says the check failed, not that the caller is signed out", async () => {
    auth.reply = { data: { user: null }, error: new AuthRetryableFetchError("fetch failed", 0) };
    await expect(call()).rejects.toThrow(CHECK_FAILED);
  });

  it("still refuses a token the auth server refused", async () => {
    auth.reply = { data: { user: null }, error: new AuthApiError("invalid JWT", 401, "bad_jwt") };
    await expect(call()).rejects.toThrow(/^Not signed in$/);
  });
});

// The sweep: every server-side lookup, so the next one cannot slip back.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// No exemptions since R298: the browser reads its own session (lib/sessionUser),
// so a getUser anywhere in src is a lookup that must say which kind of "no" it got.
describe("every caller lookup, server or browser", () => {
  const files = walk("src").filter((f) => /\.(ts|tsx)$/.test(f));
  // Both questions: getUser asks the auth server; getClaims verifies the JWT
  // and falls back to asking it, so it can fail the same way.
  const sites = files.flatMap((f) => {
    const src = readFileSync(f, "utf8");
    const out: { f: string; around: string }[] = [];
    for (const call of ["auth.getUser(", "auth.getClaims("]) {
      let at = src.indexOf(call);
      while (at !== -1) {
        out.push({ f, around: src.slice(Math.max(0, at - 300), at + 700) });
        at = src.indexOf(call, at + 1);
      }
    }
    return out;
  });

  it("finds them", () => {
    expect(sites.length).toBeGreaterThan(70);
  });

  it("goes through callerLookup, or says at the site why it need not", () => {
    const loose = sites
      .filter(
        ({ around }) =>
          // The message, not only the status: a site that answered 503 with
          // its old "Unauthorized" still told a signed-in person they are not.
          !/callerFailure\(|isCallerRefusal\(|checkFailed\(|\/\/ caller-lookup: /.test(around),
      )
      .map(({ f }) => f);
    expect(loose).toEqual([]);
  });
});

describe("helpers that answer user-or-null pass a failed check on", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("Agent Chat answers 503 instead of running the turn ungoverned", () => {
    const chat = read("src/routes/api/chat.ts");
    const helper = chat.slice(chat.indexOf("async function getUserIdFromRequest("));
    expect(helper.slice(0, 900)).toMatch(
      /const failed = checkFailed\(error\);\s*if \(failed\) return failed;/,
    );
    expect(chat).toMatch(
      /if \(caller !== null && typeof caller === "object"\) \{\s*return new Response\(JSON\.stringify\(\{ error: caller\.checkFailed \}\), \{\s*status: 503,/,
    );
  });

  it("A2A answers 503", () => {
    const a2a = read("src/routes/api/a2a.ts");
    expect(a2a).toMatch(/const failed = checkFailed\(error\);\s*if \(failed\) return failed;/);
    expect(a2a).toContain(
      'if (typeof userId !== "string") return jsonResponse({ error: userId.checkFailed }, 503);',
    );
  });

  it("the notebook runtime's caller, and every route that uses it, answer 503", () => {
    expect(read("src/utils/notebookRuntime/caller.server.ts")).toMatch(
      /const failed = checkFailed\(error\);\s*if \(failed\) return failed;/,
    );
    const routes = walk(join("src", "routes", "api")).filter((f) =>
      read(f).includes("await resolvePythonCaller(request)"),
    );
    expect(routes.length).toBeGreaterThanOrEqual(6);
    for (const f of routes) {
      expect(read(f), f).toMatch(
        /if \("checkFailed" in caller\) return json\((503, \{ error: caller\.checkFailed \}|\{ error: caller\.checkFailed \}, 503)\);/,
      );
    }
  });
});
