// What a secret field stores, read the way the server reads it (R493).
//
// Every key field is a picker now, and the picker writes `{{secret:NAME}}` (or
// the bare NAME). The browser decides what is a reference in three places — a
// picker showing what a field holds, a header row choosing Text or Secret, and
// the swarm templater leaving references for the server — and each used to
// carry its own idea: the workflow header rows accepted `.` and `-` in a name,
// the templater skipped `Secret :x`, and neither is what the server resolves.
// A disagreement either way is a wrong answer: a value the browser calls a
// reference that the server sends out as literal text, or a reference the
// browser mangles before the server sees it. So the helpers are held to the
// resolver's own pattern, read from its source, over a corpus of spellings.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SECRET_REF_SOURCE,
  containsSecretRef,
  headerSecretValue,
  initialHeaderSource,
  isCredentialHeader,
  isSecretName,
  isSecretRefExpr,
  isTypedHeaderKey,
  parseHeaderSecret,
  parseSecretRef,
  readSecretField,
  savedSecretField,
  secretFieldValue,
  secretRef,
  suggestSecretName,
} from "@/lib/secretRefs";
import { interpolate, resolveStatePath } from "@/lib/swarmRuntime";

/** The resolver's pattern, as written in src/utils/secrets.server.ts. */
const serverSource = (() => {
  const src = readFileSync("src/utils/secrets.server.ts", "utf8");
  const m = /const SECRET_REF_RE = \/(.+)\/g;/.exec(src);
  expect(m, "SECRET_REF_RE moved; re-anchor this test").not.toBeNull();
  return m![1];
})();

/** What the server makes of a whole value: the name it would resolve, or null. */
function serverReadsWhole(value: string): string | null {
  const names: string[] = [];
  const rest = value.replace(new RegExp(serverSource, "g"), (_all, name: string) => {
    names.push(name);
    return "\u0000";
  });
  return names.length === 1 && rest.trim() === "\u0000" ? names[0] : null;
}

const CORPUS = [
  "{{secret:API_KEY}}",
  "{{ secret:API_KEY }}",
  "{{\tsecret:API_KEY\n}}",
  "  {{secret:API_KEY}}  ",
  "{{secret:api_key}}",
  "{{secret:a}}",
  "{{secret:A1_b2}}",
  "{{Secret:API_KEY}}",
  "{{SECRET:API_KEY}}",
  "{{secret :API_KEY}}",
  "{{secret: API_KEY}}",
  "{{secret:1KEY}}",
  "{{secret:_KEY}}",
  "{{secret:KEY-1}}",
  "{{secret:KEY.1}}",
  "{{secret:}}",
  "{secret:KEY}",
  "{{secret:KEY}",
  "Bearer {{secret:KEY}}",
  "{{secret:A}}{{secret:B}}",
  "{{secret:A}} and more",
  "sk-live-1234",
  "",
];

describe("the helpers read references exactly as the resolver does", () => {
  it("uses the resolver's own pattern", () => {
    expect(SECRET_REF_SOURCE).toBe(serverSource);
  });

  it("calls a whole value a reference exactly when the server resolves it as one", () => {
    for (const v of CORPUS) expect(parseSecretRef(v), JSON.stringify(v)).toBe(serverReadsWhole(v));
  });

  it("tolerates whitespace inside the braces, never around the colon", () => {
    expect(parseSecretRef("{{ secret:API_KEY }}")).toBe("API_KEY");
    expect(parseSecretRef("{{secret :API_KEY}}")).toBeNull();
    expect(parseSecretRef("{{secret: API_KEY}}")).toBeNull();
  });

  it("is case-sensitive about `secret` and keeps a name's case", () => {
    expect(parseSecretRef("{{Secret:KEY}}")).toBeNull();
    expect(parseSecretRef("{{SECRET:KEY}}")).toBeNull();
    expect(parseSecretRef("{{secret:mixedCase_1}}")).toBe("mixedCase_1");
  });

  it("refuses names the database refuses", () => {
    for (const bad of ["1KEY", "_KEY", "KEY-1", "KEY.1", "KEY 1", "", "K".repeat(65)]) {
      expect(isSecretName(bad), bad).toBe(false);
    }
    expect(isSecretName("K".repeat(64))).toBe(true);
    expect(() => secretRef("KEY-1")).toThrow();
  });

  it("writes the one spelling the resolver reads, and reads it back", () => {
    expect(secretRef("OPENAI_KEY")).toBe("{{secret:OPENAI_KEY}}");
    expect(parseSecretRef(secretRef("OPENAI_KEY"))).toBe("OPENAI_KEY");
    expect(serverReadsWhole(secretRef("OPENAI_KEY"))).toBe("OPENAI_KEY");
  });

  it("finds a reference inside text as the resolver would", () => {
    for (const v of CORPUS) {
      expect(containsSecretRef(v), JSON.stringify(v)).toBe(new RegExp(serverSource).test(v));
    }
  });
});

