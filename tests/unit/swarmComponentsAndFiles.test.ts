// Custom components + file input fields.
//
// Both features turn user-supplied things into what the runtime already
// understands: a component becomes a `function` node carrying a code snapshot
// and typed params; a file becomes plain TEXT in flow state. The rules that
// make that safe and predictable are pinned here and mutation-verified.
import { describe, expect, it } from "vitest";
import {
  bindingFor,
  coerceParams,
  componentOutdated,
  defaultValues,
  missingRequired,
  validateComponent,
  type ComponentParam,
  type SwarmComponent,
} from "@/lib/swarmComponents";
import {
  clampExtracted,
  fileTooLarge,
  readFileField,
  FILE_INPUT_MAX_BYTES,
  FILE_INPUT_MAX_CHARS,
} from "@/lib/swarmFileInput";

const P = (over: Partial<ComponentParam> & { name: string }): ComponentParam => ({
  type: "text",
  ...over,
});

const COMP: SwarmComponent = {
  id: "c1",
  name: "Truncate",
  description: "cuts text",
  category: "Custom",
  params: [P({ name: "limit", type: "number", default: "10" }), P({ name: "suffix" })],
  code: "return String(ctx.input).slice(0, ctx.params.limit);",
  version: 3,
};

describe("validateComponent", () => {
  it("accepts a sane component", () => {
    expect(validateComponent(COMP)).toBeNull();
  });

  it("rejects bad names, empty code and oversized code", () => {
    expect(validateComponent({ ...COMP, name: " " })).toMatch(/Name must/);
    expect(validateComponent({ ...COMP, name: "-leading" })).toMatch(/Name must/);
    expect(validateComponent({ ...COMP, code: "   " })).toMatch(/needs some code/);
    expect(validateComponent({ ...COMP, code: "x".repeat(20_001) })).toMatch(/limit is/);
  });

  it("rejects invalid, duplicate and under-specified parameters", () => {
    expect(validateComponent({ ...COMP, params: [P({ name: "2bad" })] })).toMatch(/identifier/);
    expect(validateComponent({ ...COMP, params: [P({ name: "a" }), P({ name: "a" })] })).toMatch(
      /declared twice/,
    );
    expect(validateComponent({ ...COMP, params: [P({ name: "mode", type: "select" })] })).toMatch(
      /at least one option/,
    );
  });
});

describe("coerceParams", () => {
  it("gives the snippet typed values, not strings", () => {
    const out = coerceParams(
      [
        P({ name: "limit", type: "number" }),
        P({ name: "loud", type: "boolean" }),
        P({ name: "tag" }),
      ],
      { limit: "12", loud: "true", tag: "x" },
    );
    expect(out).toEqual({ limit: 12, loud: true, tag: "x" });
    expect(typeof out.limit).toBe("number");
    expect(typeof out.loud).toBe("boolean");
  });

  it("falls back to declared defaults, and maps unparseable numbers to null", () => {
    expect(coerceParams([P({ name: "limit", type: "number", default: "7" })], {})).toEqual({
      limit: 7,
    });
    expect(coerceParams([P({ name: "limit", type: "number" })], { limit: "abc" })).toEqual({
      limit: null,
    });
  });

  it("treats only true/1/yes as boolean true", () => {
    const b = (v: string) => coerceParams([P({ name: "f", type: "boolean" })], { f: v }).f;
    expect([b("true"), b("1"), b("yes")]).toEqual([true, true, true]);
    expect([b("false"), b("0"), b(""), b("no")]).toEqual([false, false, false, false]);
  });
});

describe("missingRequired", () => {
  it("reports required params with no value and ignores satisfied ones", () => {
    const params = [
      P({ name: "a", required: true }),
      P({ name: "b", required: true, default: "d" }),
      P({ name: "c" }),
    ];
    expect(missingRequired(params, {})).toEqual(["a"]);
    expect(missingRequired(params, { a: "  " })).toEqual(["a"]);
    expect(missingRequired(params, { a: "set" })).toEqual([]);
  });
});

