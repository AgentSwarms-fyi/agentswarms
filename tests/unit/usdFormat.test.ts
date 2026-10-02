// One way to show a cost, so a priced call never reads as free (R202).
//
// FOUND IN R202: Prompt Compare ran Gemini 2.5 Flash and GPT-5 Mini on "Reply
// with the single word OK." and showed Flash's 7-in, 1-out call as
// "~$0.0000", beside its own note that a model without a known price shows
// ~$0. Traces listed the same call as $0.0000, as it lists a free model's.
// Each page wrote its own: toFixed(4) on most, toFixed(6) on the playground's
// trace, "$0" on Evaluations, "$0.00" on the spend panel.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatUsd } from "@/lib/usd";

describe("formatUsd", () => {
  it("keeps two significant digits under a cent", () => {
    expect(formatUsd(0.0000046)).toBe("$0.0000046");
    expect(formatUsd(0.00011)).toBe("$0.00011");
    expect(formatUsd(0.0054)).toBe("$0.0054");
    expect(formatUsd(0.00000046)).toBe("$0.00000046");
    expect(formatUsd(4e-10)).toBe("<$0.00000001");
    // What the database holds for that call, to 6 places, without a trailing 0.
    expect(formatUsd(0.000005)).toBe("$0.000005");
    expect(formatUsd(0.005)).toBe("$0.005");
  });

  it("writes cents to four places and dollars to two", () => {
    expect(formatUsd(0.0123456)).toBe("$0.0123");
    expect(formatUsd(0.5)).toBe("$0.5000");
    expect(formatUsd(1234.567)).toBe("$1,234.57");
  });

  it("says zero, nothing and an estimate plainly", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd("0.0000046")).toBe("$0.0000046");
    expect(formatUsd(0.0000046, { approx: true })).toBe("~$0.0000046");
    expect(formatUsd(-0.0000046)).toBe("-$0.0000046");
  });
});

/** Every .ts and .tsx file under src. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("every page", () => {
  it("shows a cost through formatUsd, or in whole cents", () => {
    // These store or export a figure as data, not as text a person reads.
    const data = new Set([
      "src/routes/api/chat.ts",
      "src/routes/api/metrics.ts",
      "src/utils/observability.functions.ts",
    ]);
    const found: string[] = [];
    for (const file of sources("src")) {
      const rel = file.replace(/\\/g, "/");
      if (rel === "src/lib/usd.ts" || data.has(rel)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (
            /toFixed\((3|4|5|6|7|8)\)/.test(line) &&
            /cost|usd|spend|amount|price|\$\$\{|~\$\{/i.test(line)
          ) {
            found.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(found).toEqual([]);
  });
});
