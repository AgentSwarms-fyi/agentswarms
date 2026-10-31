// A source name the server refuses is said in words, before and after Continue.
//
// FOUND FROM THE UI. Data Catalog → Add → Object storage bucket, named
// "R422 private store (kept fixture)": Continue let it through, and Connect &
// crawl put catalogCreateSource's ZodError in the dialog as its issue JSON —
// `Not saved: [ { "origin": "string", "code": "invalid_format", ... } ]`.
//
// These tests hold both halves: the wizard checks the server's own rule (one
// definition, sourceName.ts), and a validator error that does reach the dialog
// is shown as its message, not as JSON.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { validatorErrorText, validatorIssues } from "@/lib/validatorError";
import {
  SOURCE_NAME_MAX,
  SOURCE_NAME_PATTERN,
  SOURCE_NAME_RULE,
  SOURCE_NAME_TOO_LONG,
  sourceNameProblem,
} from "@/utils/catalog/sourceName";

const REPORTED = "R422 private store (kept fixture)";

// catalogCreateSource's name and storage fields, built from the same constants.
const Schema = z.object({
  access_token: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(SOURCE_NAME_MAX, SOURCE_NAME_TOO_LONG)
    .regex(SOURCE_NAME_PATTERN, SOURCE_NAME_RULE),
  storage: z
    .object({
      endpoint: z.string().url().optional().or(z.literal("")),
      bucket: z.string().min(1).max(255),
    })
    .optional(),
});

/**
 * What a server function's caller receives when its validator throws:
 * router-core's ShallowErrorPlugin sends only the message and rebuilds
 * `new Error(message)` on the client, so the issues survive only as JSON text.
 */
function thrownToClient(input: unknown): Error {
  try {
    Schema.parse(input);
  } catch (e) {
    return new Error((e as Error).message);
  }
  throw new Error("expected the validator to refuse");
}

describe("the source-name rule", () => {
  it("refuses the reported name with the server's sentence", () => {
    expect(sourceNameProblem(REPORTED)).toBe("Letters, numbers, spaces, - _ . only");
  });

  it("accepts letters, numbers, spaces, - _ and .", () => {
    for (const ok of ["R422 private store - kept fixture", "raw_lake.v2", "Data lake raw", "a"]) {
      expect(sourceNameProblem(ok)).toBeNull();
    }
  });

  it("checks the name as it is sent: trimmed, and silent while empty", () => {
    expect(sourceNameProblem("  Data lake  ")).toBeNull();
    expect(sourceNameProblem("a".repeat(SOURCE_NAME_MAX) + "  ")).toBeNull();
    expect(sourceNameProblem("")).toBeNull();
    expect(sourceNameProblem("   ")).toBeNull();
  });

  it("refuses what the server's length limit refuses", () => {
    expect(sourceNameProblem("a".repeat(SOURCE_NAME_MAX))).toBeNull();
    expect(sourceNameProblem("a".repeat(SOURCE_NAME_MAX + 1))).toBe("60 characters at most");
  });

  it("agrees with the validator on every name it is asked about", () => {
    const names = [
      REPORTED,
      "ok name",
      "tab\there",
      "naïve",
      "a/b",
      "x".repeat(61),
      "x".repeat(60),
    ];
    for (const name of names) {
      const server = Schema.safeParse({ access_token: "t", name: name.trim() });
      expect(sourceNameProblem(name) === null).toBe(server.success);
    }
  });
});

