// A provider credential that fails its schema says which field, in words.
//
// Saving the OCI Generative AI dialog with a private key shorter than 40
// characters showed, in the toast and in the dialog's error box,
// `[{"origin":"string","code":"too_small","minimum":40,"path":["oci_genai",
// "privateKeyPem"],"message":"Too small: expected string to have >=40
// characters"}]`: the validator called `SaveSchema.parse(input)`, and a
// ZodError's message is its serialised issue array. The server functions now
// answer one sentence per failing field, named as the dialog names it.
//
// The first block runs the real server functions' validators, with the
// framework's builder faked; the handlers are never reached.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SAVE_FIELD_TEXT,
  explainIssues,
  saveFieldText,
} from "@/utils/providers/credentialFieldErrors";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      middleware: () => b,
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (a: { data: unknown; context: unknown }) => unknown) =>
        async (opts: { data: unknown }) =>
          h({ data: validate(opts.data), context: { userId: "u1" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

type Fn = (o: { data: unknown }) => Promise<unknown>;
async function fns() {
  const m = await import("@/utils/providers/credentials.functions");
  return {
    save: m.saveProviderCredential as unknown as Fn,
    check: m.checkProviderNetworkPath as unknown as Fn,
    remove: m.deleteProviderCredential as unknown as Fn,
  };
}

/** What the OCI dialog sends, with made-up values and a key pasted short. */
const oci = (over: Record<string, unknown> = {}) => ({
  provider: "oci_genai",
  label: "oci_genai",
  oci_genai: {
    region: "us-chicago-1",
    compartmentId: "ocid1.compartment.oc1..aaaaexample",
    tenancyOcid: "ocid1.tenancy.oc1..aaaaexample",
    userOcid: "ocid1.user.oc1..aaaaexample",
    fingerprint: "aa:bb:cc:dd:ee:ff:00:11",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----",
    style: "GENERIC",
    requirePrivate: false,
    ...over,
  },
});

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the call to be refused");
}

/** Not the issue JSON, in whole or in part. */
function expectPlainWords(msg: string) {
  expect(() => JSON.parse(msg), msg).toThrow();
  for (const zodWord of ['"code"', "too_small", "invalid_value", "origin", '"path"', "[{"]) {
    expect(msg, msg).not.toContain(zodWord);
  }
}

describe("saving a provider credential that fails the schema", () => {
  it("a too-short OCI private key reads as one sentence naming the dialog's field", async () => {
    const { save } = await fns();
    const msg = await messageOf(save({ data: oci() }));
    expectPlainWords(msg);
    // The schema's names for the field, which the dialog never shows.
    expect(msg).not.toContain("privateKeyPem");
    expect(msg).not.toContain("oci_genai");
    expect(msg).toBe(
      "Private Key (PEM) is too short — paste the whole PEM file, from its -----BEGIN line to its -----END line.",
    );
  });

  it("names every failing field once, in the schema's order", async () => {
    const { save } = await fns();
    const msg = await messageOf(save({ data: oci({ tenancyOcid: "ocid1" }) }));
    expectPlainWords(msg);
    expect(msg).toBe(
      "Tenancy OCID is too short — paste the whole OCID, which starts ocid1.tenancy. " +
        "Private Key (PEM) is too short — paste the whole PEM file, from its -----BEGIN line to its -----END line.",
    );
  });

  it("says a missing field is required, not that it is too short", async () => {
    const { save } = await fns();
    expect(await messageOf(save({ data: oci({ userOcid: "" }) }))).toMatch(
      /^User OCID is required\. Private Key/,
    );
    const noFingerprint = oci();
    delete (noFingerprint.oci_genai as Record<string, unknown>).fingerprint;
    expect(await messageOf(save({ data: noFingerprint }))).toMatch(
      /^API Key Fingerprint is required\./,
    );
  });

  it("explains a malformed URL and a malformed workspace ID by their shape", async () => {
    const { save } = await fns();
    const azure = await messageOf(
      save({
        data: {
          provider: "azure_openai",
          azure_openai: { endpoint: "myresource", apiKey: "0123456789abcdef" },
        },
      }),
    );
    expect(azure).toBe(
      "Azure Endpoint URL is not in the right form — enter the full address, such as https://myresource.openai.azure.com.",
    );
    const claude = await messageOf(
      save({
        data: {
          provider: "claude_aws",
          claude_aws: { region: "us-west-2", workspaceId: "01AbCd", apiKey: "k" },
        },
      }),
    );
    expect(claude).toBe(
      "Workspace ID is not in the right form — it looks like wrkspc_01AbCdEf23GhIj.",
    );
  });

  it("says how long a value may be", async () => {
    const { save } = await fns();
    const msg = await messageOf(save({ data: oci({ endpoint: `https://${"a".repeat(300)}` }) }));
    expect(msg).toBe(
      "Private Key (PEM) is too short — paste the whole PEM file, from its -----BEGIN line to its -----END line. " +
        "Private endpoint URL is too long — it can be at most 300 characters.",
    );
  });
});

describe("the file's other server functions answer the same way", () => {
  it("the network-path check names the provider's own region and endpoint fields", async () => {
    const { check } = await fns();
    const long = "x".repeat(61);
    expect(await messageOf(check({ data: { provider: "bedrock", region: long } }))).toBe(
      "AWS Region is too long — it can be at most 60 characters.",
    );
    expect(await messageOf(check({ data: { provider: "vertex", region: long } }))).toBe(
      "Region is too long — it can be at most 60 characters.",
    );
    expect(
      await messageOf(check({ data: { provider: "azure_openai", endpoint: "x".repeat(301) } })),
    ).toBe("Azure Endpoint URL is too long — it can be at most 300 characters.");
    const bad = await messageOf(check({ data: { provider: "openai" } }));
    expectPlainWords(bad);
    expect(bad).toMatch(/^Provider must be one of: bedrock, vertex, oci_genai/);
  });

  it("delete names a provider it does not know", async () => {
    const { remove } = await fns();
    const msg = await messageOf(remove({ data: { provider: "nope" } }));
    expectPlainWords(msg);
    expect(msg).toMatch(/^Provider must be one of: bedrock, vertex, anthropic,/);
  });

  it("no validator in the file throws a raw ZodError", () => {
    const src = readFileSync("src/utils/providers/credentials.functions.ts", "utf8");
    const validators = [...src.matchAll(/\.validator\(/g)].length;
    expect(validators).toBeGreaterThanOrEqual(4);
    expect(src).not.toMatch(/\.parse\(input\)/);
    expect([...src.matchAll(/parseOrExplain\(/g)].length).toBe(3);
  });
});

describe("the field names are the dialog's", () => {
  const fnsSrc = readFileSync("src/utils/providers/credentials.functions.ts", "utf8");
  const schema = fnsSrc.slice(
    fnsSrc.indexOf("const SaveSchema"),
    fnsSrc.indexOf("export const save"),
  );
  const panel = readFileSync("src/components/integrations/ProviderCredentialsPanel.tsx", "utf8");

  it("every save-schema field has a name", () => {
    const providers = [
      "bedrock",
      "vertex",
      "anthropic",
      "azure_openai",
      "oci_genai",
      "qwen",
      "claude_aws",
    ];
    let count = 0;
    for (const provider of providers) {
      const start = schema.indexOf(`  ${provider}: z`);
      expect(start, `${provider} is not in the save schema`).toBeGreaterThan(-1);
      const block = schema.slice(start, schema.indexOf("\n    })", start));
      const fields = [...block.matchAll(/^\s{6}([a-zA-Z]+): z\b/gm)].map((m) => m[1]);
      expect(fields.length, `no fields parsed for ${provider}`).toBeGreaterThan(0);
      for (const f of fields) {
        count++;
        expect(saveFieldText([provider, f], {}), `${provider}.${f} has no name`).toBeDefined();
      }
    }
    expect(count).toBeGreaterThan(30);
    for (const top of ["provider", "label", "defaultModel"]) {
      expect(saveFieldText([top], {}), top).toBeDefined();
    }
  });

  it("every name the reader can see is a label in the dialog", () => {
    // Set by the dialog, never typed, so there is no label to match.
    const notTyped = new Set(["provider", "label", "oci_genai.style"]);
    const labels = Object.entries(SAVE_FIELD_TEXT)
      .filter(([path]) => !notTyped.has(path))
      .map(([, t]) => t.label);
    labels.push("Private endpoint URL", "Require a private network path");
    for (const label of labels) expect(panel, label).toContain(label);
  });

  it("a field it has no name for still reads as words", () => {
    const msg = explainIssues(
      [{ code: "too_small", origin: "string", minimum: 5, path: ["x", "roleArn"], message: "" }],
      { x: { roleArn: "ab" } },
      saveFieldText,
    );
    expect(msg).toBe("The roleArn field is too short — it needs at least 5 characters.");
  });
});
