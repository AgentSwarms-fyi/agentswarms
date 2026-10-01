/**
 * A cost in US dollars, as every page shows one.
 *
 * FOUND IN R202: each page wrote its own, most with `toFixed(4)`, one with
 * `toFixed(6)` and two with their own zero. A Gemini 2.5 Flash call of 7
 * tokens in and 1 out costs $0.0000046, and Prompt Compare showed it as
 * "~$0.0000", beside a note that a model without a known price shows ~$0.
 * Traces listed it as $0.0000, the same as a free model's calls. A cost
 * under a cent now keeps two significant digits, so a priced call never
 * reads as free.
 *
 * - No figure: "—".
 * - Zero: "$0.00".
 * - From $1: two decimals, grouped ("$1,234.57").
 * - From a cent: four decimals ("$0.0123").
 * - Under a cent: two significant digits ("$0.0000046"), down to
 *   "<$0.00000001".
 */
export function formatUsd(
  n: number | string | null | undefined,
  opts?: { approx?: boolean },
): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const pre = opts?.approx ? "~" : "";
  if (v === 0) return `${pre}$0.00`;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1) {
    const s = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${pre}${sign}$${s}`;
  }
  if (abs >= 0.01) return `${pre}${sign}$${abs.toFixed(4)}`;
  if (abs < 1e-8) return `${pre}${sign}<$0.00000001`;
  // Two significant digits: 4.6e-6 has its first digit at the 6th place.
  // A stored $0.000005 reads as that, not as "$0.0000050".
  const places = Math.max(4, 1 - Math.floor(Math.log10(abs)));
  return `${pre}${sign}$${abs.toFixed(places).replace(/0+$/, "")}`;
}
