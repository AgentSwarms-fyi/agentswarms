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

  it("quotes the per-plan AOV the pipeline actually produces", () => {
    // FOUND BY AUDIT. The plan block named `starter` and `growth`, which are
    // not plans this generator emits, and its order counts summed to a total
    // the same page contradicts two screens earlier. Nothing checked it,
    // because the earlier tests here pin only the headline figures.
    const facts = revenueFacts();
    const byPlan = new Map<string, { n: number; sum: number; cust: Set<string> }>();
    for (const f of facts) {
      const g = byPlan.get(f.plan) ?? { n: 0, sum: 0, cust: new Set<string>() };
      g.n += 1;
      g.sum += f.net;
      g.cust.add(f.customer);
      byPlan.set(f.plan, g);
    }
    expect(byPlan.size).toBe(4); // free, pro, enterprise and the (unknown) tier
    for (const [plan, g] of byPlan) {
      const aov = (g.sum / g.n).toFixed(2);
      expect(DOC, `the plan block no longer quotes ${plan}`).toContain(
        `${plan.padEnd(11)} ${aov} (${g.n} orders, ${g.cust.size} customers)`,
      );
    }
  });

  it("quotes the KPI row the dashboard would show", () => {
    const facts = revenueFacts();
    const total = facts.reduce((a, f) => a + f.net, 0);
    const customers = new Set(facts.map((f) => f.customer)).size;
    const aov = (total / facts.length).toFixed(2);
    // The customer count is the one people get wrong: it is distinct ids on a
    // FACT row, which includes the ten that reached no CRM file — ten more
    // than the customer CSVs hold.
    expect(customers).toBe(70);
    expect(DOC).toContain(
      `**$${(total / 1000).toFixed(1)}K · ${facts.length} · ${customers} · $${aov}**`,
    );
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

/**
 * Rebuild `analytics.revenue_facts` from the seeded CSVs, following the same
 * eleven steps the document's pipeline table lists. Deliberately independent
 * of the generator's own report: the point is to check the DOCUMENT against
 * the data, not the generator against itself.
 */
function revenueFacts(): { order: string; customer: string; plan: string; net: number }[] {
  const rd = (f: string) => {
    const [head, ...rows] = readFileSync(join(dir, f), "utf8").trim().split(/\r?\n/);
    const cols = head.split(",");
    return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
  };
  const rates = new Map(rd("fx_rates/fx_rates.csv").map((r) => [r.currency, Number(r.to_usd)]));
  const seen = new Set<string>();
  const perOrder = new Map<string, number>();
  for (const p of rd("payments/payments.csv")) {
    if (seen.has(p.payment_id)) continue; // dedupe on payment_id
    seen.add(p.payment_id);
    const id = /[0-9]+/.exec(p.order_ref)?.[0] ?? "";
    const amount = p.paid_amount === "" ? 0 : Number(p.paid_amount); // zero the nulls
    perOrder.set(id, (perOrder.get(id) ?? 0) + amount * (rates.get(p.currency) ?? 1));
  }
  const customers = new Map(
    [...rd("customers/customers.csv"), ...rd("customers/customers_batch2.csv")].map((c) => [
      c.customer_id,
      c,
    ]),
  );
  const facts = [];
  for (const o of rd("orders/orders.csv")) {
    if (o.status === "cancelled") continue;
    if (!perOrder.has(o.order_id)) continue;
    facts.push({
      order: o.order_id,
      customer: o.customer_id,
      // The LEFT join keeps the order and labels the gap.
      plan: customers.get(o.customer_id)?.plan ?? "(unknown)",
      net: perOrder.get(o.order_id) as number,
    });
  }
  return facts;
}
