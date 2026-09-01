# End to end: data and AI

A worked scenario that runs the whole platform against one problem — three
systems that disagree about revenue — and ends with a dashboard, a governed
metric and an agent that all answer with the same number.

Everything here was executed on a real deployment. Every figure in this
document came out of an actual run, not an illustration.

---

## The problem worth solving

Ask three teams for last quarter's revenue and you get three answers. Not
because anyone is careless — because the number has to survive a gauntlet of
small, quiet defects, and each one produces a **wrong answer that looks
completely reasonable**. Nothing errors. Nothing turns red. The dashboard just
says something untrue.

This walkthrough plants seven of those defects deliberately, then fixes each
one in a visible place.

| #   | Defect                                      | What it does to the number                                                       |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | The CRM has not synced its newest customers | An inner join silently **drops** their revenue                                   |
| 2   | Orders are in USD, EUR and GBP              | Summing mixed currencies produces a meaningless total                            |
| 3   | Cancelled orders are still in the table     | They belong in the table, not in revenue                                         |
| 4   | Payments reference `ORD-00042`, not `42`    | A join on the raw column matches nothing and returns a believable empty result   |
| 5   | Webhook retries repeated ~6% of payments    | Those rows are **counted twice**                                                 |
| 6   | Refunds arrive as negative rows             | Filter them out and revenue is overstated; ignore the sign and it is understated |
| 7   | A few payment amounts arrived empty         | A null poisons a sum                                                             |

### The gap this creates

Joining these three systems the obvious way:

```
naive total                     363,161.35
actual net revenue (USD)        408,332.36
```

The naive answer is **11.1% low** — and it is wrong in both directions at
once. Duplicates inflate it, cancelled orders inflate it, the currencies make
it meaningless, and dropped orphan customers pull it back down further than
all of that lifts it. Two large errors partially cancelling is exactly why
nobody notices.

Of the true total, **$55,604.70 (13.6%) belongs to customers the CRM has not
sent yet**. An inner join throws that away without a word.

Both figures come from `scripts/seed-revenue-walkthrough.mjs`, which computes
them in plain arithmetic over the rows it generates — independently of the
pipeline it is used to check.

---

## What you will build

```
MinIO (raw CSV)          ETL pipeline              Lakehouse           Semantic layer        Consumers
────────────────         ────────────              ─────────           ──────────────        ─────────
payments.csv   ─┐
fx_rates.csv   ─┤─────►  17 nodes, one per    ──►  analytics.      ──► "net_revenue"    ──►  BI dashboard
orders.csv     ─┤        defect + a quality        revenue_facts       defined ONCE          AI Analyst
customers.csv  ─┘        gate                      (836 rows)                                agents (metric_query)
                                                                                             row/column security
```

**All of it is reproducible, raw files included** — see Step 1.

---

## Step 1 — Land the raw data

Five CSVs go into object storage, exactly as three upstream systems would drop
them. Generate them with the seed script, which is deterministic — a fixed seed,
no clock, no `Math.random()` — so your files are byte-identical to the ones every
number below was measured from:

```bash
node scripts/seed-revenue-walkthrough.mjs seed/revenue
```

Then upload them to the bucket registered in **Data Catalog** as a storage
source (the walkthrough uses MinIO):

```bash
mc cp --recursive seed/revenue/ local/etl/raw/revenue/
```

```
s3://etl/raw/revenue/payments/payments.csv          1,007 rows  (66 retried ids, 41 refunds, 6 null amounts)
s3://etl/raw/revenue/orders/orders.csv                900 rows  (64 cancelled)
s3://etl/raw/revenue/customers/customers.csv           52 rows  (8 more arrive in customers_batch2.csv)
s3://etl/raw/revenue/customers/customers_batch2.csv     8 rows  (same glob — late-arriving dimension)
s3://etl/raw/revenue/fx_rates/fx_rates.csv              3 rows  (USD, EUR, GBP)
```

Ten of the 70 customer ids the orders reference appear in **no** customer file at
all. That is deliberate, and it is what Step 2's LEFT join exists to survive.

> **Bring your own data instead.** Any S3-compatible bucket works — add it under
> **Data Catalog → Add source**, then point the pipeline's source nodes at your
> paths. The shapes are ordinary: a fact table, a payments export, a customer
> dimension and a rate table.

---

## Step 2 — Conform it with a visual pipeline

**Data & BI → ETL Pipelines → New pipeline**, visual mode. The canvas ends up
reading as _the list of reasons the naive number was wrong_ — one node per
defect:

| Node                            | Type             | Fixes | Why                                                                                                                  |
| ------------------------------- | ---------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| Normalise order key             | SQL              | 4     | `regexp_extract(order_ref, '[0-9]+')` — pandas `eval` has no regex, so this is the one step that genuinely needs SQL |
| Drop retried payments           | Dedupe           | 5     | Deduplicate on `payment_id`                                                                                          |
| Zero the missing amounts        | Fill nulls       | 7     | `paid_amount → 0`                                                                                                    |
| Attach FX rate + Convert to USD | Join + Derive    | 2     | Join `fx_rates` on currency, then `paid_amount * to_usd`                                                             |
| Net per order                   | Aggregate        | 6     | `sum(net_usd)` per order — refunds are negative, so summing **nets** them automatically                              |
| Attach the order                | Join (inner)     | —     | Payments to their order                                                                                              |
| Exclude cancelled               | Filter           | 3     | `status != 'cancelled'`                                                                                              |
| Attach the customer             | Join (**left**)  | 1     | A LEFT join **keeps** orders whose customer has not synced                                                           |
| Label unknown regions           | Fill nulls       | 1     | `region → '(unknown)'` so the gap is visible instead of invisible                                                    |
| Type the dates                  | Python           | —     | CSV inference returns dates as text; typed once here, not in every query                                             |
| Quality gate                    | Quality gate     | —     | `not_null(order_id)` fail · `unique(order_id)` fail · `not_null(net_usd)` warn                                       |
| analytics.revenue_facts         | Lakehouse target | —     | Replace-load into the built-in warehouse                                                                             |

Two of these deserve emphasis, because they are the ones people get wrong:

**The LEFT join is the whole trick.** An inner join here is the natural thing
to write and it is wrong. It does not error; it quietly under-reports by 13.6%,
and it under-reports _more_ the faster you are winning new customers — because
new customers are exactly the ones the CRM has not synced yet. Your worst
reporting month is your best sales month.

**Refunds need no special handling — if you sum instead of filter.** The
refund rows are already negative. `sum()` nets them. A `WHERE kind='capture'`
filter, which looks tidier, overstates revenue by the entire refund volume.

### Run it

```
status     : succeeded
rows loaded: 836                       (900 orders − 64 cancelled)
quality    : not_null(order_id)  0 violations   [fail]
             unique(order_id)    0 violations   [fail]
             not_null(net_usd)   0 violations   [warn]
lineage    : raw/revenue/{payments,fx_rates,orders,customers}/*.csv → analytics.revenue_facts
```

And the number:

```
net revenue (USD)   408,332.36      ← matches ground truth exactly
```

That is not a figure copied out of the warehouse and pasted here. The seed
script computes it independently — plain arithmetic over the rows it just
wrote, no DuckDB, no pipeline — and prints it at the end of its run. The
pipeline agreeing to the cent is what makes the walkthrough a test rather than
an illustration.

| Region    | Net revenue | Orders |
| --------- | ----------- | ------ |
| APAC      | 123,376.12  | 242    |
| AMER      | 119,069.66  | 238    |
| EMEA      | 110,281.88  | 242    |
| (unknown) | 55,604.70   | 114    |

That `(unknown)` row is the point. It is not an error — it is 13.6% of your
revenue, visible and labelled, instead of missing and silent.

> **Tip — build it from the middle.** Click any node and press **Preview data**
> to run that node's ancestors on sampled rows and see the actual frame. One
> preview also fills the column pickers for the whole upstream chain, so the
> next node you configure offers real column names.

---

## Step 3 — Let the late data arrive

The CRM finally exports 8 of the customers it was missing. Drop the new file
beside the old one — the source path is a glob (`customers/*.csv`), so the next
run just picks it up — and re-run. To reproduce this, run the pipeline once with
`customers_batch2.csv` absent from the bucket, then again with it present.

|                 | Before the late batch | After          |
| --------------- | --------------------- | -------------- |
| **Net revenue** | **408,332.36**        | **408,332.36** |
| APAC            | 101,214.85            | 123,376.12     |
| AMER            | 106,257.60            | 119,069.66     |
| EMEA            | 95,547.96             | 110,281.88     |
| (unknown)       | 105,311.95            | 55,604.70      |

**The total did not move — to the cent.** The revenue was never lost, so nothing
had to be restated; it simply moved out of `(unknown)` and into the regions it
always belonged to.

Compare that with the inner-join version, where the total would have _jumped by
$49,707_ the day the CRM caught up, and somebody would have had to explain why
last month's number changed. That conversation is the real cost of the wrong
join, and it happens weeks after the mistake.

`(unknown)` does not fall to zero, and that is deliberate: ten customer ids in
the orders appear in no CRM export at all. Some data never arrives. The point of
the LEFT join is not that the gap closes — it is that the gap is **visible and
priced** while it is open, and that the total is right either way.