describe("bindingFor", () => {
  it("snapshots code, schema and version onto the node", () => {
    const b = bindingFor(COMP);
    expect(b.componentId).toBe("c1");
    expect(b.componentVersion).toBe(3);
    expect(b.functionCode).toBe(COMP.code);
    expect(b.componentParams).toEqual(COMP.params);
    expect(b.componentValues).toEqual({ limit: "10", suffix: "" });
  });

  it("preserves values the user already configured when re-binding", () => {
    const b = bindingFor(COMP, { limit: "99", gone: "stale" });
    expect(b.componentValues.limit).toBe("99");
    // A param that no longer exists must not survive an update.
    expect(b.componentValues.gone).toBeUndefined();
  });
});

describe("componentOutdated", () => {
  const lib = [{ id: "c1", version: 5 }];
  it("is true only when the library moved past the node's snapshot", () => {
    expect(componentOutdated({ componentId: "c1", componentVersion: 3 }, lib)).toBe(true);
    expect(componentOutdated({ componentId: "c1", componentVersion: 5 }, lib)).toBe(false);
    expect(componentOutdated({ componentId: "c1", componentVersion: 6 }, lib)).toBe(false);
  });
  it("is false for unbound nodes and deleted components", () => {
    expect(componentOutdated({}, lib)).toBe(false);
    expect(componentOutdated({ componentId: "gone", componentVersion: 1 }, lib)).toBe(false);
  });
});

describe("defaultValues", () => {
  it("seeds declared defaults, and booleans start false rather than empty", () => {
    expect(
      defaultValues([
        P({ name: "a", default: "x" }),
        P({ name: "b", type: "boolean" }),
        P({ name: "c" }),
      ]),
    ).toEqual({ a: "x", b: "false", c: "" });
  });
});

// ── File input fields ───────────────────────────────────────────────────────

describe("file input caps", () => {
  it("rejects files over the byte cap, accepts at the cap", () => {
    expect(fileTooLarge(FILE_INPUT_MAX_BYTES + 1)).toBe(true);
    expect(fileTooLarge(FILE_INPUT_MAX_BYTES)).toBe(false);
  });

  it("passes short text through untouched", () => {
    const r = clampExtracted("hello");
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
    expect(r.originalChars).toBe(5);
  });

  it("truncates long text and SAYS SO — never silently", () => {
    const long = "x".repeat(FILE_INPUT_MAX_CHARS + 500);
    const r = clampExtracted(long);
    expect(r.truncated).toBe(true);
    expect(r.originalChars).toBe(FILE_INPUT_MAX_CHARS + 500);
    expect(r.text.startsWith("x".repeat(100))).toBe(true);
    expect(r.text).toContain("truncated");
    expect(r.text).toContain("500 more characters");
  });
});

describe("readFileField", () => {
  it("returns extracted text with its metadata", async () => {
    const res = await readFileField({ name: "notes.txt", size: 12 }, async () => "  hello world  ");
    expect(res.text).toBe("hello world");
    expect(res.fileName).toBe("notes.txt");
    expect(res.truncated).toBe(false);
  });

  it("refuses an oversized file before parsing it", async () => {
    let parsed = false;
    await expect(
      readFileField({ name: "big.pdf", size: FILE_INPUT_MAX_BYTES + 1 }, async () => {
        parsed = true;
        return "text";
      }),
    ).rejects.toThrow(/limit is/);
    expect(parsed).toBe(false);
  });

  it("refuses a document that yielded no text (e.g. a scanned PDF)", async () => {
    await expect(
      readFileField({ name: "scan.pdf", size: 100 }, async () => "   \n  "),
    ).rejects.toThrow(/No text could be extracted/);
  });

  it("reports truncation on a very long document", async () => {
    const res = await readFileField({ name: "book.pdf", size: 1000 }, async () =>
      "y".repeat(FILE_INPUT_MAX_CHARS + 10),
    );
    expect(res.truncated).toBe(true);
    expect(res.originalChars).toBe(FILE_INPUT_MAX_CHARS + 10);
  });
});
