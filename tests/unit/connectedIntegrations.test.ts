// The shared connected-providers fetcher, and why a memoised failure is worse
// than a failure.
//
// Module 29 of the adversarial pass. MEASURED live against an account with
// gemini and openrouter connected: with both reads 403'd, the fetcher
// RESOLVED an empty array rather than rejecting — so every caller concluded
// the user had connected nothing, and /image-playground rendered "No model
// providers connected. Connect one under Integrations", an instruction to
// redo work already done. The memo made it durable: `integrationsPromise ??=`
// cached the empty result, and a second call returned it with no network at
// all (verified — zero interceptions on the second call), so one transient
// failure claimed "no providers" for the rest of the session.
//
// These tests exercise the real exported function against a stubbed supabase
// client, so the merge, the throw and the memo behaviour are all covered.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const okRows = (rows: unknown[]) => ({ data: rows, error: null });
const failRows = (message: string) => ({ data: null, error: { message } });

/** Load a FRESH copy of the module so its memo starts empty each time. */
async function freshModule(handlers: {
  integrations: () => unknown;
  provider_credentials: () => unknown;
  /** The instance-wide key status. Defaults to "no instance key". */
  instance?: () => unknown;
}) {
  vi.resetModules();
  // The fetcher reads a THIRD source: whether the operator set a shared
  // OPENROUTER_API_KEY. Unmocked it resolves undefined and the merge throws,
  // which is exactly what these tests caught when it was added.
  vi.doMock("@/utils/providers/instanceProviders.functions", () => ({
    getInstanceProviderStatus: () =>
      Promise.resolve(
        handlers.instance
          ? handlers.instance()
          : { openrouter: false, openrouterDefaultModel: null },
      ),
  }));
  vi.doMock("@/integrations/supabase/client", () => ({
    supabase: {
      from: (table: string) => {
        const result =
          table === "integrations" ? handlers.integrations() : handlers.provider_credentials();
        const builder = {
          select: () => builder,
          eq: () => builder,
          then: (res: (v: unknown) => unknown) => Promise.resolve(result).then(res),
        };
        return builder;
      },
    },
  }));
  return await import("@/components/bi/BiModelSelect");
}

afterEach(() => {
  vi.doUnmock("@/integrations/supabase/client");
  vi.doUnmock("@/utils/providers/instanceProviders.functions");
  vi.resetModules();
});

describe("fetchConnectedIntegrations", () => {
  it("merges both stores into one provider list", async () => {
    const mod = await freshModule({
      integrations: () => okRows([{ provider: "gemini", config: {}, is_active: true }]),
      provider_credentials: () =>
        okRows([{ provider: "openrouter", default_model: "x", is_active: true }]),
    });
    const list = await mod.fetchConnectedIntegrations();
    expect(list.map((x) => x.provider).sort()).toEqual(["gemini", "openrouter"]);
  });

  it("REJECTS when the integrations read fails, rather than resolving empty", async () => {
    // THE finding. An empty resolve is indistinguishable from "you have none".
    const mod = await freshModule({
      integrations: () => failRows("permission denied"),
      provider_credentials: () => okRows([]),
    });
    await expect(mod.fetchConnectedIntegrations()).rejects.toThrow("permission denied");
  });

  it("REJECTS when the credentials read fails", async () => {
    const mod = await freshModule({
      integrations: () => okRows([]),
      provider_credentials: () => failRows("creds 403"),
    });
    await expect(mod.fetchConnectedIntegrations()).rejects.toThrow("creds 403");
  });

  it("does not memoise a failure — the next call retries and can recover", async () => {
    // The half that made one blip last a whole session.
    let failNext = true;
    const mod = await freshModule({
      integrations: () =>
        failNext
          ? failRows("transient")
          : okRows([{ provider: "gemini", config: {}, is_active: true }]),
      provider_credentials: () => okRows([]),
    });
    await expect(mod.fetchConnectedIntegrations()).rejects.toThrow("transient");
    failNext = false;
    const recovered = await mod.fetchConnectedIntegrations();
    expect(recovered.map((x) => x.provider)).toEqual(["gemini"]);
  });

  it("still memoises a SUCCESS — the cache is the point, only failures are excluded", async () => {
    let calls = 0;
    const mod = await freshModule({
      integrations: () => {
        calls += 1;
        return okRows([{ provider: "gemini", config: {}, is_active: true }]);
      },
      provider_credentials: () => okRows([]),
    });
    await mod.fetchConnectedIntegrations();
    await mod.fetchConnectedIntegrations();
    expect(calls).toBe(1);
  });

  it("a genuinely empty account still resolves empty, not an error", async () => {
    const mod = await freshModule({
      integrations: () => okRows([]),
      provider_credentials: () => okRows([]),
    });
    await expect(mod.fetchConnectedIntegrations()).resolves.toEqual([]);
  });
});

