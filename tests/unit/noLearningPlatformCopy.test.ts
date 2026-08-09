// This product is not the learning platform, and its copy should not say it is.
//
// AgentSwarms ships as two separate things from the same brand: a learning
// platform with courses and a certification exam, and this — a self-hosted
// agentic AI + BI platform. Copy from the first kept turning up in the second.
//
// The welcome email was one instance, already fixed. This is the rest: the
// Account page said the profile is "Shown on your certification certificate,
// if you earn one", the display-name hint said "used on your certificate", the
// docs repeated it, and the FIRST-RUN ONBOARDING DIALOG — the very first thing
// a new user sees — asked for their name "so we can print it on your
// certificate when you pass the certification exam".
//
// There is no certification in this repo. A self-hosted buyer evaluating a BI
// platform is being asked for their legal name to print on an exam certificate
// that does not exist, which reads as either a bait-and-switch or a copy-paste
// nobody noticed. Both are bad, and the second is true.
//
// `trust_server_certificate` is a real SQL Server connection option and is
// deliberately not matched.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Vocabulary that only makes sense on the learning platform. */
const LEARNING_PLATFORM = [
  /certification\s+certificate/i,
  /certification\s+exam/i,
  /pass\s+the\s+certification/i,
  /on\s+your\s+certificate\b/i,
  /\bcourse\s+completion\b/i,
  /\benrol(?:l)?ed\s+in\s+the\s+course\b/i,
];

describe("no learning-platform copy in the platform product", () => {
  const files = walk(resolve("src"));

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never promises a certificate this product cannot issue", () => {
    const hits: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const re of LEARNING_PLATFORM) {
        const m = re.exec(src);
        if (!m) continue;
        const line = src.slice(0, m.index).split("\n").length;
        hits.push(`${file.replace(/\\/g, "/").split("/src/")[1]}:${line}  "${m[0]}"`);
      }
    }
    expect(
      hits,
      "this is the self-hosted AI + BI platform, not the learning platform:\n  " +
        hits.join("\n  "),
    ).toEqual([]);
  });

  it("does not match the SQL Server connection option", () => {
    // Guard on the guard: `trust_server_certificate` must stay allowed, or the
    // warehouse form trips this rule and the rule gets deleted.
    const warehouse = readFileSync(
      resolve("src/components/integrations/WarehousesTab.tsx"),
      "utf8",
    );
    expect(warehouse).toContain("trust_server_certificate");
    for (const re of LEARNING_PLATFORM) expect(re.test(warehouse), String(re)).toBe(false);
  });
});
