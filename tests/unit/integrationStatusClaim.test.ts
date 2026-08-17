// The Integration Hub's badges, and what they may claim about a failed read.
//
// Module 16 of the adversarial pass. The defect this pins is unusual in the
// campaign only in its vocabulary: /integrations has no count and no empty
// state, so the false claim was made by OMISSION. A connected provider whose
// read had 403'd rendered exactly like one that was never configured — no
// badge, no Disconnect, no error — beside a Configure button inviting the user
// to paste the API key in again.
//
// Live evidence for every case below is in docs/ADVERSARIAL_LOG.md; the
// injection was confirmed by the request being intercepted, never inferred
// from what rendered.
import { describe, expect, it } from "vitest";
import {
  integrationsReadNotice,
  mayOfferDisconnect,
  providerBadge,
  type ProviderFacts,
  type StatusReadState,
} from "@/lib/integrationStatusClaim";

const OK: StatusReadState = { loaded: true, error: null };
const FAILED: StatusReadState = { loaded: true, error: "permission denied for table integrations" };
const PENDING: StatusReadState = { loaded: false, error: null };

const facts = (over: Partial<ProviderFacts> = {}): ProviderFacts => ({
  active: false,
  saved: false,
  shared: false,
  unhealthy: false,
  ...over,
});

describe("providerBadge", () => {
  describe("when the read succeeded", () => {
    it("says connected for an active provider", () => {
      expect(providerBadge(OK, facts({ active: true }))).toBe("connected");
    });

    it("keeps the health warning on an active provider whose last check failed", () => {
      expect(providerBadge(OK, facts({ active: true, unhealthy: true }))).toBe(
        "connected-unhealthy",
      );
    });

    it("says saved-failed for a row that exists but is not active", () => {
      expect(providerBadge(OK, facts({ saved: true }))).toBe("saved-failed");
    });

    it("prefers the provider's own credential over a shared one", () => {
      // Both true is the real case after an admin grant AND a personal key:
      // the personal key is what the agents will use, so it is what shows.
      expect(providerBadge(OK, facts({ active: true, shared: true }))).toBe("connected");
    });

    it("says shared when the only access is an admin's grant", () => {
      expect(providerBadge(OK, facts({ shared: true }))).toBe("shared");
    });

    it("says nothing for a provider that was never configured", () => {
      expect(providerBadge(OK, facts())).toBe("none");
    });
  });

  describe("when the read failed", () => {
    it("refuses to call a connected provider unconfigured", () => {
      // THE finding. `active` is false here for the same reason every other
      // fact is false: the rows never arrived.
      expect(providerBadge(FAILED, facts())).toBe("unknown");
    });

    it("stays unknown even when stale rows still say connected", () => {
      expect(providerBadge(FAILED, facts({ active: true }))).toBe("unknown");
    });

    it("outranks every other fact", () => {
      expect(providerBadge(FAILED, facts({ active: true, saved: true, shared: true }))).toBe(
        "unknown",
      );
    });
  });

  describe("before the read returns", () => {
    it("does not claim not-connected on first paint", () => {
      // First paint happens on every visit, so this is the case users
      // actually hit rather than the exotic one.
      expect(providerBadge(PENDING, facts())).toBe("unknown");
    });
  });
});

describe("mayOfferDisconnect", () => {
  it("offers to disconnect a provider a successful read found active", () => {
    expect(mayOfferDisconnect(OK, facts({ active: true }))).toBe(true);
  });

  it("does not offer it when the read failed", () => {
    // The button is a WRITE. On a failed read it would resolve `existing` to
    // undefined and silently do nothing — a dead control, not a refusal.
    expect(mayOfferDisconnect(FAILED, facts({ active: true }))).toBe(false);
  });

  it("does not offer it before the read returns", () => {
    expect(mayOfferDisconnect(PENDING, facts({ active: true }))).toBe(false);
  });

  it("does not offer it for a provider that is not active", () => {
    expect(mayOfferDisconnect(OK, facts({ saved: true }))).toBe(false);
  });
});

describe("integrationsReadNotice", () => {
  it("says nothing when the read succeeded", () => {
    expect(integrationsReadNotice(OK)).toBeNull();
  });

  it("says nothing while the read is still in flight", () => {
    expect(integrationsReadNotice(PENDING)).toBeNull();
  });

  it("names the reason the read failed", () => {
    expect(integrationsReadNotice(FAILED)).toContain("permission denied for table integrations");
  });

  it("tells the user their credentials are still there", () => {
    // The failure mode being fixed is a user concluding their keys are gone
    // and typing them in again, so the reassurance is load-bearing copy.
    expect(integrationsReadNotice(FAILED)).toMatch(/still connected/);
  });
});
