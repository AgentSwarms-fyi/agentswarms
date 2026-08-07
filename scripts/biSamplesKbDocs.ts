// Knowledge-base SQL for the two BI samples. Kept out of buildBiSamples.ts
// only for readability — the generator inlines this into the migration.
//
// Every number in these documents matches the generator: SLA days per mode,
// the OTIF target and per-carrier floor, CO₂ factors, comp bands, and the
// attrition formula are the ones the CSVs were synthesised against. That is
// the point of the sample — the ontology widget links these concepts to the
// datasets that measure them, and the numbers agree.

const doc = (s: string) => {
  if (s.includes("$kb$")) throw new Error("dollar-quote collision");
  return `$kb$${s}$kb$`;
};

const LOGISTICS_KB = "c0ffee77-0000-4000-8000-000000000001";
const PEOPLE_KB = "c0ffee88-0000-4000-8000-000000000001";

export const KB_DOCS = `INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  '${LOGISTICS_KB}',
  NULL,
  'Sample · Logistics Operations Handbook',
  'Operating policy for the supply-chain sample: carrier SLAs and the OTIF definition, the warehouse network and its lanes, and the freight-cost / CO₂ accounting method. The "Supply Chain Pulse · Sample" dashboard and its ontology are built against these definitions.',
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  'c0ffee77-0000-4000-8000-00000000d001',
  '${LOGISTICS_KB}',
  NULL,
  'Carrier SLA & OTIF Policy.md',
  ${doc(`# Carrier SLA & OTIF Policy

## Definitions
**OTIF (On-Time-In-Full)** is the share of shipments delivered within the SLA transit window *and* undamaged. A shipment is **on time** when its actual transit days are at or under the SLA for its mode, and **in full** when no damage is recorded at receiving. OTIF is the single number carriers are managed on.

## SLA transit windows by mode
| Mode | SLA (days) |
| ---- | ---------- |
| Air  | 4          |
| Road | 7          |
| Rail | 10         |
| Sea  | 28         |

## Targets
- **Network OTIF target: ≥ 95%** measured monthly across all lanes.
- **Per-carrier floor: 90%.** A carrier below the floor for two consecutive months enters a performance review; three months triggers lane reallocation.
- **Damage rate: < 2%** of shipments, any mode. Perishables are audited separately because their damage exposure is structurally higher.

## Contracted carriers
| Carrier | Positioning | Modes |
| ------- | ----------- | ----- |
| Meridian Freight | Low-cost bulk, slower, damage-prone under load | Sea, Road |
| BlueDart Express | Premium air express, near-perfect punctuality | Air, Road |
| TransGlobal | Balanced mid-market workhorse | Sea, Air, Rail |
| Arctic Line | Cheapest sea/rail; winter weather exposure on northern lanes | Sea, Rail |

