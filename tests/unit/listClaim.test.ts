// A list may not say "you have none" when it means "I could not find out".
//
// MEASURED on /notebooks before the fix, with a 403 on the list query only:
//   {"badgeText":"0","saysNoNotebooks":true,"anyErrorWordOnScreen":false}
// for an account holding three notebooks. The read's error was discarded —
// only `data` was destructured, and `data` is null on failure — so a refused
// read and an empty account rendered identically, down to the invitation to
// create your first one.
import { describe, expect, it } from "vitest";

import { listClaim, mayAutosave, UNKNOWN_COUNT } from "@/lib/listClaim";

describe("listClaim", () => {
  describe("a failed read claims nothing", () => {
    it("does not print a count", () => {
      const c = listClaim({ loaded: true, error: "permission denied", count: 0 });
      expect(c.countLabel).toBe(UNKNOWN_COUNT);
      // Specifically not "0" — that was the badge the page actually showed
      // to an account with three notebooks.
      expect(c.countLabel).not.toBe("0");
    });

    it("asks for the error message, never the empty state", () => {
      const c = listClaim({ loaded: true, error: "permission denied", count: 0 });
      expect(c.message).toBe("error");
      expect(c.message).not.toBe("empty");
    });

    it("is distinguishable from a genuinely empty account", () => {
      const failed = listClaim({ loaded: true, error: "boom", count: 0 });
      const empty = listClaim({ loaded: true, error: null, count: 0 });
      // The two states the user could not tell apart on screen.
      expect(failed).not.toEqual(empty);
      expect(failed.countLabel).not.toBe(empty.countLabel);
      expect(failed.message).not.toBe(empty.message);
    });

    it("outranks rows left over from an earlier successful read", () => {
      // The rows are stale, so their length is not the current count.
      const c = listClaim({ loaded: true, error: "boom", count: 3 });
      expect(c.countLabel).toBe(UNKNOWN_COUNT);
      expect(c.message).toBe("error");
    });

    it("reports the error even if the read never completed", () => {
      const c = listClaim({ loaded: false, error: "network", count: 0 });
      expect(c.message).toBe("error");
    });
  });

  describe("before the read returns", () => {
    it("prints no count", () => {
      const c = listClaim({ loaded: false, error: null, count: 0 });
      expect(c.countLabel).toBe(UNKNOWN_COUNT);
    });

    it("says nothing at all — not empty, not error", () => {
      const c = listClaim({ loaded: false, error: null, count: 0 });
      expect(c.message).toBe("none");
    });
  });

  describe("a successful read", () => {
    it("may state a zero it actually observed", () => {
      const c = listClaim({ loaded: true, error: null, count: 0 });
      expect(c.countLabel).toBe("0");
      expect(c.message).toBe("empty");
    });

    it("prints the count and adds no note when there are rows", () => {
      const c = listClaim({ loaded: true, error: null, count: 3 });
      expect(c.countLabel).toBe("3");
      expect(c.message).toBe("none");
    });

    it("prints the count exactly", () => {
      for (const n of [1, 2, 7, 42]) {
        expect(listClaim({ loaded: true, error: null, count: n }).countLabel).toBe(String(n));
      }
    });
  });

  describe("the invariant, over every combination", () => {
    it("only ever prints a number when the read succeeded and returned", () => {
      const inputs = [
        { loaded: false, error: null, count: 0 },
        { loaded: false, error: null, count: 3 },
        { loaded: false, error: "x", count: 0 },
        { loaded: false, error: "x", count: 3 },
        { loaded: true, error: "x", count: 0 },
        { loaded: true, error: "x", count: 3 },
        { loaded: true, error: null, count: 0 },
        { loaded: true, error: null, count: 3 },
      ];
      for (const input of inputs) {
        const label = listClaim(input).countLabel;
        const printedANumber = label !== UNKNOWN_COUNT;
        const readSucceeded = input.loaded && !input.error;
        expect(printedANumber).toBe(readSucceeded);
      }
    });

    it("only ever says 'empty' when the read succeeded and saw nothing", () => {
      const inputs = [
        { loaded: false, error: null, count: 0 },
        { loaded: false, error: "x", count: 0 },
        { loaded: true, error: "x", count: 0 },
        { loaded: true, error: null, count: 0 },
        { loaded: true, error: null, count: 1 },
      ];
      for (const input of inputs) {
        const saysEmpty = listClaim(input).message === "empty";
        expect(saysEmpty).toBe(input.loaded && !input.error && input.count === 0);
      }
    });
  });
});

// The notebook editor tells a user whose read failed: "It has not been deleted;
// nothing was saved over it." VERIFIED live — the read was failed, the 1200ms
// debounce was waited out, and all three notebook rows came back byte-identical
// with updated_at unchanged and zero writes attempted. mayAutosave is the only
// thing standing between that sentence and a false promise.
describe("mayAutosave", () => {
  it("refuses when the editor never loaded", () => {
    // The exact state after a failed read. Writing here saves an editor that
    // holds nothing over a notebook that holds something.
    expect(mayAutosave({ hydrated: false, cells: null })).toBe(false);
  });

  it("refuses when the editor never loaded even if cells look present", () => {
    // Guards the refactor that defaults cells to [] rather than null: without
    // the hydrated check this is the call that blanks a real notebook.
    expect(mayAutosave({ hydrated: false, cells: [] })).toBe(false);
    expect(mayAutosave({ hydrated: false, cells: [{ id: "c1" }] })).toBe(false);
  });

  it("refuses while a load is in flight and cells are still null", () => {
    expect(mayAutosave({ hydrated: true, cells: null })).toBe(false);
  });

  it("allows a save once the editor holds a loaded document", () => {
    expect(mayAutosave({ hydrated: true, cells: [{ id: "c1" }] })).toBe(true);
  });

  it("allows saving a notebook the user emptied themselves", () => {
    // Deleting every cell is a real edit, and it is distinguishable from an
    // un-hydrated editor by `hydrated`, not by the cells.
    expect(mayAutosave({ hydrated: true, cells: [] })).toBe(true);
  });

  it("requires both conditions, over every combination", () => {
    for (const hydrated of [true, false]) {
      for (const cells of [null, [], [{ id: "c1" }]]) {
        expect(mayAutosave({ hydrated, cells })).toBe(hydrated && cells !== null);
      }
    }
  });
});