---

## Step 4 — Define the metric once

**Data & BI → Semantic Layer → New model**, pointed at the lakehouse
connection and `analytics.revenue_facts`.

Dimensions: `region`, `plan`, `customer_name`, `currency`, `placed_at` (time).
Metrics:

| Metric            | Definition                            | Notes                                                                            |
| ----------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `net_revenue`     | `sum(net_usd)`                        | Currency USD. Synonyms: revenue, net sales, turnover, sales                      |
| `orders`          | `count(*)`                            | Completed only — cancelled rows are not in the table                             |
| `customers`       | `count_distinct(customer_id)`         | Synonyms: accounts, logos                                                        |
| `avg_order_value` | `{net_revenue} / nullif({orders}, 0)` | A **derived** metric composes other metrics by name, not by re-writing their SQL |

Descriptions carry the warnings that would otherwise live in someone's head:

> `net_revenue` — "Captures minus refunds, in USD. THE revenue number. Do not
> sum `gross_amount` — it is in mixed currencies and includes orders that were
> cancelled."

That sentence is doing real work. `gross_amount` is right there in the table,
it is a plausible thing to sum, and summing it is wrong. The model says so
where the AI and the next analyst will both read it.

Asking in business words now compiles to SQL:

```
net revenue, all up
  SQL: SELECT SUM(net_usd) AS "net_revenue" FROM analytics.revenue_facts
  →    408,332.36

AOV by plan
  SQL: SELECT plan, (SUM(net_usd)) / nullif((COUNT(*)), 0) AS "avg_order_value", …
  →    starter 565.77 (179 orders, 15 customers)
       enterprise 541.72 (327 orders, 22 customers)
       growth 529.66 (330 orders, 23 customers)
```

Worth noticing: **starter has the highest average order value.** That is the
kind of finding that only shows up once the currencies are conformed — in the
raw data it was buried under the exchange rates.

---

## Step 5 — Build the dashboard

**Data & BI → BI Workspace → New dashboard**. Nine widgets, and every one of
them takes its SQL **from the semantic model** rather than hand-written SQL —
which is what stops the dashboard and the analyst drifting apart later.

| Widget                                                       | Type           |
| ------------------------------------------------------------ | -------------- |
| Net revenue (USD) · Orders · Customers · Average order value | 4 KPI tiles    |
| Net revenue by month                                         | Line           |
| Net revenue by region                                        | Pie            |
| Orders and AOV by plan                                       | Bar            |
| Top customers                                                | Horizontal bar |
| Where the money was booked (original currency)               | Table          |

The KPI row reads **$453.2K · 836 · 60 · $542.11** — the same numbers the
pipeline produced and the semantic layer computes.

---

## Step 6 — Give the AI the same definitions

Two tools, two different guarantees.

**`metric_query`** — the agent asks in business words and gets the governed
number without writing SQL it could get wrong. It picks from a catalog of
metric and dimension names (with synonyms, so "turnover" and "net sales" both
resolve), and the model allow-list is enforced when the tool _runs_, not just
in the prompt — an agent cannot reach a model it was never granted, however it
came to name one.

**`warehouse_query`** — the agent writes SQL against the lakehouse, through the
same governed chokepoint as everyone else:

```
SELECT region, round(sum(net_usd),2) FROM analytics.revenue_facts GROUP BY 1 ORDER BY 2 DESC
  APAC       123,376.12
  AMER       119,069.66
  EMEA       110,281.88
  (unknown)   55,604.70
```

Same numbers as the dashboard. And the boundary holds:

```
DROP TABLE analytics.revenue_facts
  → refused: Only read-only queries (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN) are allowed
```

---

## Step 7 — Let two people see two different, correct numbers

A regional manager should see their region. Not "should be shown a filtered
dashboard" — should be _unable_ to see anything else, whichever surface they
use.

Create a mapping table, then one policy on `analytics.revenue_facts`
(**Lakehouse → the table → Security**):

```sql
-- analytics.region_managers
manager_email                  region
emea.manager@example.com       EMEA
```

| Setting                 | Value                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| Rows they can see       | `region = (SELECT region FROM analytics.region_managers WHERE manager_email = @me)` |
| Columns they can't read | `customer_name`                                                                     |
| How to hide them        | Scramble                                                                            |

`@me` becomes the caller's email, so **one rule serves every manager** — the
engine looks up which region the asker owns.

The result, same table, same semantic model, same dashboard:

|                             | Owner            | EMEA manager                       |
| --------------------------- | ---------------- | ---------------------------------- |
| Net revenue                 | 408,332.36       | **110,281.88**                     |
| Orders                      | 836              | **242**                            |
| `customer_name`             | `Customer 006`   | `5d899a73b8ac43c2a2d0014f86e5e7c0` |
| Regions visible             | APAC, AMER, EMEA | EMEA only                          |
| `DELETE FROM revenue_facts` | allowed          | refused                            |

The manager's 110,281.88 is exactly the EMEA figure from the region
breakdown — they are not seeing a different _number_, they are seeing a
correct _subset_.

Two properties make this trustworthy rather than decorative:

- **It is enforced by rewriting the query's parse tree**, not by matching text.
  A CTE, an alias, a subquery, a self-join, odd casing or a UNION arm cannot
  slip past it, and an aggregate over a masked column returns nothing rather
  than leaking through.
- **A policed table is read-only for everyone but its owner.** A reader who
  sees part of a table must not be able to delete the parts hidden from them.

---

## Step 8 — Trace the number back

Because the pipeline recorded lineage, the dashboard figure is traceable to the
files it came from:

```
raw/revenue/payments/*.csv   ─┐
raw/revenue/fx_rates/*.csv   ─┼──►  analytics.revenue_facts
raw/revenue/orders/*.csv     ─┤
raw/revenue/customers/*.csv  ─┘
```

Every statement against the lakehouse — including the refused ones — is in the
audit trail, with the policy application recorded alongside:

```
lakehouse.select 204 · lakehouse.dml 54 · lakehouse.ddl 29 · lakehouse.policy 2
```

---

## What each hard problem cost

| Hard thing                         | How it was solved                                          | Where            |
| ---------------------------------- | ---------------------------------------------------------- | ---------------- |
| Three systems, three key formats   | One SQL node normalising the join key                      | ETL              |
| Double-counted webhook retries     | Dedupe node on the natural key                             | ETL              |
| Mixed currencies                   | Rate join + derive, before any aggregation                 | ETL              |
| Refunds                            | Sum instead of filter — the sign does the work             | ETL              |
| Late-arriving dimension            | LEFT join + a labelled `(unknown)` bucket                  | ETL              |
| "Revenue" meaning four things      | One metric definition with the warnings attached           | Semantic layer   |
| Dashboard and AI disagreeing       | Widgets compiled from the same model the agent queries     | BI + semantic    |
| Per-region access                  | One row-filter rule with `@me`, enforced in the parse tree | Lakehouse policy |
| "Where did this number come from?" | Lineage edges + append-only audit                          | Catalog          |

---

## Known gaps found while writing this

Recording these because a walkthrough that only shows the happy path is not
worth much.

- **A lakehouse ETL target records no catalog _assets_.** Lineage edges are now
  written (that was fixed while writing this), but the destination table is not
  crawled into the Data Catalog the way an object-storage or database target is
  — the lakehouse browses itself, so nothing populates `catalog_assets` for it.
  The table is fully queryable and governed; it just does not appear in catalog
  search.
- **`~/.local` in the ETL sandbox is a 512 MB tmpfs.** A pipeline that uses both
  the SQL transform (which pulls `ibis-framework[duckdb]`, ~447 MB installed)
  and a lakehouse node (which downloads DuckDB extensions into the same tmpfs)
  sits close enough to the ceiling to fail intermittently. If you hit it, prefer
  a Python transform over a SQL one, or raise the tmpfs size in the runtime
  configuration.
- **CSV inference returns dates as text.** Expected, but it means a "group by
  month" has nothing to group on until you cast. The walkthrough casts once, in
  a Python node, rather than in every downstream query.

---

## Reproducing this

1. **Data Catalog → Add source** — register an S3-compatible bucket.
2. Upload the four CSVs (or point at your own equivalents).
3. **ETL Pipelines → New pipeline** — build the graph from the table in Step 2.
   Use **Preview data** on each node as you go.
4. **Run**, and check the quality-gate results in the run's metrics.
5. **Semantic Layer → New model** — point it at `analytics.revenue_facts` and
   define the four metrics from Step 4.
6. **BI Workspace → New dashboard** — add widgets against the lakehouse
   connection.
7. **Lakehouse → revenue_facts → Security** — add the row filter and mask, then
   share the schema with a second user and compare what they see.

Related reading: **[ETL pipelines](./ETL_PIPELINES.md)**,
**[Lakehouse](./LAKEHOUSE.md)**, **[Semantic Layer](./SEMANTIC_LAYER.md)**,
**[Business Intelligence](./BUSINESS_INTELLIGENCE.md)**,
**[Data sources & connectors](./DATA_SOURCES.md)**.
