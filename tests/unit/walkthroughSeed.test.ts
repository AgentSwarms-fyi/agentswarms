// The walkthrough's numbers have to be the data's numbers.
//
// docs/END_TO_END_DATA_AND_AI.md quotes a row count, a net revenue total, a
// naive total and the share of revenue an INNER join would discard. Those were
// previously measured once from a dataset nobody could regenerate — so when the
// object store holding it was lost, every figure in the document became
// unfalsifiable, and there was no way to tell a typo from a regression.
//
// scripts/seed-revenue-walkthrough.mjs now produces that dataset deterministically
// AND computes the expected answers in plain arithmetic. This test runs it and
// checks the document still agrees. If someone changes the generator's shape,
// this fails and names the figures to update.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DOC = readFileSync(resolve(process.cwd(), "docs/END_TO_END_DATA_AND_AI.md"), "utf8");

let out = "";
let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agentswarms-seed-"));
  out = execFileSync(process.execPath, ["scripts/seed-revenue-walkthrough.mjs", dir], {
    encoding: "utf8",
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A figure from the generator's own report. */
const figure = (label: RegExp): string => {
  const m = label.exec(out);
  if (!m) throw new Error(`generator did not report ${label} — output was:\n${out}`);
  return m[1];
};

/** "408332.36" -> "408,332.36", the form the prose uses. */
const grouped = (n: string) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 });

describe("the walkthrough document matches the data it describes", () => {
  it("quotes the row count the pipeline loads", () => {
    const rows = figure(/rows loaded\s*:\s*(\d+)/);
    expect(rows).toBe("836"); // 900 orders - 64 cancelled
    expect(DOC).toContain(`rows loaded: ${rows}`);
  });

  it("quotes the net revenue total", () => {
    const net = figure(/net revenue \(USD\)\s*:\s*([\d.]+)/);
    expect(DOC).toContain(grouped(net));
    // And nowhere still claims the pre-regeneration figure.
    expect(DOC).not.toContain("453,202.39");
  });

  it("quotes the naive total and its error", () => {
    expect(DOC).toContain(grouped(figure(/naive total\s*:\s*([\d.]+)/)));
    expect(DOC).toContain(`${figure(/error\s*:\s*-?([\d.]+)%/)}% low`);
  });

  it("quotes what the LEFT join rescues", () => {
    const worth = figure(/worth ([\d.]+) USD/);
    const pct = figure(/worth [\d.]+ USD \(([\d.]+)%/);
    expect(DOC).toContain(grouped(worth));
    expect(DOC).toContain(`${pct}%`);
  });

  it("still tells the reader how to regenerate it", () => {
    // The whole point: a walkthrough whose inputs cannot be reproduced is a
    // story, not a test.
    expect(DOC).toContain("scripts/seed-revenue-walkthrough.mjs");
  });
});

describe("the generator is deterministic", () => {
  it("produces identical output on a second run", () => {
    // A fixed seed is what lets the document quote exact figures at all.
    const second = mkdtempSync(join(tmpdir(), "agentswarms-seed-"));
    try {
      const again = execFileSync(
        process.execPath,
        ["scripts/seed-revenue-walkthrough.mjs", second],
        {
          encoding: "utf8",
        },
      );
      const totals = (s: string) => s.slice(s.indexOf("ground truth"));
      expect(totals(again)).toBe(totals(out));
      for (const f of [
        "payments/payments.csv",
        "orders/orders.csv",
        "customers/customers.csv",
        "customers/customers_batch2.csv",
        "fx_rates/fx_rates.csv",
      ]) {
        expect(readFileSync(join(second, f), "utf8"), f).toBe(readFileSync(join(dir, f), "utf8"));
      }
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("uses no clock and no unseeded randomness", () => {
    const src = readFileSync(
      resolve(process.cwd(), "scripts/seed-revenue-walkthrough.mjs"),
      "utf8",
    );
    // Comments stripped first: the script explains at length WHY it avoids
    // Math.random(), and matching that prose would fail on the explanation
    // rather than on a call. (This assertion did exactly that when written.)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Math\.random\s*\(/);
    // `new Date(Date.UTC(...))` is fine — it is arithmetic on fixed numbers.
    // A clock read is not.
    expect(code).not.toMatch(/Date\.now\s*\(|new Date\s*\(\s*\)/);
  });
});
