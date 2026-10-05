// Writes to Postgres never carry U+0000.
//
// FOUND IN R279/R300, FIXED IN R301. Postgres refuses NUL in text and jsonb
// with "unsupported Unicode escape sequence", and the character is invisible
// in an input. Driven: a notebook title holding one stayed "Unsaved changes"
// with "Save failed: unsupported Unicode escape sequence"; a BI report whose
// header band held one could not be saved (the server's admin client). Every
// Supabase client now sends its PostgREST requests through nulSafeFetch, which
// strips the character from the JSON body of writes and leaves everything else
// alone.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  nulSafeFetch,
  withNulSafeFetch,
  withoutNulDeep,
} from "@/integrations/supabase/nulSafeFetch";

const sent: { url: string; init?: RequestInit }[] = [];
afterEach(() => {
  sent.length = 0;
  vi.unstubAllGlobals();
});
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), init });
      return new Response("{}");
    }),
  );
}

const REST = "https://x.supabase.co/rest/v1/user_python_notebooks?id=eq.1";

describe("withoutNulDeep", () => {
  it("removes NUL from strings and keys at any depth, and nothing else", () => {
    expect(
      withoutNulDeep({
        "ti\u0000tle": "R301 pro\u0000be",
        cells: [{ src: "a\u0000", n: 1 }],
        ok: true,
      }),
    ).toEqual({ title: "R301 probe", cells: [{ src: "a", n: 1 }], ok: true });
    expect(withoutNulDeep(null)).toBeNull();
  });
});

describe("nulSafeFetch", () => {
  it("cleans the JSON body of a write to PostgREST", async () => {
    stubFetch();
    const body = JSON.stringify({ title: "R301 pro\u0000be" });
    await nulSafeFetch(REST, { method: "PATCH", body });
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({ title: "R301 probe" });
  });

  it("cleans inserts, upserts and RPC arguments too", async () => {
    stubFetch();
    await nulSafeFetch("https://x/rest/v1/rpc/save_it", {
      method: "POST",
      body: JSON.stringify({ args: ["x\u0000"] }),
    });
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({ args: ["x"] });
  });

  it("sends anything else exactly as it was", async () => {
    stubFetch();
    const withNul = JSON.stringify({ a: "x\u0000" });
    const clean = JSON.stringify({ title: "fine" });
    await nulSafeFetch("https://x/auth/v1/token", { method: "POST", body: withNul });
    await nulSafeFetch("https://x/storage/v1/object/b/k", { method: "PUT", body: withNul });
    await nulSafeFetch(REST, { method: "PATCH", body: clean });
    await nulSafeFetch(REST, { method: "PATCH", body: "not json \\u0000" });
    await nulSafeFetch(REST, { method: "GET" });
    expect(sent.map((s) => s.init?.body)).toEqual([
      withNul,
      withNul,
      clean,
      "not json \\u0000",
      undefined,
    ]);
  });

  it("keeps the literal text \\u0000, which is not a NUL", async () => {
    stubFetch();
    const body = JSON.stringify({ code: "print('\\u0000')" });
    await nulSafeFetch(REST, { method: "PATCH", body });
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({ code: "print('\\u0000')" });
  });
});

describe("withNulSafeFetch", () => {
  it("adds the fetch and keeps the client's own headers and options", () => {
    const o = withNulSafeFetch({
      auth: { persistSession: false },
      global: { headers: { Authorization: "Bearer t" } },
    });
    expect(o.global.fetch).toBe(nulSafeFetch);
    expect((o.global as { headers?: object }).headers).toEqual({ Authorization: "Bearer t" });
    expect(o.auth).toEqual({ persistSession: false });
    expect(withNulSafeFetch().global.fetch).toBe(nulSafeFetch);
  });
});

// Every supabase-js client in src, by syntax tree: the next one cannot slip by.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("every Supabase client", () => {
  const calls: { file: string; options: string }[] = [];
  for (const file of walk("src")) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("@supabase/supabase-js") || !text.includes("createClient")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createClient"
      ) {
        calls.push({ file, options: node.arguments[2]?.getText(sf) ?? "" });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  it("finds them", () => {
    expect(calls.length).toBeGreaterThan(45);
  });

  it("sends its writes through nulSafeFetch", () => {
    const loose = calls.filter(
      (c) =>
        !c.options.startsWith("withNulSafeFetch(") &&
        !/global:\s*\{\s*fetch:\s*nulSafeFetch\s*\}/.test(c.options),
    );
    expect(loose.map((c) => c.file)).toEqual([]);
  });

  it("including the two generated clients", () => {
    for (const f of ["client.ts", "client.server.ts"]) {
      expect(readFileSync(join("src", "integrations", "supabase", f), "utf8")).toContain(
        "global: { fetch: nulSafeFetch },",
      );
    }
  });
});