describe("image playground wiring (tripwires, limits stated)", () => {
  // Source tripwires: the page is a 900-line route component with a live
  // generation stream, so exercising it here would test mocks. Both exist
  // because a mutation run showed the exact defect each pins surviving every
  // test above.
  const src = () => readFileSync(resolve("src/routes/_authenticated/image-playground.tsx"), "utf8");

  it("keeps the rejection reason instead of silently emptying the list", () => {
    const s = src();
    expect(s).toMatch(/setProvidersError\(\s*e instanceof Error \? e\.message/);
  });

  it("shows the providers error above the 'none connected' claim", () => {
    // JSX renders top-down: "No model providers connected" must be
    // unreachable while an error is held.
    const s = src();
    const errorBranch = s.indexOf("providersError !== null &&");
    const emptyBranch = s.indexOf("providersError === null && providers !== null");
    expect(errorBranch, "the providers error branch is gone").toBeGreaterThan(-1);
    expect(emptyBranch, "the empty claim no longer defers to the error").toBeGreaterThan(-1);
    expect(errorBranch).toBeLessThan(emptyBranch);
  });
});

describe("the instance-wide OpenRouter key counts as a connected provider", () => {
  // MEASURED: on a self-hosted instance whose only provider was
  // OPENROUTER_API_KEY in .env, the AI Analyst's "New analyst" dialog showed
  // "Connect a model provider in Integrations" — while agent chat and swarms
  // were calling OpenRouter through that same key without complaint. The
  // fetcher only ever read the two tables, so the documented zero-setup path
  // looked like no setup at all.
  it("offers OpenRouter when the operator configured a shared key", async () => {
    const mod = await freshModule({
      integrations: () => okRows([]),
      provider_credentials: () => okRows([]),
      instance: () => ({ openrouter: true, openrouterDefaultModel: "openai/gpt-4o-mini" }),
    });
    const list = await mod.fetchConnectedIntegrations();
    expect(list).toEqual([{ provider: "openrouter", default_model: "openai/gpt-4o-mini" }]);
  });

  it("does not invent a provider when no instance key is set", async () => {
    const mod = await freshModule({
      integrations: () => okRows([]),
      provider_credentials: () => okRows([]),
      instance: () => ({ openrouter: false, openrouterDefaultModel: null }),
    });
    expect(await mod.fetchConnectedIntegrations()).toEqual([]);
  });

  it("lets a user's own OpenRouter key win over the instance one", async () => {
    // Their key, their default model, their billing — the instance key is a
    // floor, not an override.
    const mod = await freshModule({
      integrations: () => okRows([]),
      provider_credentials: () =>
        okRows([
          { provider: "openrouter", default_model: "anthropic/claude-opus-4", is_active: true },
        ]),
      instance: () => ({ openrouter: true, openrouterDefaultModel: "openai/gpt-4o-mini" }),
    });
    const list = await mod.fetchConnectedIntegrations();
    expect(list).toEqual([{ provider: "openrouter", default_model: "anthropic/claude-opus-4" }]);
  });

  it("survives the status call failing — the tables still decide", async () => {
    const mod = await freshModule({
      integrations: () => okRows([{ provider: "gemini", config: {}, is_active: true }]),
      provider_credentials: () => okRows([]),
      instance: () => Promise.reject(new Error("network")),
    });
    const list = await mod.fetchConnectedIntegrations();
    expect(list.map((i) => i.provider)).toEqual(["gemini"]);
  });
});
