// R386 (VA-2026-10-25-14, LLM provider half): a provider's base URL is a
// per-user setting, so every signed-in user could aim the server at the cloud
// metadata address — directly, through a name that resolves there, or through
// a redirect. The adapters and every consumer of a resolved transport fetched
// it raw. Bedrock, OCI and Vertex went further: they put the user's region into
// the HOST, where `169.254.169.254.nip.io#` makes it a name the user picked
// (bedrock-runtime.169.254.169.254.nip.io), which resolves to metadata.
//
// providerFetch applies the always-blocked tier to all of that and leaves the
// documented private-network allowance alone (a model server on 10.x is the
// point of a vLLM setting).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deterministic DNS: no network, and a name that resolves to metadata.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "metadata.attacker.test") return [{ address: "169.254.169.254", family: 4 }];
    if (host === "models.internal.test") return [{ address: "10.0.0.5", family: 4 }];
    return [{ address: "93.184.216.34", family: 4 }];
  },
}));

import { cloudRegion } from "@/utils/providers/cloudRegion";
import { bedrockChatStream } from "@/utils/providers/adapters/bedrock.server";
import { ociChatStream } from "@/utils/providers/adapters/oci.server";
import { openAICompatChatStream } from "@/utils/providers/adapters/openai-compat.server";
import { providerFetch, safeFetch, SsrfRefusedError } from "@/utils/ssrfGuard.server";

let calls: string[] = [];
let respond: (url: string) => Response = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => new Response("{}", { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("providerFetch refuses the metadata address however it is reached", () => {
  it("as the base URL itself, before any connection", async () => {
    await expect(providerFetch("http://169.254.169.254/v1/chat/completions")).rejects.toThrow(
      SsrfRefusedError,
    );
    expect(calls).toEqual([]);
  });

  it("through a name whose address is the metadata address", async () => {
    await expect(
      providerFetch("http://metadata.attacker.test/v1/chat/completions"),
    ).rejects.toThrow(/link-local|metadata/i);
    expect(calls).toEqual([]);
  });

  it("through a redirect from an allowed host", async () => {
    respond = (url) =>
      url.includes("relay.example")
        ? new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          })
        : new Response("{}", { status: 200 });
    await expect(providerFetch("https://relay.example/v1/chat/completions")).rejects.toThrow(
      SsrfRefusedError,
    );
    // The relay was asked; the metadata address never was.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("relay.example");
  });
});

describe("providerFetch keeps the private-network allowance the docs promise", () => {
  it("reaches a model server on a private address even when the deployment blocks private targets", async () => {
    vi.stubEnv("BLOCK_PRIVATE_NETWORK_FETCH", "true");
    const res = await providerFetch("http://models.internal.test:8000/v1/models");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("while the ordinary guard, under the same setting, refuses it", async () => {
    // The contrast: without allowPrivate the same URL is refused, so the
    // allowance above is providerFetch's doing, not the guard being lax.
    vi.stubEnv("BLOCK_PRIVATE_NETWORK_FETCH", "true");
    await expect(safeFetch("http://models.internal.test:8000/v1/models")).rejects.toThrow(
      /private|internal/i,
    );
    expect(calls).toEqual([]);
  });
});

describe("the adapters go through it", () => {
  it("an OpenAI-compatible base URL pointing at metadata is refused, not called", async () => {
    await expect(
      openAICompatChatStream({
        baseUrl: "http://169.254.169.254/latest/meta-data/iam?x=",
        apiKey: "k",
        modelId: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(SsrfRefusedError);
    expect(calls).toEqual([]);
  });

  it("a Bedrock region that rewrites the host is refused before signing or fetching", async () => {
    await expect(
      bedrockChatStream({
        creds: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
        config: { region: "169.254.169.254.nip.io#" },
        modelId: "m",
        messages: [{ role: "user", content: "hi" }],
      } as Parameters<typeof bedrockChatStream>[0]),
    ).rejects.toThrow(/not a region name/);
    expect(calls).toEqual([]);
  });

  it("an OCI region that rewrites the host is refused before fetching", async () => {
    await expect(
      ociChatStream({
        creds: {},
        config: { region: "169.254.169.254.nip.io#", compartmentId: "ocid1.compartment" },
        modelId: "m",
        messages: [{ role: "user", content: "hi" }],
      } as unknown as Parameters<typeof ociChatStream>[0]),
    ).rejects.toThrow(/not a region name/);
    expect(calls).toEqual([]);
  });
});

describe("cloudRegion", () => {
  it("accepts real region and location names, normalising case", () => {
    for (const [given, want] of [
      ["us-east-1", "us-east-1"],
      ["US-East-1", "us-east-1"],
      [" eu-west-3 ", "eu-west-3"],
      ["us-central1", "us-central1"],
      ["us-ashburn-1", "us-ashburn-1"],
      ["global", "global"],
    ]) {
      expect(cloudRegion(given, "Region")).toBe(want);
    }
  });

  it("refuses anything that could change the host it is put into", () => {
    for (const bad of [
      "169.254.169.254.nip.io#",
      "attacker.test/",
      "us-east-1?x",
      "x@169.254.169.254/",
      "us-east-1.attacker.test",
      "us-east-1/",
      "us-east-1#",
      "us east 1",
      "-us-east-1",
      "",
      "a".repeat(41),
    ]) {
      expect(() => cloudRegion(bad, "Region"), bad).toThrow(/not a region name/);
    }
  });
});

describe("no provider call site fetches a configured URL raw", () => {
  // The finding was a list of sites that drifted from the guard; this is the
  // list's replacement. Any fetch of a resolved transport, or a raw fetch in an
  // adapter that takes a base URL or region, fails here.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk("src");

  it("every fetch of a resolved transport's URL is guarded", () => {
    const raw = files.filter((f) =>
      /(?<![A-Za-z])fetch\(\s*(?:transport|t|tr)\.endpointUrl/.test(readFileSync(f, "utf8")),
    );
    expect(raw).toEqual([]);
  });

  it("every adapter that builds its URL from configuration fetches through providerFetch", () => {
    for (const name of ["anthropic", "azure", "grok", "openai-compat", "qwen", "vertex", "vllm"]) {
      const src = readFileSync(`src/utils/providers/adapters/${name}.server.ts`, "utf8");
      expect(src, name).toMatch(/await providerFetch\(/);
      expect(src, `${name} still has a raw fetch`).not.toMatch(/(?<![A-Za-z])await fetch\(/);
    }
  });

  it("the region-built hosts validate the region first", () => {
    expect(readFileSync("src/utils/providers/adapters/bedrock.server.ts", "utf8")).toMatch(
      /const region = cloudRegion\(/,
    );
    expect(readFileSync("src/utils/providers/adapters/oci.server.ts", "utf8")).toMatch(
      /endpointForRegion\(cloudRegion\(region/,
    );
    expect(readFileSync("src/utils/providers/adapters/vertex.server.ts", "utf8")).toMatch(
      /const location = cloudRegion\(/,
    );
  });

  it("the model-listing, Ollama, embedding and rerank calls are guarded", () => {
    for (const f of [
      "src/utils/providerModels.functions.ts",
      "src/utils/providers/ollama.functions.ts",
      "src/utils/tools/embedding.server.ts",
      "src/utils/tools/kb.server.ts",
      "src/utils/tools/loop.server.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/await providerFetch\(/);
    }
  });

  it("the tool loop does not retry a refused target", () => {
    const loop = readFileSync("src/utils/tools/loop.server.ts", "utf8");
    expect(loop).toMatch(/if \(e instanceof SsrfRefusedError\) throw e;/);
  });
});
