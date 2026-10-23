// An MCP builder app's source, saved as you go (R280, sweep 8). Its autosave
// compared the editor with the source as LOADED, so typing back to that text
// after a save was never saved; a bare dirty flag that any returning save
// cleared erased an edit typed while the save was out; and the timer was
// cleared when the page unmounted, so a link inside its 1.2 s dropped the
// edit. The page is not rendered in unit tests; the wiring is pinned by
// reading its source. The leave decision itself is tested with R279's hook.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { holdForSave, saveFailureText } from "@/hooks/use-save-before-leave";

const src = readFileSync(
  join(process.cwd(), "src/routes/_authenticated/mcp-builder_.$appId.tsx"),
  "utf8",
);

describe("the MCP builder app editor", () => {
  it("compares the editor with what was last saved, not with what was loaded", () => {
    expect(src).toContain("const form = JSON.stringify({ source, requirements });");
    expect(src).toContain("const unsaved = app !== null && savedAs !== null && form !== savedAs;");
    expect(src).not.toMatch(/source === \(app\.source_code/);
    expect(src).not.toContain("dirtyRef");
  });

  it("records a load it adopts, and a save only once its reply has no error", () => {
    expect(src).toMatch(
      /if \(adopt \|\| !unsavedRef\.current\) \{[^}]*\};\s*setSource\(adopted\.source\);\s*setRequirements\(adopted\.requirements\);\s*setSavedAs\(JSON\.stringify\(adopted\)\);/,
    );
    // What was sent, taken before the await, so an edit typed meanwhile stays unsaved.
    expect(src).toMatch(
      /const sent = form;[^]*?setSaving\(\(n\) => n \+ 1\);[^]*?res = await saveFn\(/,
    );
    expect(src).toMatch(/return res\.error;\s*\}\s*setStale\(false\);\s*setSavedAs\(sent\);/);
  });

  it("autosaves only what is unsaved, and saves or asks before leaving", () => {
    expect(src).toMatch(
      /useEffect\(\(\) => \{\s*if \(!unsaved \|\| stale\) return;\s*const t = setTimeout\(/,
    );
    expect(src).toContain('useSaveBeforeLeave({ unsaved, saveNow, name: app?.name ?? "" });');
    // Before the early return, so it is called on every render.
    expect(src.indexOf("useSaveBeforeLeave({")).toBeLessThan(src.indexOf("  if (!app) {"));
  });

  it("does not deploy a source that could not be saved", () => {
    expect(src).toMatch(
      /const unsavedError = await saveNow\(\);\s*if \(unsavedError\) \{\s*toast\.error\(`Not deployed: the source could not be saved \(\$\{unsavedError\}\)\.`\);\s*return;\s*\}\s*setDeploying\(true\);/,
    );
  });

  it("lets a restore replace what the editor holds", () => {
    expect(src).toMatch(
      /\/\/ The restored source replaces whatever the editor holds\.\s*await reload\(true\);/,
    );
  });

  it("says when something is unsaved", () => {
    expect(src).toMatch(
      /: unsaved \? \(\s*<span data-testid="mcp-unsaved">Unsaved changes<\/span>/,
    );
  });
});

describe("saveFailureText", () => {
  // The error a server function's input check rejects with, made by zod itself.
  const refused = () => {
    const r = z
      .object({ requirements: z.string().max(5) })
      .safeParse({ requirements: "boto3==1.34.0" });
    if (r.success) throw new Error("expected a refusal");
    return new Error(r.error.message);
  };

  it("names the field and the reason instead of the validator's JSON", () => {
    const text = saveFailureText(refused());
    expect(text).toMatch(/^requirements: /);
    expect(text).toContain("5");
    expect(text).not.toContain("{");
  });

  it("passes a plain message through", () => {
    expect(saveFailureText(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(saveFailureText("offline")).toBe("offline");
    expect(saveFailureText(new Error("[]"))).toBe("[]");
  });

  it("is what a link is asked about when the save rejects", async () => {
    let asked = "";
    const saveNow = async (): Promise<string | null> => {
      throw refused();
    };
    expect(
      await holdForSave(saveNow, async (error) => {
        asked = error;
        return false;
      }),
    ).toBe(true);
    expect(asked).toMatch(/^requirements: /);
  });
});

describe("a save the server refuses", () => {
  it("is caught, counted out, and reported as a reason", () => {
    expect(src).toMatch(
      /try \{\s*res = await saveFn\(\{[^]*?\}\);\s*\} catch \(e\) \{\s*return saveFailureText\(e\);\s*\} finally \{\s*setSaving\(\(n\) => n - 1\);\s*\}/,
    );
  });
});
