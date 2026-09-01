#!/usr/bin/env node
// Generate the raw CSVs for the end-to-end walkthrough in
// docs/END_TO_END_DATA_AND_AI.md.
//
// WHY THIS EXISTS. The walkthrough said "everything after the raw files is
// reproducible from this document" — which conceded that the raw files were
// not. Anyone following it had to invent their own data, and the defect counts
// and the ground-truth total in the document could not be checked against
// anything. When the object store backing the original files was lost, the
// walkthrough became unreproducible in practice as well as in principle.
//
// Every number here is DERIVED FROM THE PIPELINE, not decorative. The
// revenue_conform graph does, in order: extract an integer order id from a
// text reference, drop duplicate payment ids, zero-fill null amounts, inner
// join FX, convert to USD, aggregate per order, inner join orders, drop
// cancelled, LEFT join customers, fill unknown regions. Each defect below
// exists to make one of those steps matter — and to make the naive alternative
// visibly wrong:
//
//   duplicate payment ids  -> without the dedupe, revenue is double-counted
//   refunds as negatives   -> sum() nets them; a WHERE kind='capture' overstates
//   null amounts           -> without the fill, the FX join drops those rows
//   cancelled orders       -> counted as revenue if you forget the filter
//   customers not in CRM   -> an INNER join here silently under-reports
//   late-arriving customers-> a second file under the same glob
//   three currencies       -> summing raw amounts mixes units
//
// Deterministic: a fixed seed and a small LCG, so two runs anywhere produce
// byte-identical files and the totals in the document stay true.
//
//   node scripts/seed-revenue-walkthrough.mjs [outDir]
//
// Then upload to the bucket the pipeline reads (default layout):
//
//   mc cp --recursive <outDir>/ local/etl/raw/revenue/
//
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? "seed/revenue";