## Known seasonal pattern
Arctic Line's northern sea lanes degrade in **December–February**; plan OTIF-critical freight onto BlueDart or TransGlobal in those months rather than paying expedite fees after the miss.`)},
  true,
  '{"source": "supply-chain-sample"}'::jsonb
), (
  'c0ffee77-0000-4000-8000-00000000d002',
  '${LOGISTICS_KB}',
  NULL,
  'Warehouse Network & Lanes.md',
  ${doc(`# Warehouse Network & Lanes

## Origin warehouses
The network ships from five distribution centres:

| Warehouse | Serves primarily |
| --------- | ---------------- |
| Rotterdam DC | EMEA road/sea lanes |
| Gdansk DC | EMEA + rail eastbound |
| Singapore Hub | APAC consolidation |
| Memphis DC | Americas air + road |
| Guadalajara DC | LATAM |

## Destination regions and lane distance
Freight and CO₂ are modelled on a representative lane distance per destination region:

| Region | Representative distance (km) |
| ------ | ---------------------------- |
| EMEA | 1,800 |
| LATAM | 2,400 |
| Americas | 3,600 |
| APAC | 5,200 |

A **lane** is an origin-warehouse → destination-region pairing. SLAs, CO₂ factors and carrier allocations are set per lane; the dashboard's lane-health heatmap is the monitoring view for this policy.

## Categories in scope
Electronics, Apparel, Industrial Parts, and Perishables. Perishables carry elevated damage risk and should not travel Sea unless refrigerated capacity is confirmed.`)},
  true,
  '{"source": "supply-chain-sample"}'::jsonb
), (
  'c0ffee77-0000-4000-8000-00000000d003',
  '${LOGISTICS_KB}',
  NULL,
  'Freight Cost & CO2 Methodology.md',
  ${doc(`# Freight Cost & CO₂ Methodology

## Freight cost
Freight is billed per kilogram and varies by mode (air ≫ road > rail > sea), by carrier positioning (BlueDart premium, Arctic/Meridian discount), and by a fuel-linked inflation drift of roughly **1.2% per month** across the reporting window. Cost per shipment = chargeable weight × mode rate × carrier factor × fuel index.

## CO₂ accounting
Emissions use standard per-mode intensity factors, applied to chargeable weight over the representative lane distance:

| Mode | kg CO₂ per kg·km |
| ---- | ----------------- |
| Air  | 0.00060 |
| Road | 0.00009 |
| Rail | 0.00003 |
| Sea  | 0.000012 |

So: **CO₂(kg) = weight(kg) × lane distance(km) × factor**. Air is ~50× sea per tonne-km — mode shift, not carrier choice, is the only lever that moves the CO₂-per-unit KPI materially.

## Reporting rules
- Costs are reported in USD, unrounded at line level, rounded at aggregate level.
- CO₂-per-unit (total CO₂ ÷ units shipped) is the board-level intensity KPI.
- Carrier scorecards aggregate month × carrier and are refreshed by the "Carrier scorecard · Sample" data-prep flow; OTIF on the scorecard must reconcile with the shipment-level OTIF trend.`)},
  true,
  '{"source": "supply-chain-sample"}'::jsonb
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  '${PEOPLE_KB}',
  NULL,
  'Sample · People Operations Playbook',
  'Operating definitions for the people-analytics sample: how attrition is measured and its guardrails, the job architecture and comp bands, and the engagement survey method. The "People Analytics · Sample" dashboard and its ontology are built against these definitions.',
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  'c0ffee88-0000-4000-8000-00000000d001',
  '${PEOPLE_KB}',
  NULL,
  'Attrition Definitions & Targets.md',
  ${doc(`# Attrition Definitions & Targets

## The formula
**Monthly attrition % = exits during the month ÷ headcount at month end × 100.**
Headcount counts everyone whose hire date is on or before month end and whose exit date (if any) is after month end. This is the definition the "Attrition by month · Sample" prep flow and the hr_dept_monthly rollup implement — any other cut must reconcile to it.

## Exit classification
- **Voluntary** — employee-initiated resignation. The regretted/non-regretted split is recorded in exit interviews (out of scope for this dataset).
- **Involuntary** — employer-initiated. Excluded from "quit-rate" style analyses but included in headline attrition.

## Guardrails
- Company guardrail: **≤ 1.5% per month** (~17% annualised).
- A department above **2.5% in a single month** triggers a retention review with its leadership.
- **Customer-facing teams (Support, Sales) carry structurally higher churn** — benchmark them against their own trailing average, not the company mean.

## Tenure
Tenure is measured in months from hire date to exit date (or to the reporting window end for active staff). Average tenure *at exit* under 12 months signals onboarding or role-fit failure rather than ordinary churn.`)},
  true,
  '{"source": "people-analytics-sample"}'::jsonb
), (
  'c0ffee88-0000-4000-8000-00000000d002',
  '${PEOPLE_KB}',
  NULL,
  'Job Architecture & Comp Bands.md',
  ${doc(`# Job Architecture & Comp Bands

## Levels
Seven levels: **IC1–IC5** on the individual-contributor track and **M1–M2** on the management track. M1 is the peer of IC4 in scope; M2 of IC5. Progression IC3 → M1 is a track change, not a promotion.

## Salary bands (USD, annual base)
| Level | Band |
| ----- | ---- |
| IC1 | 52,000 – 70,000 |
| IC2 | 68,000 – 92,000 |
| IC3 | 88,000 – 124,000 |
| IC4 | 118,000 – 165,000 |
| IC5 | 150,000 – 210,000 |
| M1 | 130,000 – 175,000 |
| M2 | 165,000 – 230,000 |

**Offers land in-band by policy.** Out-of-band offers need CFO sign-off and are not represented in the sample roster. Bands are location-agnostic across the five sites (Austin, Dublin, Bengaluru, Singapore, Remote) — the company pays a single global band per level.

## Performance
Annual rating on a **1–5** scale, calibrated per department; 3 is "meets expectations". Pay-vs-performance is reviewed at the level grain (the dashboard's scatter): levels drifting high-pay/low-performance indicate calibration or band drift.`)},
  true,
  '{"source": "people-analytics-sample"}'::jsonb
), (
  'c0ffee88-0000-4000-8000-00000000d003',
  '${PEOPLE_KB}',
  NULL,
  'Engagement Survey Methodology.md',
  ${doc(`# Engagement Survey Methodology

## Instrument
A quarterly pulse survey scored **1–10**, averaged per person across items (belonging, growth, manager support, workload). The roster stores each person's latest score.

## Reading the number
- **≥ 8.0** — healthy; sustain.
- **6.0 – 7.9** — watch; discuss in the department's ops review.
- **< 6.0** — a department or department × level cell mean under 6.0 triggers a **listening session** with that population within the quarter.

## Known correlations
Engagement co-moves with performance rating (higher performers report higher engagement) and drops sharply in the months before a voluntary exit — exited employees' final pulse scores average markedly lower than active staff. Treat a falling cell in the department × level matrix as a leading indicator of attrition, and read it alongside the attrition guardrails in this playbook.

## Hygiene
Scores are anonymised below a 5-person cell size; the sample dataset is synthetic, so no such suppression is applied.`)},
  true,
  '{"source": "people-analytics-sample"}'::jsonb
) ON CONFLICT (id) DO NOTHING;`;
