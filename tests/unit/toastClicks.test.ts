// A toast takes its own clicks, even over an open dialog (found in the R527
// UI test): a dialog sets pointer-events: none on the rest of the page, a
// toast drawn over the approvals inbox could not be clicked, and a press on its
// Review button went through it and approved the card beneath.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("toasts over a dialog", () => {
  it("the toaster and every toast take pointer events", () => {
    const src = readFileSync("src/components/ui/sonner.tsx", "utf8");
    expect(src).toContain('className="toaster group pointer-events-auto"');
    expect(src).toMatch(/toast:\s*\n?\s*"group toast pointer-events-auto /);
  });

  it("there is one toaster, the one that carries the rule", () => {
    const root = readFileSync("src/routes/__root.tsx", "utf8");
    expect(root).toContain('import { Toaster } from "@/components/ui/sonner";');
    expect(root).not.toMatch(/from "sonner";\s*$/m);
  });
});
