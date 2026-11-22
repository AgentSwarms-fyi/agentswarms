// A page change happens even when it cannot be animated (found in R519's UI
// test: in a hidden tab the browser aborts the view transition and the router
// never committed the new page).
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canAnimatePageChange, guardViewTransitions } from "@/lib/viewTransitionGuard";

function fakeRouter() {
  return {
    shouldViewTransition: { types: ["x"] } as unknown,
    // As a hidden document's transition behaves: rejects, never runs the update.
    startViewTransition: vi.fn(async (_fn: () => Promise<void>) => {
      throw new DOMException(
        "Transition was aborted because of invalid state. Document hidden",
        "InvalidStateError",
      );
    }),
  };
}

describe("a page change in a document nobody can see", () => {
  it("changes the page straight away, without the transition", async () => {
    const r = fakeRouter();
    const animated = r.startViewTransition;
    guardViewTransitions(r, () => ({ visibilityState: "hidden" }));
    const update = vi.fn(async () => undefined);
    await expect(r.startViewTransition(update)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
    expect(animated).not.toHaveBeenCalled();
    expect(r.shouldViewTransition).toBeUndefined();
  });

  it("still animates when the document is visible", async () => {
    const r = fakeRouter();
    r.startViewTransition = vi.fn(async (fn: () => Promise<void>) => fn());
    const animated = r.startViewTransition;
    guardViewTransitions(r, () => ({ visibilityState: "visible" }));
    const update = vi.fn(async () => undefined);
    await r.startViewTransition(update);
    expect(animated).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });

  it("does not animate where there is no document (the server)", () => {
    expect(canAnimatePageChange(undefined)).toBe(false);
    expect(canAnimatePageChange({ visibilityState: "hidden" })).toBe(false);
    expect(canAnimatePageChange({ visibilityState: "visible" })).toBe(true);
  });

  it("is what the app's router is built with", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/router.tsx"), "utf8");
    expect(src).toMatch(/return guardViewTransitions\(router\);/);
  });
});
