// A dialog's form is filled when the dialog opens, and at no other time.
//
// FOUND IN R215: the Semantic Layer's "Add metric to dashboard" dialog reset
// its form in an effect keyed on a `payload` object the page built inline.
// Every click inside the dialog re-rendered the page, so a typed title reverted
// and the BI project picked snapped back. These tests run the hook under a
// minimal stand-in for React's hook runtime: one slot per hook call, and an
// effect that runs after a render only when its dependencies changed, as
// React compares them (Object.is).
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const slots: unknown[] = [];
  const pending: (() => void)[] = [];
  let cursor = 0;
  return {
    slots,
    pending,
    begin() {
      cursor = 0;
    },
    next() {
      return cursor++;
    },
  };
});

vi.mock("react", () => ({
  useRef<T>(initial: T) {
    const i = runtime.next();
    if (!(i in runtime.slots)) runtime.slots[i] = { current: initial };
    return runtime.slots[i] as { current: T };
  },
  useEffect(effect: () => void, deps?: unknown[]) {
    const i = runtime.next();
    const prev = runtime.slots[i] as unknown[] | undefined;
    const changed =
      !prev || !deps || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]));
    if (changed) {
      runtime.slots[i] = deps;
      runtime.pending.push(effect);
    }
  },
}));

const { useResetOnOpen } = await import("@/hooks/use-reset-on-open");

/** The dialog's use of the hook: fill the form from this render's payload. */
function Dialog({
  open,
  payload,
  filled,
}: {
  open: boolean;
  payload: { title: string };
  filled: string[];
}) {
  useResetOnOpen(open, () => filled.push(payload.title));
}

/** One render of the dialog, then the effects whose dependencies changed. */
function render(open: boolean, payload: { title: string }, filled: string[]) {
  runtime.begin();
  Dialog({ open, payload, filled });
  for (const effect of runtime.pending.splice(0)) effect();
}

beforeEach(() => {
  runtime.slots.length = 0;
  runtime.pending.length = 0;
});

describe("useResetOnOpen", () => {
  it("fills the form once when the dialog opens, however often the page re-renders", () => {
    const filled: string[] = [];
    render(false, { title: "SaaS Sales model" }, filled);
    render(true, { title: "SaaS Sales model" }, filled);
    // The page re-renders with a new payload object each time, as the
    // Semantic Layer's inline `payload={…}` did on every click in the dialog.
    for (let i = 0; i < 3; i++) render(true, { title: "SaaS Sales model" }, filled);
    expect(filled).toEqual(["SaaS Sales model"]);
  });

  it("fills it again on the next opening, from that render's props", () => {
    const filled: string[] = [];
    render(true, { title: "Revenue by region" }, filled);
    render(false, { title: "Revenue by region" }, filled);
    render(true, { title: "Orders by month" }, filled);
    expect(filled).toEqual(["Revenue by region", "Orders by month"]);
  });

  it("does nothing while the dialog is closed", () => {
    const filled: string[] = [];
    render(false, { title: "a" }, filled);
    render(false, { title: "b" }, filled);
    expect(filled).toEqual([]);
  });
});

describe("the Add metric to dashboard dialog", () => {
  const src = readFileSync("src/components/bi/AddMetricToDashboardDialog.tsx", "utf8");

  it("fills its form through useResetOnOpen, and no effect watches the payload", () => {
    expect(src).toContain("useResetOnOpen(open, () => {");
    expect(src).not.toMatch(/\[[^\]]*\bpayload\b[^\]]*\]\);/);
  });
});
