// R117: a prompt opened on its Cancel button. Radix's AlertDialog focuses
// Cancel when it opens, which beat the text box's autoFocus, so typing went
// nowhere and Enter cancelled: Rename, Row height, Custom number format and
// every other promptAsk in the app. The driven proof is in
// docs/UI_TEST_RESULTS.md; this pins the fix so it cannot quietly go back.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const src = readFileSync(resolve(process.cwd(), "src/components/ui/confirm-dialog.tsx"), "utf8");

describe("a prompt takes the keyboard in its text box", () => {
  it("moves focus to the input when the dialog asks for text", () => {
    const content = src.slice(
      src.indexOf("<AlertDialogContent"),
      src.indexOf("<AlertDialogHeader>"),
    );
    expect(content).toContain("onOpenAutoFocus");
    expect(content).toMatch(/if \(!wantsText\) return;/);
    expect(content).toContain("e.preventDefault();");
    expect(content).toContain("inputRef.current?.focus();");
  });

  it("leaves a yes/no confirmation on Cancel, and gives the input its ref", () => {
    // Returning before preventDefault keeps Radix's safe default for confirms.
    const handler = src.slice(src.indexOf("onOpenAutoFocus"), src.indexOf("<AlertDialogHeader>"));
    expect(handler.indexOf("if (!wantsText) return;")).toBeLessThan(
      handler.indexOf("e.preventDefault();"),
    );
    expect(src).toMatch(/<Input\s+ref=\{inputRef\}/);
    // autoFocus lost to Radix; it must not come back as the only mechanism.
    expect(src).not.toMatch(/<Input\s+autoFocus/);
  });
});
