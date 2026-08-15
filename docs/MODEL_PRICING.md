# Model pricing — where a cost figure comes from

Every model call is recorded in `execution_traces` with a `cost_usd`. That
column feeds the spend reports, the chargeback breakdown, and the monthly
budget cap, which refuses requests once it is reached. So the question "where
did this number come from" has a real answer, and this document is it.

**The governing rule: an unknown price is never recorded as zero without
saying so.** Zero and "nobody knew the rate" are indistinguishable once summed,
and a budget that sums them treats real spend as free — the cap then never
fires. Wherever the two can be confused, the code keeps them apart.

---

## 1. Resolution order

Highest priority first. The first layer that answers wins.

| #   | Layer                 | Where                                     | What it means                                          |
| --- | --------------------- | ----------------------------------------- | ------------------------------------------------------ |
| 1   | **Provider-reported** | `src/utils/observability/providerCost.ts` | The provider told us what **this call** cost.          |
| 2   | Operator override     | `priceResolver.ts`                        | A rate an admin set by hand.                           |
| 3   | Synced catalog        | `priceTable.generated.ts`                 | Vendored public price data.                            |
| 4   | Bundled table         | `pricing.ts`                              | Defaults shipped with the app.                         |
| 5   | Self-hosted           | `priceResolver.ts`                        | Ollama / vLLM on your own hardware — a **known** zero. |
| —   | Nothing               | → `null`                                  | Recorded at 0 **and flagged** `pricing_missing`.       |

### Why provider-reported outranks an operator override

Layers 2–4 all answer _"what is the rate for this model"_ — they are estimates
of a price list. Layer 1 answers a different and strictly better question:
_"what was this call charged"_, computed by the party doing the billing. An
override exists because the public sheet may not match your negotiated rate; a
reported cost **is** your negotiated rate, already applied.

### Which providers report cost

OpenRouter, when the request carries `usage: { include: true }` — the adapter
adds it automatically. The flag is **not** sent anywhere else: it is an
OpenRouter extension and OpenAI returns 400 on unrecognised body arguments, so
sending it blind would break working providers to ask a question they do not
understand. Adding a provider means extending `reportsPerCallCost()`.

A reported figure is refused, falling back to the table, if it is negative
(a credit is not this call's cost), non-finite (one NaN makes every downstream
SUM unreadable, including the budget's), or above `MAX_REPORTED_COST_USD`
(a units error, far likelier than a real charge that size).

**A reported `0` is a measurement, not a gap.** `openrouter/free` genuinely
charges nothing; it is recorded as a real zero rather than flagged as unpriced.

---

## 2. Refreshing the catalog

```bash
npm run prices:refresh          # fetch, validate, write, print a summary
npm run prices:refresh -- --dry # validate and report, write nothing
```

Two sources are merged into `src/utils/observability/priceTable.generated.ts`:

- **LiteLLM's community dataset** — broad coverage across first-party providers.
- **OpenRouter's own `/api/v1/models`** — every model it fronts, unauthenticated.

Where both describe an `openrouter:*` key, **OpenRouter's own rate wins
outright**. This is the one place that does not take the higher of two figures,
and the reason is correctness rather than caution: a model served through a
gateway is billed at the gateway's rate, so the community row is not a
competing estimate of the same quantity. Every replacement is printed.

**Prices are vendored in git, not fetched at runtime.** A rate change arrives
as a reviewable diff rather than appearing in a bill; `git blame` gives price
history, which is what an auditor asks for; no third party can move your
budgets by changing their data or going down; and an air-gapped deployment is
unaffected. Review the diff before committing — it moves budgets.

The script refuses to write rather than write something it cannot justify:
below a row floor, on a sudden shrink, on a non-200 or unparseable response, or
for any rate outside the sanity band. If OpenRouter is unreachable the refresh
still writes the community table, and says loudly what it missed.

### The failure this is designed around

`moonshotai/kimi-k3` ran 116 times on a live instance — 75,767 input and 56,350
output tokens — and recorded **$0.00** every time. Nothing was broken: the
catalog had been built from LiteLLM eleven days earlier, before the model
existed. OpenRouter was publishing the rate the whole time
($0.003/1K in, $0.015/1K out) and reporting the exact charge on every call.
About **$1.07** of spend that no budget cap could see.

That is why there are now two defences: ask the provider (right for a model
released this morning), and sync from the gateway's own catalog (right before a
model's first call).

---

## 3. When nothing knows the price

The call is recorded with real tokens, `cost_usd = 0`, and
`request_payload.pricing_missing = true`.

- **Rows** render as `unpriced` rather than `$0.0000` (Traces & Logs).
- **Totals** carry a `+?` suffix and explain themselves — see
  `src/lib/spendCompleteness.ts`. A total built from incomplete inputs says so
  where it is displayed, not only on the rows underneath it.
- **The maintenance sweep re-prices them.** `reprice.server.ts` runs on the
  cron pass, finds rows by that flag, and re-runs the _same_ resolver every
  live call uses. Once a refresh adds the model, history is corrected and the
  flag is replaced with the price source and a `repriced_at` stamp. Rows that
  still resolve to nothing keep the flag and are retried later — that retry is
  the point, not a leak.

So the fix for a page full of `unpriced` is `npm run prices:refresh`, and the
next cron pass corrects the history.

---

## 4. Attribution

`execution_traces.user_id` is nullable by design. A headless run — a deployed
API key, a schedule, an evaluation, a public embed — has no user to attribute
to, and the trace is still written so the spend is counted. Team spend shows
those rows as **unattributed**: real, counted, with no account to hang them on.
That is distinct from a row whose account was deleted, which shows its id.