describe("the swarm templater leaves exactly the server's references", () => {
  it("names the same expressions the server resolves", () => {
    for (const expr of [
      "secret:API",
      "secret:api_1",
      " secret:API ",
      "Secret:API",
      "SECRET:API",
      "secret :API",
      "secret: API",
      "secret:1API",
      "secret:A.B",
      "secret:A-B",
      "input",
    ]) {
      expect(isSecretRefExpr(expr), expr).toBe(serverReadsWhole(`{{${expr}}}`) !== null);
    }
  });

  it("does not resolve a reference against flow state", () => {
    expect(resolveStatePath({ secret: "x" }, "secret:API")).toBeUndefined();
    expect(interpolate("Bearer {{ secret:API }} for {{input}}", { input: "you" })).toBe(
      "Bearer {{secret:API}} for you",
    );
  });

  it("treats a spelling the server ignores as the flow-state path it is", () => {
    // Before R493 `{{Secret:x}}` was skipped as a reference that the server
    // would then send verbatim. Now it is read as state like any other path.
    expect(resolveStatePath({ Secret: '{"a":1}' }, "Secret:x")).toBe('{"a":1}');
  });
});

describe("header values", () => {
  it("reads a scheme before a secret", () => {
    expect(parseHeaderSecret("Bearer {{secret:TOKEN}}")).toEqual({
      prefix: "Bearer ",
      name: "TOKEN",
    });
    expect(parseHeaderSecret("{{secret:TOKEN}}")).toEqual({ prefix: "", name: "TOKEN" });
    expect(parseHeaderSecret("Basic {{ secret:TOKEN }}")).toEqual({
      prefix: "Basic ",
      name: "TOKEN",
    });
    expect(parseHeaderSecret("bearer {{secret:TOKEN}}")).toBeNull();
    expect(parseHeaderSecret("Bearer sk-123")).toBeNull();
    expect(parseHeaderSecret("Bearer {{secret:TOKEN}} x")).toBeNull();
    expect(headerSecretValue("Bearer ", "TOKEN")).toBe("Bearer {{secret:TOKEN}}");
    expect(serverReadsWhole(headerSecretValue("", "TOKEN"))).toBe("TOKEN");
  });

  it("knows a key typed into a credential header, and nothing else", () => {
    expect(isCredentialHeader("Authorization")).toBe(true);
    expect(isCredentialHeader("X-API-Key")).toBe(true);
    expect(isCredentialHeader("x-goog-api-key")).toBe(true);
    expect(isCredentialHeader("Content-Type")).toBe(false);
    expect(isCredentialHeader("X-Idempotency-Key")).toBe(false);
    expect(isTypedHeaderKey("Authorization", "Bearer sk-123")).toBe(true);
    expect(isTypedHeaderKey("Authorization", "Bearer {{secret:K}}")).toBe(false);
    expect(isTypedHeaderKey("Authorization", "Bearer {{token}}")).toBe(false);
    expect(isTypedHeaderKey("Content-Type", "application/json")).toBe(false);
  });

  it("opens a row on the source its value needs", () => {
    expect(initialHeaderSource("Authorization", "Bearer {{secret:K}}")).toBe("secret");
    // A key typed in before shows as a key saved directly, never as text.
    expect(initialHeaderSource("Authorization", "Bearer sk-123")).toBe("secret");
    expect(initialHeaderSource("Authorization", "")).toBe("secret");
    expect(initialHeaderSource("Authorization", "Bearer {{token}}")).toBe("text");
    expect(initialHeaderSource("Content-Type", "application/json")).toBe("text");
    expect(initialHeaderSource("", "")).toBe("text");
  });
});

describe("what a field holds", () => {
  it("tells a secret from a key saved directly, without reading the key", () => {
    expect(readSecretField("", "ref")).toEqual({ kind: "empty" });
    expect(readSecretField("", "ref", true)).toEqual({ kind: "raw" });
    expect(readSecretField("{{secret:K}}", "ref")).toEqual({ kind: "secret", name: "K" });
    expect(readSecretField("sk-123", "ref")).toEqual({ kind: "raw" });
    expect(readSecretField("{{Secret:K}}", "ref")).toEqual({ kind: "raw" });
    expect(readSecretField("K", "name")).toEqual({ kind: "secret", name: "K" });
    expect(readSecretField("not a name", "name")).toEqual({ kind: "invalid", text: "not a name" });
    expect(secretFieldValue("K", "ref")).toBe("{{secret:K}}");
    expect(secretFieldValue("K", "name")).toBe("K");
  });

  it("reads a write-only field's saved state from the row the page can see", () => {
    expect(savedSecretField(undefined, "api_key")).toEqual({ ref: "", stored: false });
    expect(savedSecretField({}, "api_key")).toEqual({ ref: "", stored: false });
    expect(savedSecretField({ api_key: "{{secret:K}}" }, "api_key")).toEqual({
      ref: "{{secret:K}}",
      stored: false,
    });
    expect(savedSecretField({ api_key_enc: { ciphertext: "c", iv: "i" } }, "api_key")).toEqual({
      ref: "",
      stored: true,
    });
    // A legacy plain-text key: there, and never handed back.
    expect(savedSecretField({ api_key: "sk-legacy" }, "api_key")).toEqual({
      ref: "",
      stored: true,
    });
  });

  it("suggests names the database accepts", () => {
    expect(suggestSecretName("s3_access_key_id")).toBe("S3_ACCESS_KEY_ID");
    expect(suggestSecretName("Snowflake token")).toBe("SNOWFLAKE_TOKEN");
    expect(suggestSecretName("_x")).toBe("X");
    expect(suggestSecretName("1password")).toBe("KEY_1PASSWORD");
    expect(suggestSecretName("")).toBe("");
    for (const s of ["a-b", "x".repeat(80), "9", "--"]) {
      const n = suggestSecretName(s);
      if (n) expect(isSecretName(n), n).toBe(true);
    }
  });
});
