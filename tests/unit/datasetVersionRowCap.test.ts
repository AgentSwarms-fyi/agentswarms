// DATASET_VERSION_ROW_CAP: empty means the default, not zero.
//
// FOUND IN R485: versionRowCap() read `Number(process.env.DATASET_VERSION_ROW_CAP)`
// and accepted anything `>= 0`. Number("") is 0, so a DATASET_VERSION_ROW_CAP=""
// line, which Compose passes in as set-but-empty, quietly made every dataset
// version metadata-only: an overwrite could no longer be undone, and nothing
// said so. Every other cap treats empty as unset. An explicit 0 still means
// "metadata only, for every dataset".
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { versionRowCap, versionsKept } from "@/utils/bi/versions.server";

afterEach(() => vi.unstubAllEnvs());

describe("versionRowCap", () => {
  it("defaults to 20,000 when unset", () => {
    vi.stubEnv("DATASET_VERSION_ROW_CAP", undefined);
    expect(versionRowCap()).toBe(20_000);
  });

  it("treats an empty value as unset, not as 0", () => {
    vi.stubEnv("DATASET_VERSION_ROW_CAP", "");
    // Before R486: 0, which turned off row snapshots for every dataset.
    expect(versionRowCap()).toBe(20_000);
  });

  it("treats a value of only spaces as unset", () => {
    vi.stubEnv("DATASET_VERSION_ROW_CAP", "   ");
    expect(versionRowCap()).toBe(20_000);
  });

  it("keeps an explicit 0 as metadata only", () => {
    vi.stubEnv("DATASET_VERSION_ROW_CAP", "0");
    expect(versionRowCap()).toBe(0);
  });

  it("takes a number that is set", () => {
    vi.stubEnv("DATASET_VERSION_ROW_CAP", " 50000 ");
    expect(versionRowCap()).toBe(50_000);
  });

  it("ignores a value that is not a count", () => {
    for (const bad of ["-1", "abc", "Infinity"]) {
      vi.stubEnv("DATASET_VERSION_ROW_CAP", bad);
      expect(versionRowCap(), bad).toBe(20_000);
    }
  });
});

describe("versionsKept", () => {
  it("treats an empty value as unset", () => {
    vi.stubEnv("DATASET_VERSION_KEEP", "");
    expect(versionsKept()).toBe(5);
  });
});
