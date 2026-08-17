// The "Running kernels" panel is only allowed to say what it actually knows.
//
// MEASURED before the fix: with /api/notebook/runtime returning 503, the page
// rendered {"panelVisible":false,"pageMentionsKernel":true,"anyErrorOnScreen":false}
// — the panel silently absent, which on this page is read as "you have no
// kernels running". It is the one page you visit BECAUSE you were told you
// already have the maximum, so the failure mode contradicted the reason for
// the visit and hid the Refresh button that could have corrected it.
import { describe, expect, it } from "vitest";

import { kernelPanelState } from "@/lib/kernelPanelState";

const session = { id: "s1" };

describe("kernelPanelState", () => {
  describe("a failed read is not an empty list", () => {
    it("keeps the panel visible when the runtime could not be read", () => {
      const s = kernelPanelState({
        enabled: true,
        sessions: [],
        error: "Runtime container is not reachable.",
      });
      // The whole defect in one assertion: this used to be false, which is
      // indistinguishable from having no kernels.
      expect(s.visible).toBe(true);
      expect(s.showError).toBe(true);
    });

    it("claims no count at all rather than zero", () => {
      const s = kernelPanelState({ enabled: true, sessions: [], error: "boom" });
      // Not 0. "0 live" is a claim about the runtime that a failed read
      // cannot support, and it is the exact claim that would mislead here.
      expect(s.liveCount).toBeNull();
    });

    it("renders differently from a runtime that answered zero", () => {
      const failed = kernelPanelState({ enabled: true, sessions: [], error: "boom" });
      const answered = kernelPanelState({ enabled: true, sessions: [], error: null });
      // The property that matters is not either value on its own — it is that
      // the two are DISTINGUISHABLE. They were identical before the fix.
      expect(failed).not.toEqual(answered);
      expect(failed.visible).not.toBe(answered.visible);
    });

    it("stays visible on error even when the last known list had kernels", () => {
      const s = kernelPanelState({ enabled: true, sessions: [session], error: "stale" });
      expect(s.visible).toBe(true);
      expect(s.showError).toBe(true);
      // A list kept from before the failure is not a live count either.
      expect(s.liveCount).toBeNull();
    });

    it("keeps the panel when the runtime has never answered but failed", () => {
      // First load failed outright: sessions was never populated.
      const s = kernelPanelState({ enabled: true, sessions: null, error: "network" });
      expect(s.visible).toBe(true);
      expect(s.showError).toBe(true);
    });
  });

  describe("a runtime that answered", () => {
    it("hides the panel when it genuinely reported none", () => {
      const s = kernelPanelState({ enabled: true, sessions: [], error: null });
      expect(s.visible).toBe(false);
      expect(s.showError).toBe(false);
    });

    it("shows the panel and the count when kernels are live", () => {
      const s = kernelPanelState({ enabled: true, sessions: [session, { id: "s2" }], error: null });
      expect(s.visible).toBe(true);
      expect(s.liveCount).toBe(2);
      expect(s.showError).toBe(false);
    });

    it("does not show the error banner on a successful read", () => {
      const s = kernelPanelState({ enabled: true, sessions: [session], error: null });
      expect(s.showError).toBe(false);
    });
  });

  describe("still loading", () => {
    it("stays hidden before the first answer", () => {
      // No error and no data yet: nothing has gone wrong, and nothing is known.
      const s = kernelPanelState({ enabled: true, sessions: null, error: null });
      expect(s.visible).toBe(false);
      expect(s.liveCount).toBeNull();
    });
  });

  describe("the feature is switched off", () => {
    it("stays hidden even with an error", () => {
      // No server runtime configured for this deployment: there is no claim to
      // get wrong, and an error banner about a feature you do not have is noise.
      const s = kernelPanelState({ enabled: false, sessions: [], error: "boom" });
      expect(s.visible).toBe(false);
      expect(s.showError).toBe(false);
    });

    it("stays hidden even with live sessions", () => {
      const s = kernelPanelState({ enabled: false, sessions: [session], error: null });
      expect(s.visible).toBe(false);
    });
  });

  describe("liveCount is never a guess", () => {
    it("is null in every state where the runtime has not confirmed a number", () => {
      const unconfirmed = [
        { enabled: true, sessions: null, error: null },
        { enabled: true, sessions: null, error: "x" },
        { enabled: true, sessions: [], error: "x" },
        { enabled: true, sessions: [session], error: "x" },
        { enabled: false, sessions: [session], error: null },
      ];
      for (const input of unconfirmed) {
        expect(kernelPanelState(input).liveCount).toBeNull();
      }
    });

    it("equals the reported length exactly when the runtime answered", () => {
      for (const n of [1, 2, 5]) {
        const sessions = Array.from({ length: n }, (_, i) => ({ id: `s${i}` }));
        expect(kernelPanelState({ enabled: true, sessions, error: null }).liveCount).toBe(n);
      }
    });
  });
});
