// A pipeline's secret bindings: rows in the editor, `ENV={{secret:NAME}}`
// lines in storage, and the same test at save as at run start (R493).
//
// The Settings field was a textarea, and the run skipped any line its pattern
// did not read without a word: `API_TOKEN = {{secret:X}}` (spaces), a literal
// key, a misspelt reference all bound nothing, and the pipeline's code found
// its variable missing at run time. The editor now writes the lines from rows
// and a save refuses a line the run would skip, so these hold the editor's
// writer, the save's check and the run's reader to one pattern.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SECRET_BINDING_RE,
  parseSecretBindings,
  secretBindingLineProblem,
  secretBindingsError,
  secretBindingsProblems,
  serializeSecretBindings,
} from "@/lib/secretBindings";

/** The pattern a reader of bindings declares, as written in its source. */
function declaredPattern(file: string): string {
  const src = readFileSync(file, "utf8");
  const m = /const SECRET_BINDING_RE = \/(.+)\/;/.exec(src);
  expect(m, `${file}: SECRET_BINDING_RE moved; re-anchor this test`).not.toBeNull();
  return m![1];
}

describe("one pattern for a binding", () => {
  it("is the one the ETL run and the MCP sandbox read with", () => {
    expect(SECRET_BINDING_RE.source).toBe(declaredPattern("src/utils/etl/service.server.ts"));
    expect(SECRET_BINDING_RE.source).toBe(
      declaredPattern("src/routes/api/notebook.runtime.source.ts"),
    );
  });
});

describe("rows and lines", () => {
  it("reads every non-blank line as a row, however it is spelled", () => {
    const rows = parseSecretBindings(
      "API_TOKEN={{secret:MY_TOKEN}}\n\n  DB_PASS = {{ secret:DB }}  \nliteral=sk-123\n# note\n=",
    );
    expect(rows).toEqual([
      { env: "API_TOKEN", value: "{{secret:MY_TOKEN}}", secret: "MY_TOKEN" },
      { env: "DB_PASS", value: "{{ secret:DB }}", secret: "DB" },
      { env: "literal", value: "sk-123", secret: null },
      { env: "# note", value: "", secret: null },
      { env: "", value: "", secret: null },
    ]);
  });

  it("writes a row with a secret the one way the run reads", () => {
    const text = serializeSecretBindings([
      { env: " API_TOKEN ", value: "{{ secret:MY_TOKEN }}", secret: "MY_TOKEN" },
      { env: "B", value: "", secret: null },
    ]);
    expect(text).toBe("API_TOKEN={{secret:MY_TOKEN}}\nB=");
    expect(SECRET_BINDING_RE.test(text.split("\n")[0])).toBe(true);
  });

  it("round-trips what the editor writes", () => {
    const text = "A={{secret:ONE}}\nB_2={{secret:two}}";
    expect(serializeSecretBindings(parseSecretBindings(text))).toBe(text);
    expect(secretBindingsProblems(text)).toEqual([]);
  });
});

describe("a save refuses what the run would skip", () => {
  const RUN_READS = (line: string) => SECRET_BINDING_RE.test(line.trim());

  it("agrees with the run on every line", () => {
    for (const line of [
      "API_TOKEN={{secret:MY_TOKEN}}",
      "_PRIVATE={{secret:X}}",
      "A={{ secret:X }}",
      "  A={{secret:X}}  ",
      "A = {{secret:X}}",
      "A={{Secret:X}}",
      "A={{secret:X-1}}",
      "A=sk-123",
      "A=Bearer {{secret:X}}",
      "1A={{secret:X}}",
      "A-B={{secret:X}}",
      "A=",
      "={{secret:X}}",
      "A",
      "# comment",
    ]) {
      expect(secretBindingLineProblem(line) === null, line).toBe(RUN_READS(line));
    }
  });

  it("says what is wrong in the words a person can act on", () => {
    expect(secretBindingLineProblem("={{secret:X}}")).toBe("Name the environment variable.");
    expect(secretBindingLineProblem("1A={{secret:X}}")).toMatch(/is not an environment variable/);
    expect(secretBindingLineProblem("A=")).toBe("Pick the secret A is set to.");
    expect(secretBindingLineProblem("A=sk-123")).toBe(
      "A is set to text, not a secret: pick a secret for it.",
    );
    expect(secretBindingLineProblem("A = {{secret:X}}")).toBe("Write it as A={{secret:X}}.");
  });

  it("refuses a variable bound twice, which the run would quietly overwrite", () => {
    expect(secretBindingsProblems("A={{secret:X}}\nB={{secret:Y}}\nA={{secret:Z}}")).toEqual([
      { row: 2, message: "A is already bound by binding 1." },
    ]);
  });

  it("counts rows as the editor does, skipping blank lines", () => {
    expect(secretBindingsProblems("A={{secret:X}}\n\n\nB=oops")).toEqual([
      { row: 1, message: "B is set to text, not a secret: pick a secret for it." },
    ]);
    expect(secretBindingsError("A={{secret:X}}\n\nB=oops\nC=")).toBe(
      "Secret binding 2: B is set to text, not a secret: pick a secret for it. (and 1 more)",
    );
    expect(secretBindingsError("")).toBeNull();
    expect(secretBindingsError(undefined)).toBeNull();
  });

  it("is checked by the save, on the client and on the server", () => {
    const fns = readFileSync("src/utils/etl.functions.ts", "utf8");
    const save = fns.slice(fns.indexOf("export const saveEtlPipeline"));
    expect(save).toMatch(
      /const badBinding = secretBindingsError\(data\.secret_refs\);\s*if \(badBinding\) throw new Error\(badBinding\);/,
    );
    const page = readFileSync("src/routes/_authenticated/etl.tsx", "utf8");
    expect(page).toContain("const badBinding = secretBindingsError(p.secret_refs);");
    // The textarea of KEY={{secret:NAME}} lines is gone.
    expect(page).not.toContain('placeholder={"API_TOKEN={{secret:MY_API_TOKEN}}"}');
    expect(page).toContain("<SecretBindingsEditor");
  });
});