// ── Deterministic randomness ────────────────────────────────────────────────
// A 32-bit LCG (glibc's constants). Math.random() would make the committed
// ground-truth total a lie on the second run.
let _s = 20260831;
const rnd = () => (_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// ── Shape ───────────────────────────────────────────────────────────────────
const ORDERS = 900;
const CANCELLED = 64;
const REFUNDS = 41;
const DUPLICATE_PAYMENTS = 66;
const NULL_AMOUNTS = 6;
const CUSTOMERS_FIRST = 52; // customers.csv
const CUSTOMERS_LATE = 8; // customers_batch2.csv, same glob
const CUSTOMERS_REFERENCED = 70; // 10 orders' customers are in no CRM file at all

const CURRENCIES = [
  { code: "USD", to_usd: 1.0 },
  { code: "EUR", to_usd: 1.08 },
  { code: "GBP", to_usd: 1.27 },
];
const REGIONS = ["EMEA", "AMER", "APAC"];
const PLANS = ["free", "pro", "enterprise"];

const csv = (header, rows) =>
  [header.join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n") + "\n";
const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const day = (n) => {
  // 2026-01-01 + n days, without Date arithmetic surprises across time zones.
  const d = new Date(Date.UTC(2026, 0, 1 + n));
  return d.toISOString().slice(0, 10);
};

// ── orders ──────────────────────────────────────────────────────────────────
// Cancelled orders are spread through the file rather than clustered, so a
// naive "eyeball the first rows" check does not reveal them.
const cancelled = new Set();
while (cancelled.size < CANCELLED) cancelled.add(1000 + int(0, ORDERS - 1));

const orders = [];
for (let i = 0; i < ORDERS; i++) {
  const id = 1000 + i;
  orders.push([
    id,
    cancelled.has(id) ? "cancelled" : "paid",
    1 + (i % CUSTOMERS_REFERENCED),
    day(int(0, 89)),
  ]);
}

// ── payments ────────────────────────────────────────────────────────────────
// One capture per order (so every live order survives the inner join), plus
// refunds, plus retried rows that share a payment_id.
const payments = [];
let pid = 500000;
const captureOf = new Map();
for (const [orderId] of orders) {
  const cur = pick(CURRENCIES);
  const amount = int(2000, 90000) / 100;
  const row = [`PAY-${pid++}`, `ORD-${orderId}`, amount.toFixed(2), cur.code, "capture"];
  captureOf.set(orderId, row);
  payments.push(row);
}

// Refunds: negative amounts on real orders, same currency as their capture.
// They need no special handling downstream *if* you sum instead of filter.
const refundOrders = [];
while (refundOrders.length < REFUNDS) {
  const o = 1000 + int(0, ORDERS - 1);
  if (!refundOrders.includes(o)) refundOrders.push(o);
}
for (const orderId of refundOrders) {
  const cap = captureOf.get(orderId);
  const part = -(Number(cap[2]) * (int(20, 100) / 100));
  payments.push([`PAY-${pid++}`, `ORD-${orderId}`, part.toFixed(2), cap[3], "refund"]);
}

// Six captures lose their amount somewhere upstream. Empty, not "0" — the
// point is that the fill_nulls step is what stops the FX join dropping them.
const nulled = [];
while (nulled.length < NULL_AMOUNTS) {
  const i = int(0, ORDERS - 1);
  if (!nulled.includes(i)) nulled.push(i);
}
for (const i of nulled) payments[i][2] = "";

// Retries: exact duplicates of existing rows, payment_id included. This is what
// makes the deduplicate step the difference between right and double.
for (let i = 0; i < DUPLICATE_PAYMENTS; i++) {
  payments.push([...payments[int(0, ORDERS - 1)]]);
}

// ── customers ───────────────────────────────────────────────────────────────
const customerRow = (id) => [
  id,
  `Customer ${String(id).padStart(3, "0")}`,
  REGIONS[id % REGIONS.length],
  PLANS[id % PLANS.length],
  day(int(-400, -30)),
];
const customersEarly = [];
for (let id = 1; id <= CUSTOMERS_FIRST; id++) customersEarly.push(customerRow(id));
const customersLate = [];
for (let id = CUSTOMERS_FIRST + 1; id <= CUSTOMERS_FIRST + CUSTOMERS_LATE; id++) {
  customersLate.push(customerRow(id));
}
// Ids CUSTOMERS_FIRST+CUSTOMERS_LATE+1 .. CUSTOMERS_REFERENCED appear on orders
// and in NO customer file. That is the LEFT join's whole reason for being.

// ── write ───────────────────────────────────────────────────────────────────
const files = {
  "payments/payments.csv": csv(
    ["payment_id", "order_ref", "paid_amount", "currency", "kind"],
    payments,
  ),
  "fx_rates/fx_rates.csv": csv(
    ["currency", "to_usd"],
    CURRENCIES.map((c) => [c.code, c.to_usd]),
  ),
  "orders/orders.csv": csv(["order_id", "status", "customer_id", "placed_at"], orders),
  "customers/customers.csv": csv(
    ["customer_id", "customer_name", "region", "plan", "signed_up_on"],
    customersEarly,
  ),
  "customers/customers_batch2.csv": csv(
    ["customer_id", "customer_name", "region", "plan", "signed_up_on"],
    customersLate,
  ),
};
for (const [rel, body] of Object.entries(files)) {
  const p = path.join(OUT, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
  console.log(`${p}  ${body.split("\n").length - 2} rows`);
}

// ── the answer the pipeline should produce ──────────────────────────────────
// Computed here the boring way, so the walkthrough has a ground truth that was
// derived independently of the thing it is checking.
const fx = Object.fromEntries(CURRENCIES.map((c) => [c.code, c.to_usd]));
const seen = new Set();
const perOrder = new Map();
for (const [payId, ref, amt, cur] of payments) {
  if (seen.has(payId)) continue; // dedupe
  seen.add(payId);
  const orderId = Number(ref.replace(/\D/g, ""));
  const usd = (amt === "" ? 0 : Number(amt)) * fx[cur]; // fill_nulls, then FX
  perOrder.set(orderId, (perOrder.get(orderId) ?? 0) + usd);
}
let rows = 0;
let net = 0;
for (const [orderId, status] of orders) {
  if (status === "cancelled") continue;
  if (!perOrder.has(orderId)) continue;
  rows++;
  net += perOrder.get(orderId);
}
const missingCustomer = orders.filter(
  ([, status, cid]) => status !== "cancelled" && cid > CUSTOMERS_FIRST + CUSTOMERS_LATE,
).length;

// Revenue attributable to customers no CRM file mentions — the slice an INNER
// join silently discards.
const known = new Set([...customersEarly, ...customersLate].map((c) => c[0]));
let orphanRevenue = 0;
for (const [orderId, status, customerId] of orders) {
  if (status === "cancelled" || !perOrder.has(orderId)) continue;
  if (!known.has(customerId)) orphanRevenue += perOrder.get(orderId);
}

// The wrong answer, computed the way it is usually arrived at: every payment
// row summed (no dedupe), raw amounts (no FX, so three currencies are added as
// if they were one), cancelled orders included, and customers INNER joined so
// the unsynced ones vanish. Two large errors in opposite directions, which is
// why nobody notices either.
let naive = 0;
const orderById = new Map(orders.map((o) => [o[0], o]));
for (const [, ref, amt] of payments) {
  const o = orderById.get(Number(ref.replace(/\D/g, "")));
  if (!o || !known.has(o[2])) continue;
  naive += amt === "" ? 0 : Number(amt);
}

console.log("\nground truth (what revenue_conform should load):");
console.log(`  rows loaded      : ${rows}`);
console.log(`  net revenue (USD): ${net.toFixed(2)}`);
console.log(`  unique payments  : ${seen.size} of ${payments.length} rows`);
console.log(
  `  LEFT join saves  : ${missingCustomer} rows (${((missingCustomer / rows) * 100).toFixed(1)}%` +
    ` would vanish on an INNER join), worth ${orphanRevenue.toFixed(2)} USD` +
    ` (${((orphanRevenue / net) * 100).toFixed(1)}% of the total)`,
);
console.log("\nthe wrong answer, for comparison:");
console.log(`  naive total      : ${naive.toFixed(2)}`);
console.log(`  error            : ${(((naive - net) / net) * 100).toFixed(1)}%`);
