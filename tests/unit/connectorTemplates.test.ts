// Every connector template in src/connectors/ (R528), checked like a spec a
// person typed, and every stream run through the real engine against its
// recorded responses in tests/fixtures/connectors/<id>.json. A template
// without fixtures for every stream fails here: that is the contract a
// contributed connector meets.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

type Page = { body: unknown; link?: string };
type Fixture = {
  inputs: Record<string, string>;
  credential: string;
  streams: Record<string, { pages: Page[]; rows: number }>;
};

const net = vi.hoisted(() => ({
  pages: [] as Array<{ body: unknown; link?: string }>,
  requests: [] as Array<{ url: string; headers: Record<string, string> }>,
}));

vi.mock("@/utils/http/connectorFetch.server", () => ({
  connectorFetch: async (url: string, init: { headers?: Record<string, string> }) => {
    net.requests.push({ url, headers: init.headers ?? {} });
    const page = net.pages.shift();
    if (!page) return new Response("no more recorded pages", { status: 500 });
    return new Response(JSON.stringify(page.body), {
      status: 200,
      headers: page.link ? { link: page.link } : {},
    });
  },
}));

const { CONNECTOR_TEMPLATES, applyTemplate, INPUT_VALUE } =
  await import("@/lib/connectorTemplates");
const { fetchRestRows, restIncremental } = await import("@/utils/saas/restApi.server");
const { specOrigin } = await import("@/lib/connectorSpec");

const fixtureOf = (id: string): Fixture | null => {
  const f = path.resolve("tests/fixtures/connectors", `${id}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Fixture) : null;
};

beforeEach(() => {
  net.pages = [];
  net.requests = [];
});

describe("the templates", () => {
  it("each file is named after its template id, as the scaffold writes it", () => {
    for (const file of readdirSync(path.resolve("src/connectors"))) {
      const t = JSON.parse(readFileSync(path.resolve("src/connectors", file), "utf8")) as {
        id: string;
      };
      expect(file).toBe(`${t.id}.json`);
    }
  });

  it("are there, with unique ids", () => {
    expect(CONNECTOR_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    const ids = CONNECTOR_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const t of CONNECTOR_TEMPLATES) {
    describe(t.label, () => {
      const fx = fixtureOf(t.id);

      it("says what it is, how it was checked, and where the key comes from", () => {
        expect(t.description.length).toBeGreaterThan(10);
        expect(["live", "reference"]).toContain(t.checked);
        expect(t.credential.length).toBeGreaterThan(10);
      });

      it("becomes a spec that passes the same check as a typed one", () => {
        expect(fx, `tests/fixtures/connectors/${t.id}.json is missing`).not.toBeNull();
        const applied = applyTemplate(t, fx!.inputs);
        expect(applied.ok ? [] : applied.errors).toEqual([]);
      });

      it("has recorded responses for every stream, and reads them through the engine", async () => {
        const applied = applyTemplate(t, fx!.inputs);
        if (!applied.ok) throw new Error(applied.errors.join("; "));
        const spec = applied.spec;
        const origin = specOrigin(spec.base_url)!;
        const cfg = {
          provider: "rest_api" as const,
          spec: JSON.stringify(spec),
          credential: fx!.credential,
        };
        for (const stream of spec.streams) {
          const rec = fx!.streams[stream.id];
          expect(rec, `${t.id}: no recorded pages for "${stream.id}"`).toBeDefined();
          net.pages = [...rec.pages];
          net.requests = [];
          const rows: Record<string, unknown>[] = [];
          for await (const r of fetchRestRows(cfg, stream.id)) rows.push(r);
          expect(rows.length, `${t.id}.${stream.id}`).toBe(rec.rows);
          // Every page was asked for, and no more.
          expect(net.requests.length, `${t.id}.${stream.id} requests`).toBe(rec.pages.length);
          for (const r of net.requests) expect(new URL(r.url).origin).toBe(origin);
          // The credential goes only where auth says.
          if (fx!.credential) {
            const sent = net.requests.map((r) => r.url + JSON.stringify(r.headers)).join(" ");
            const asBasic = Buffer.from(`anystring:${fx!.credential}`).toString("base64");
            expect(
              sent.includes(fx!.credential) || sent.includes(asBasic),
              `${t.id}: the credential was not sent`,
            ).toBe(true);
          }
        }
      });

      it("follows changes only where it declares how", () => {
        const applied = applyTemplate(t, fx!.inputs);
        if (!applied.ok) throw new Error(applied.errors.join("; "));
        const cfg = { provider: "rest_api" as const, spec: JSON.stringify(applied.spec) };
        for (const s of applied.spec.streams) {
          expect(Boolean(restIncremental(s.id, cfg))).toBe(Boolean(s.incremental));
        }
      });
    });
  }
});

describe("filling a template", () => {
  const github = CONNECTOR_TEMPLATES.find((t) => t.id === "github_repo")!;

  it("takes one path segment per input, nothing that moves a request", () => {
    for (const bad of ["../admin", "a/b", "evil.example/x", "a?b=c", "%2e%2e", ""]) {
      expect(INPUT_VALUE.test(bad), bad).toBe(false);
      const r = applyTemplate(github, { owner: bad, repo: "x" });
      expect(r.ok, bad).toBe(false);
    }
    const ok = applyTemplate(github, { owner: "octo-cat", repo: "hello.world" });
    expect(ok.ok && ok.spec.streams[0].path).toBe("/repos/octo-cat/hello.world/issues");
    expect(ok.ok && ok.spec.name).toBe("GitHub octo-cat/hello.world");
  });

  it("keeps a host input inside the host", () => {
    const mailchimp = CONNECTOR_TEMPLATES.find((t) => t.id === "mailchimp")!;
    const ok = applyTemplate(mailchimp, { dc: "us21" });
    expect(ok.ok && ok.spec.base_url).toBe("https://us21.api.mailchimp.com/3.0");
    expect(applyTemplate(mailchimp, { dc: "evil.example#" }).ok).toBe(false);
  });
});