describe("the server and the wizard share one rule", () => {
  const SERVER = readFileSync("src/utils/catalog.functions.ts", "utf8");
  const WIZARD = readFileSync("src/components/catalog/AddSourceWizard.tsx", "utf8");

  it("catalogCreateSource validates the name with the shared constants", () => {
    const create = SERVER.slice(SERVER.indexOf("export const catalogCreateSource"));
    expect(create.slice(0, 600)).toMatch(
      /name: z\s*\.string\(\)\s*\.min\(1\)\s*\.max\(SOURCE_NAME_MAX, SOURCE_NAME_TOO_LONG\)\s*\.regex\(SOURCE_NAME_PATTERN, SOURCE_NAME_RULE\)/,
    );
    // No second copy of the pattern to drift from the wizard's.
    expect(SERVER).not.toContain("a-zA-Z0-9_\\- .]+$/");
  });

  it("the wizard holds Continue until the name passes, and says why beside the field", () => {
    expect(WIZARD).toContain("const nameProblem = sourceNameProblem(name);");
    expect(WIZARD).toMatch(
      /const configValid =\s*name\.trim\(\)\.length > 0 &&\s*nameProblem === null &&/,
    );
    expect(WIZARD).toMatch(/disabled=\{!configValid\}\s*onClick=\{\(\) => setStep\("crawl"\)\}/);
    expect(WIZARD).toMatch(/\{nameProblem \? \(\s*<p id="source-name-problem" role="alert"/);
  });

  it("the placeholder no longer suggests a name the server refuses", () => {
    const placeholders = [
      ...WIZARD.matchAll(/placeholder=\{kind === "warehouse" \? "([^"]+)" : "([^"]+)"\}/g),
    ];
    expect(placeholders).toHaveLength(1);
    for (const p of placeholders[0].slice(1)) expect(sourceNameProblem(p)).toBeNull();
  });
});

describe("a validator error reaching the dialog", () => {
  it("arrives as issue JSON, which is what the dialog used to show", () => {
    const e = thrownToClient({ access_token: "t", name: REPORTED });
    expect(e.message.trim().startsWith("[")).toBe(true);
    expect(e.message).toContain('"code": "invalid_format"');
  });

  it("is shown as the validator's sentence, after the field's label", () => {
    const e = thrownToClient({ access_token: "t", name: REPORTED });
    expect(validatorErrorText(e, { name: "Source name" })).toBe(
      "Source name: Letters, numbers, spaces, - _ . only",
    );
    expect(validatorErrorText(e)).toBe("Letters, numbers, spaces, - _ . only");
  });

  it("gives one sentence per field, the first problem of each, in the validator's order", () => {
    const e = thrownToClient({ access_token: "", name: "x".repeat(70) + "(" });
    expect(validatorIssues(e)?.filter((i) => i.path[0] === "name")).toHaveLength(2);
    expect(validatorErrorText(e, { name: "Source name" })).toBe(
      "Too small: expected string to have >=1 characters; Source name: 60 characters at most",
    );
  });

  // The endpoint's `.url().optional().or(z.literal(""))` is reported as the
  // URL check's own issue, not a union's "Invalid input" (zod 4.6), which is
  // what the live refusal showed too.
  it("names a nested field by its dotted path", () => {
    const e = thrownToClient({
      access_token: "t",
      name: "ok",
      storage: { endpoint: "not a url", bucket: "" },
    });
    expect(
      validatorErrorText(e, { "storage.endpoint": "Endpoint URL", "storage.bucket": "Bucket" }),
    ).toBe("Endpoint URL: Invalid URL; Bucket: Too small: expected string to have >=1 characters");
  });

  it("reads a ZodError thrown on the same side from its issues", () => {
    const r = Schema.safeParse({ access_token: "t", name: REPORTED });
    expect(r.success).toBe(false);
    expect(validatorErrorText(r.error)).toBe("Letters, numbers, spaces, - _ . only");
  });

  it("leaves every other error as it was", () => {
    for (const message of [
      "Could not reach https://minio.example.com: the name does not resolve",
      "[object storage] refused: 403",
      "[1, 2, 3]",
      '[{"message": "no code or path"}]',
      "[]",
      "[ not json",
    ]) {
      expect(validatorIssues(new Error(message))).toBeNull();
      expect(validatorErrorText(new Error(message))).toBe(message);
    }
    expect(validatorErrorText("plain text")).toBe("plain text");
  });
});
