// Generator for the "Supply Chain Pulse" and "People Analytics" samples.
//
//   npx tsx scripts/buildBiSamples.ts
//
// Produces, deterministically (seeded PRNG, fixed dates — same bytes every
// run):
//   src/assets/sample-data/supply_shipments.csv        (360 rows)
//   src/assets/sample-data/supply_carrier_scorecard.csv (72 rows — the prep
//     flow's output, shipped precomputed so the dashboard renders instantly)
//   src/assets/sample-data/hr_roster.csv               (420 rows)
//   src/assets/sample-data/hr_dept_monthly.csv         (108 rows — ditto)
//   supabase/migrations/20260807000000_bi_samples_supply_people.sql
//
// Every widget snapshot in the migration is computed by RUNNING the widget's
// SQL in DuckDB against these CSVs — the same engine the app refreshes with —
// so a ↻ in the UI reproduces exactly what ships.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Deterministic PRNG ───────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260807);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2; // ~N(0, 0.5)

const MONTHS = [
  "2025-01",
  "2025-02",
  "2025-03",
  "2025-04",
  "2025-05",
  "2025-06",
  "2025-07",
  "2025-08",
  "2025-09",
  "2025-10",
  "2025-11",
  "2025-12",
  "2026-01",
  "2026-02",
  "2026-03",
  "2026-04",
  "2026-05",
  "2026-06",
] as const;
const daysIn = (ym: string) =>
  new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
const r1 = (n: number) => Math.round(n * 10) / 10;
const r0 = (n: number) => Math.round(n);

// ── CSV writer ───────────────────────────────────────────────────────────────
function toCsv(rows: Record<string, unknown>[]): string {
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n"
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Supply-chain shipments
// ═════════════════════════════════════════════════════════════════════════════
type Carrier = {
  name: string;
  baseCost: number;
  speed: number;
  onTime: number;
  damage: number;
  modes: string[];
};
const CARRIERS: Carrier[] = [
  {
    name: "Meridian Freight",
    baseCost: 0.8,
    speed: 1.25,
    onTime: 0.86,
    damage: 0.05,
    modes: ["Sea", "Road"],
  },
  {
    name: "BlueDart Express",
    baseCost: 1.7,
    speed: 0.55,
    onTime: 0.97,
    damage: 0.012,
    modes: ["Air", "Road"],
  },
  {
    name: "TransGlobal",
    baseCost: 1.0,
    speed: 1.0,
    onTime: 0.92,
    damage: 0.025,
    modes: ["Sea", "Air", "Rail"],
  },
  {
    name: "Arctic Line",
    baseCost: 0.7,
    speed: 1.45,
    onTime: 0.88,
    damage: 0.03,
    modes: ["Sea", "Rail"],
  },
];
const WAREHOUSES = [
  "Rotterdam DC",
  "Singapore Hub",
  "Memphis DC",
  "Guadalajara DC",
  "Gdansk DC",
] as const;
const REGIONS: Record<string, string[]> = {
  EMEA: ["Germany", "United Kingdom", "France", "United Arab Emirates"],
  APAC: ["Japan", "Australia", "India"],
  Americas: ["United States", "Brazil", "Canada"],
  LATAM: ["Mexico", "Chile"],
};
const CATEGORIES = ["Electronics", "Apparel", "Industrial Parts", "Perishables"] as const;
const MODE_SLA: Record<string, number> = { Air: 4, Road: 7, Rail: 10, Sea: 28 };
const MODE_CO2_PER_KG_KM: Record<string, number> = { Air: 0.6, Road: 0.09, Rail: 0.03, Sea: 0.012 };
const LANE_KM: Record<string, number> = { EMEA: 1800, APAC: 5200, Americas: 3600, LATAM: 2400 };

type Shipment = Record<string, string | number>;
const shipments: Shipment[] = [];
{
  let seq = 1;
  for (const month of MONTHS) {
    const mi = MONTHS.indexOf(month);
    for (let i = 0; i < 20; i++) {
      const carrier = CARRIERS[Math.floor(rnd() * 4)];
      const mode = pick(carrier.modes);
      const origin = pick(WAREHOUSES);
      const region = pick(Object.keys(REGIONS));
      const country = pick(REGIONS[region]);
      const category = pick(CATEGORIES);
      const units = 20 + Math.floor(rnd() * 480);
      const weight = r0(units * (2 + rnd() * 6));
      const orderValue = r0(units * (30 + rnd() * 170));
      // Freight: mode base × carrier positioning × mild fuel inflation over time.
      const modeRate: Record<string, number> = { Air: 1.9, Road: 0.55, Rail: 0.4, Sea: 0.22 };
      const freight = r0(
        weight * modeRate[mode] * carrier.baseCost * (1 + mi * 0.012) * (0.85 + rnd() * 0.3),
      );
      const sla = MODE_SLA[mode];
      // Winter slows Arctic Line sea lanes; everyone drifts slightly better over time.
      const winter = ["2025-01", "2025-02", "2025-12", "2026-01", "2026-02"].includes(month);
      const carrierOnTime = Math.min(
        0.995,
        carrier.onTime + mi * 0.003 - (winter && carrier.name === "Arctic Line" ? 0.14 : 0),
      );
      const onTime = rnd() < carrierOnTime;
      const transit = Math.max(
        1,
        r0(sla * carrier.speed * (onTime ? 0.75 + rnd() * 0.22 : 1.05 + rnd() * 0.5)),
      );
      const damaged = rnd() < carrier.damage * (category === "Perishables" ? 1.8 : 1);
      const co2 = r0(weight * LANE_KM[region] * MODE_CO2_PER_KG_KM[mode] * 0.001);
      const day = 1 + Math.floor(rnd() * daysIn(month));
      const orderDate = `${month}-${String(day).padStart(2, "0")}`;
      shipments.push({
        "Shipment ID": `SHP-${String(seq++).padStart(4, "0")}`,
        Month: month,
        "Order Date": orderDate,
        Carrier: carrier.name,
        Mode: mode,
        "Origin Warehouse": origin,
        "Dest Region": region,
        "Dest Country": country,
        Category: category,
        Units: units,
        "Order Value": orderValue,
        "Freight Cost": freight,
        "Weight Kg": weight,
        "SLA Days": sla,
        "Transit Days": transit,
        "On Time": onTime ? "Yes" : "No",
        "On Time Num": onTime ? 100 : 0,
        Damaged: damaged ? "Yes" : "No",
        "Damaged Num": damaged ? 100 : 0,
        "CO2 Kg": co2,
      });
    }
  }
}

// The prep flow's output, precomputed: month × carrier scorecard.
const scorecard: Record<string, string | number>[] = [];
for (const month of MONTHS) {
  for (const c of CARRIERS) {
    const rows = shipments.filter((s) => s.Month === month && s.Carrier === c.name);
    if (rows.length === 0) continue;
    const avg = (k: string) => rows.reduce((a, r) => a + Number(r[k]), 0) / rows.length;
    const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k]), 0);
    scorecard.push({
      Month: month,
      Carrier: c.name,
      Shipments: rows.length,
      "On Time Pct": r1(avg("On Time Num")),
      "Avg Transit Days": r1(avg("Transit Days")),
      "Freight Cost": r0(sum("Freight Cost")),
      "Damage Pct": r1(avg("Damaged Num")),
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. HR roster
// ═════════════════════════════════════════════════════════════════════════════
const DEPARTMENTS = ["Engineering", "Sales", "Marketing", "Support", "Finance", "People"] as const;
const DEPT_WEIGHT = [0.34, 0.2, 0.12, 0.16, 0.1, 0.08];
const DEPT_ATTRITION = [0.14, 0.22, 0.18, 0.26, 0.1, 0.12]; // annualised
const LEVELS = ["IC1", "IC2", "IC3", "IC4", "IC5", "M1", "M2"] as const;
const LOCATIONS = ["Austin", "Dublin", "Bengaluru", "Singapore", "Remote"] as const;
const AGE_BANDS = ["20-29", "30-39", "40-49", "50+"] as const;
const GENDERS = ["Female", "Male", "Non-binary"] as const;
const SALARY_BAND: Record<string, [number, number]> = {
  IC1: [52, 70],
  IC2: [68, 92],
  IC3: [88, 124],
  IC4: [118, 165],
  IC5: [150, 210],
  M1: [130, 175],
  M2: [165, 230],
};
const WINDOW_START = "2025-01-01";
const WINDOW_END = "2026-06-30";

type Person = Record<string, string | number>;
const roster: Person[] = [];
{
  const weightedDept = () => {
    const x = rnd();
    let acc = 0;
    for (let i = 0; i < DEPARTMENTS.length; i++) {
      acc += DEPT_WEIGHT[i];
      if (x < acc) return i;
    }
    return 0;
  };
  for (let i = 1; i <= 420; i++) {
    const di = weightedDept();
    const dept = DEPARTMENTS[di];
    const lvl = pick(LEVELS);
    // Hire dates: 2019-2026, weighted recent (growth).
    const hireYear = 2019 + Math.floor(Math.pow(rnd(), 0.6) * 7.4);
    const hireMonth = 1 + Math.floor(rnd() * 12);
    const hire = `${hireYear}-${String(hireMonth).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;
    // Exit: annualised dept hazard over the 18-month window, only if hired before window end.
    let exit = "";
    let exitType = "";
    if (hire < WINDOW_END && rnd() < DEPT_ATTRITION[di] * 1.5 * 0.75) {
      const em = pick(MONTHS);
      const ed = `${em}-${String(1 + Math.floor(rnd() * daysIn(em))).padStart(2, "0")}`;
      if (ed > hire) {
        exit = ed;
        exitType = rnd() < 0.72 ? "Voluntary" : "Involuntary";
      }
    }
    const active = exit === "";
    const [lo, hi] = SALARY_BAND[lvl];
    const salary = r0((lo + rnd() * (hi - lo)) * 1000);
    const perf = Math.min(5, Math.max(1, r0(3 + gauss() * 1.6)));
    // Engagement correlates with performance and drops for those who left.
    const engagement = Math.min(
      10,
      Math.max(1, r1(6.6 + perf * 0.35 + gauss() * 1.4 - (active ? 0 : 1.6))),
    );
    const end = exit || WINDOW_END;
    const tenureMonths = Math.max(
      0,
      r0((new Date(end).getTime() - new Date(hire).getTime()) / (30.44 * 86400e3)),
    );
    roster.push({
      "Employee ID": `E-${String(i).padStart(4, "0")}`,
      Department: dept,
      Level: lvl,
      Location: pick(LOCATIONS),
      "Hire Date": hire,
      "Hire Month": hire.slice(0, 7),
      "Exit Date": exit,
      "Exit Month": exit ? exit.slice(0, 7) : "",
      "Exit Type": exitType,
      Status: active ? "Active" : "Exited",
      "Exited Num": active ? 0 : 1,
      "Tenure Months": tenureMonths,
      Gender: pick(GENDERS),
      "Age Band": pick(AGE_BANDS),
      "Salary USD": salary,
      Performance: perf,
      Engagement: engagement,
      "Work Mode": pick(["Onsite", "Hybrid", "Remote"] as const),
    });
  }
}

// Prep-style output: month × department headcount/hires/exits/attrition.
const deptMonthly: Record<string, string | number>[] = [];
for (const month of MONTHS) {
  const monthEnd = `${month}-${String(daysIn(month)).padStart(2, "0")}`;
  for (const dept of DEPARTMENTS) {
    const inDept = roster.filter((p) => p.Department === dept);
    const headcount = inDept.filter(
      (p) =>
        String(p["Hire Date"]) <= monthEnd &&
        (p["Exit Date"] === "" || String(p["Exit Date"]) > monthEnd),
    ).length;
    const hires = inDept.filter((p) => String(p["Hire Month"]) === month).length;
    const exits = inDept.filter((p) => String(p["Exit Month"]) === month).length;
    deptMonthly.push({
      Month: month,
      Department: dept,
      Headcount: headcount,
      Hires: hires,
      Exits: exits,
      "Attrition Pct": headcount > 0 ? r1((exits * 100) / headcount) : 0,
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Write CSVs
// ═════════════════════════════════════════════════════════════════════════════
const ASSETS = resolve(__dirname, "../src/assets/sample-data");
mkdirSync(ASSETS, { recursive: true });
writeFileSync(resolve(ASSETS, "supply_shipments.csv"), toCsv(shipments));
writeFileSync(resolve(ASSETS, "supply_carrier_scorecard.csv"), toCsv(scorecard));
writeFileSync(resolve(ASSETS, "hr_roster.csv"), toCsv(roster));
writeFileSync(resolve(ASSETS, "hr_dept_monthly.csv"), toCsv(deptMonthly));
console.log(
  `CSVs: shipments=${shipments.length} scorecard=${scorecard.length} roster=${roster.length} deptMonthly=${deptMonthly.length}`,
);

// ═════════════════════════════════════════════════════════════════════════════
// 4. Dashboards — widgets with SQL; snapshots computed below in DuckDB
// ═════════════════════════════════════════════════════════════════════════════
type Widget = Record<string, unknown>;
const W = (w: Widget): Widget => w;
const REFRESHED = "2026-08-07T12:00:00.000Z";

// Stable ids: readable, unique within the migration.
const sid = (s: string) => `a5c00${s}`.padEnd(8, "0") + "-5amp-4le0-8000-000000000000".slice(0, 28);
const id = (n: string) => {
  // Deterministic uuid-shaped id from a label.
  let h = 2166136261;
  for (const ch of n) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const hex = (x: number) => (x >>> 0).toString(16).padStart(8, "0");
  const a = hex(h),
    b = hex(Math.imul(h, 2654435761));
  return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-8${a.slice(0, 3)}-${b}${a.slice(0, 4)}`;
};
void sid;

const supplyOntology = {
  builtAt: REFRESHED,
  summary:
    "How the logistics sample fits together: shipments feed the carrier scorecard, the semantic model governs the metrics, and the Logistics Operations Handbook defines the concepts the numbers are held to.",
  aiEnriched: false,
  domains: ["Logistics", "Knowledge"],
  notes: [
    "OTIF and damage thresholds come from the handbook's Carrier SLA policy — the scorecard is measured against them.",
    "supply_carrier_scorecard is the output of the 'Carrier scorecard · Sample' prep flow over supply_shipments.",
  ],
  entities: [
    {
      id: "ds-shipments",
      name: "Shipments",
      table: "supply_shipments",
      source: "Local",
      sourceKind: "local",
      category: "transaction",
      domain: "Logistics",
      description: "One row per shipment: carrier, mode, lane, cost, transit and outcome flags.",
      rowCount: shipments.length,
      columnCount: 20,
      keyColumns: ["Shipment ID"],
      fields: [
        { name: "Shipment ID", type: "text", semantic: "identifier" },
        { name: "Month", type: "text", semantic: "period" },
        { name: "Carrier", type: "text" },
        { name: "Mode", type: "text" },
        { name: "Origin Warehouse", type: "text" },
        { name: "Dest Region", type: "text" },
        { name: "Dest Country", type: "text" },
        { name: "Units", type: "number" },
        { name: "Freight Cost", type: "number", semantic: "currency" },
        { name: "Transit Days", type: "number" },
        { name: "On Time", type: "text" },
        { name: "CO2 Kg", type: "number" },
      ],
    },
    {
      id: "ds-scorecard",
      name: "Carrier scorecard",
      table: "supply_carrier_scorecard",
      source: "Prepared",
      sourceKind: "prepared",
      category: "metric",
      domain: "Logistics",
      description:
        "Month × carrier rollup produced by the sample prep flow: volume, OTIF, transit, cost and damage.",
      rowCount: scorecard.length,
      columnCount: 7,
      keyColumns: ["Month", "Carrier"],
      fields: [
        { name: "Month", type: "text", semantic: "period" },
        { name: "Carrier", type: "text" },
        { name: "Shipments", type: "number" },
        { name: "On Time Pct", type: "number", semantic: "percentage" },
        { name: "Avg Transit Days", type: "number" },
        { name: "Freight Cost", type: "number", semantic: "currency" },
        { name: "Damage Pct", type: "number", semantic: "percentage" },
      ],
    },
    {
      id: "kb-handbook",
      name: "Logistics Operations Handbook",
      table: "Sample · Logistics Operations Handbook",
      source: "Knowledge",
      sourceKind: "knowledge",
      category: "document",
      domain: "Knowledge",
      description:
        "Carrier SLA & OTIF policy, the warehouse network, and the freight-cost / CO₂ methodology.",
      columnCount: 0,
      keyColumns: [],
      fields: [
        { name: "Carrier SLA & OTIF Policy.md", type: "document" },
        { name: "Warehouse Network & Lanes.md", type: "document" },
        { name: "Freight Cost & CO2 Methodology.md", type: "document" },
      ],
    },
    {
      id: "c-otif",
      name: "OTIF",
      table: "OTIF",
      source: "Knowledge",
      sourceKind: "concept",
      category: "concept",
      domain: "Knowledge",
      conceptType: "kpi",
      description:
        "On-Time-In-Full: delivered within SLA days and undamaged. Network target ≥ 95%; per-carrier floor 90%.",
      columnCount: 0,
      keyColumns: [],
      fields: [],
    },
    {
      id: "c-carrier",
      name: "Carrier",
      table: "Carrier",
      source: "Knowledge",
      sourceKind: "concept",
      category: "concept",
      domain: "Logistics",
      conceptType: "org",
      description:
        "A contracted transport provider (Meridian Freight, BlueDart Express, TransGlobal, Arctic Line), each with an SLA tier in the handbook.",
      columnCount: 0,
      keyColumns: [],
      fields: [],
    },
    {
      id: "c-lane",
      name: "Lane",
      table: "Lane",
      source: "Knowledge",
      sourceKind: "concept",
      category: "concept",
      domain: "Logistics",
      conceptType: "route",
      description:
        "Origin warehouse → destination region pairing; the unit at which SLA days and CO₂ factors are set.",
      columnCount: 0,
      keyColumns: [],
      fields: [],
    },
  ],
  relations: [
    {
      from: "ds-scorecard",
      to: "ds-shipments",
      label: "derived from",
      predicate: "derived_from",
      kind: "lineage",
      cardinality: "N:1",
    },
    {
      from: "ds-shipments",
      to: "c-carrier",
      label: "performed by",
      predicate: "references",
      kind: "semantic",
      cardinality: "N:1",
    },
    {
      from: "ds-shipments",
      to: "c-lane",
      label: "moves along",
      predicate: "references",
      kind: "semantic",
      cardinality: "N:1",
    },
    {
      from: "kb-handbook",
      to: "c-otif",
      label: "defines",
      predicate: "defines",
      kind: "knowledge",
      cardinality: "1:N",
    },
    {
      from: "kb-handbook",
      to: "c-carrier",
      label: "sets SLA for",
      predicate: "defines",
      kind: "knowledge",
      cardinality: "1:N",
    },
    {
      from: "ds-scorecard",
      to: "c-otif",
      label: "measures",
      predicate: "measures",
      kind: "semantic",
      cardinality: "N:1",
    },
  ],
};

const peopleOntology = {
  builtAt: REFRESHED,
  summary:
    "The people-analytics sample: the roster is the system of record, the monthly rollup tracks headcount and attrition per department, and the People Operations Playbook defines how attrition and engagement are measured.",
  aiEnriched: false,
  domains: ["People", "Knowledge"],
  notes: [
    "Attrition % follows the playbook definition: exits in month ÷ headcount at month end.",
    "hr_dept_monthly is the output of the 'Attrition by month · Sample' prep flow over hr_roster.",
  ],
  entities: [
    {
      id: "ds-roster",
      name: "Employee roster",
      table: "hr_roster",
      source: "Local",
      sourceKind: "local",
      category: "master",
      domain: "People",
      description:
        "One row per employee: org placement, dates, compensation band, performance and engagement.",
      rowCount: roster.length,
      columnCount: 18,
      keyColumns: ["Employee ID"],
      fields: [
        { name: "Employee ID", type: "text", semantic: "identifier" },
        { name: "Department", type: "text" },
        { name: "Level", type: "text" },
        { name: "Location", type: "text" },
        { name: "Hire Date", type: "date" },
        { name: "Exit Date", type: "date" },
        { name: "Status", type: "text" },
        { name: "Tenure Months", type: "number" },
        { name: "Salary USD", type: "number", semantic: "currency" },
        { name: "Performance", type: "number" },
        { name: "Engagement", type: "number" },
      ],
    },
    {
      id: "ds-monthly",
      name: "Department monthly",
      table: "hr_dept_monthly",
      source: "Prepared",
      sourceKind: "prepared",
      category: "metric",
      domain: "People",
      description:
        "Month × department headcount, hires, exits and attrition — the trend backbone of the dashboard.",
      rowCount: deptMonthly.length,
      columnCount: 6,
      keyColumns: ["Month", "Department"],
      fields: [
        { name: "Month", type: "text", semantic: "period" },
        { name: "Department", type: "text" },
        { name: "Headcount", type: "number" },
        { name: "Hires", type: "number" },
        { name: "Exits", type: "number" },
        { name: "Attrition Pct", type: "number", semantic: "percentage" },
      ],
    },
    {
      id: "kb-playbook",
      name: "People Operations Playbook",
      table: "Sample · People Operations Playbook",
      source: "Knowledge",
      sourceKind: "knowledge",
      category: "document",
      domain: "Knowledge",
      description:
        "Attrition definitions and targets, the job architecture and comp bands, and the engagement survey method.",
      columnCount: 0,
      keyColumns: [],
      fields: [
        { name: "Attrition Definitions & Targets.md", type: "document" },
        { name: "Job Architecture & Comp Bands.md", type: "document" },
        { name: "Engagement Survey Methodology.md", type: "document" },
      ],
    },
    {
      id: "c-attrition",
      name: "Attrition",
      table: "Attrition",
      source: "Knowledge",
      sourceKind: "concept",
      category: "concept",
      domain: "People",
      conceptType: "kpi",
      description:
        "Monthly exits ÷ month-end headcount. Company guardrail: ≤ 1.5%/month; Support carries the highest structural risk.",
      columnCount: 0,
      keyColumns: [],
      fields: [],
    },
    {
      id: "c-band",
      name: "Comp band",
      table: "Comp band",
      source: "Knowledge",
      sourceKind: "concept",
      category: "concept",
      domain: "People",
      conceptType: "policy",
      description:
        "Salary range per level (IC1–IC5, M1–M2) from the job architecture; offers land in-band by policy.",
      columnCount: 0,
      keyColumns: [],
      fields: [],
    },
    {
      id: "c-engagement",
      name: "Engagement score",
      table: "Engagement score",
      source: "Knowledge",
      sourceKind: "concept",
      category: "concept",
      domain: "People",
      conceptType: "kpi",
      description:
        "Quarterly pulse survey, 1–10. A department mean under 6.0 triggers a listening session per the playbook.",
      columnCount: 0,
      keyColumns: [],
      fields: [],
    },
  ],
  relations: [
    {
      from: "ds-monthly",
      to: "ds-roster",
      label: "derived from",
      predicate: "derived_from",
      kind: "lineage",
      cardinality: "N:1",
    },
    {
      from: "kb-playbook",
      to: "c-attrition",
      label: "defines",
      predicate: "defines",
      kind: "knowledge",
      cardinality: "1:N",
    },
    {
      from: "kb-playbook",
      to: "c-band",
      label: "defines",
      predicate: "defines",
      kind: "knowledge",
      cardinality: "1:N",
    },
    {
      from: "kb-playbook",
      to: "c-engagement",
      label: "defines",
      predicate: "defines",
      kind: "knowledge",
      cardinality: "1:N",
    },
    {
      from: "ds-monthly",
      to: "c-attrition",
      label: "measures",
      predicate: "measures",
      kind: "semantic",
      cardinality: "N:1",
    },
    {
      from: "ds-roster",
      to: "c-band",
      label: "graded by",
      predicate: "references",
      kind: "semantic",
      cardinality: "N:1",
    },
  ],
};

// ── Widget definitions ───────────────────────────────────────────────────────
const supplyWidgets: Widget[] = [
  W({
    id: id("sc-about"),
    kind: "text",
    title: "About this sample",
    text: "## 🚚 Supply Chain Pulse\nA **sample project** on the bundled `supply_shipments` dataset (360 shipments, Jan 2025 – Jun 2026) and `supply_carrier_scorecard` — the output of the **Carrier scorecard · Sample** prep flow. Metrics follow the **Logistics Operations Handbook** knowledge base (OTIF ≥ 95%, damage < 2%). Cross-filter by clicking any bar or slice, slice by carrier/mode/region in the filter bar, or open **Ask AI** to add a visual in plain English. The **Business ontology** widget at the bottom maps how datasets, the prep flow and the handbook's concepts connect.",
  }),
  W({
    id: id("sc-kpi-otif"),
    kind: "chart",
    title: "OTIF",
    source: { kind: "local" },
    sql: `SELECT ROUND(AVG("On Time Num"),1) AS "OTIF %" FROM supply_shipments`,
    chart: { type: "kpi", valueField: "OTIF %", label: "On time, in full" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "teal" },
  }),
  W({
    id: id("sc-kpi-transit"),
    kind: "chart",
    title: "Avg transit",
    source: { kind: "local" },
    sql: `SELECT ROUND(AVG("Transit Days"),1) AS "Avg Transit Days" FROM supply_shipments`,
    chart: { type: "kpi", valueField: "Avg Transit Days", label: "Days door-to-door" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "blue" },
  }),
  W({
    id: id("sc-kpi-freight"),
    kind: "chart",
    title: "Freight spend",
    source: { kind: "local" },
    sql: `SELECT ROUND(SUM("Freight Cost"),0) AS "Freight Cost" FROM supply_shipments`,
    chart: { type: "kpi", valueField: "Freight Cost", label: "Total freight", format: "currency" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "violet" },
  }),
  W({
    id: id("sc-kpi-co2"),
    kind: "chart",
    title: "CO₂ intensity",
    source: { kind: "local" },
    sql: `SELECT ROUND(SUM("CO2 Kg")*1.0/SUM(Units),2) AS "CO2 per Unit" FROM supply_shipments`,
    chart: { type: "kpi", valueField: "CO2 per Unit", label: "kg CO₂ per unit shipped" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "emerald" },
  }),
  W({
    id: id("sc-otif-trend"),
    kind: "chart",
    title: "OTIF trend · network vs 95% target",
    source: { kind: "local" },
    sql: `SELECT Month, ROUND(AVG("On Time Num"),1) AS "OTIF %" FROM supply_shipments GROUP BY Month ORDER BY Month`,
    chart: { type: "line", xField: "Month", yField: "OTIF %", trend: true },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "teal" },
    narrative:
      "Winters dent the network — Arctic Line's sea lanes slip in Dec–Feb — but the underlying trend improves as BlueDart's share of urgent lanes grows.",
  }),
  W({
    id: id("sc-carrier-otif"),
    kind: "chart",
    title: "Carrier OTIF · month by month",
    source: { kind: "local" },
    sql: `SELECT Month, Carrier, "On Time Pct" FROM supply_carrier_scorecard ORDER BY Carrier, Month`,
    chart: {
      type: "matrix",
      rowField: "Carrier",
      colField: "Month",
      valueField: "On Time Pct",
      // First match wins: ≥90 clears the handbook's per-carrier floor.
      condFormat: {
        mode: "rules",
        rules: [
          { op: "gte", value: 95, color: "emerald" },
          { op: "gte", value: 90, color: "amber" },
          { op: "lt", value: 90, color: "rose" },
        ],
      },
    },
    refreshed_at: REFRESHED,
    theme: { card: "glass" },
    narrative:
      "Built on the prep-flow output. Green cells clear the handbook's 90% per-carrier floor; Arctic Line's winter dip is the red band.",
  }),
  W({
    id: id("sc-freight-mode"),
    kind: "chart",
    title: "Freight cost by carrier, stacked by mode",
    source: { kind: "local" },
    sql: `SELECT Carrier, Mode, ROUND(SUM("Freight Cost"),0) AS "Freight" FROM supply_shipments GROUP BY Carrier, Mode ORDER BY Carrier, Mode`,
    chart: {
      type: "bar",
      xField: "Carrier",
      yField: "Freight",
      seriesField: "Mode",
      stacked: true,
      format: "currency",
    },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "violet" },
  }),
  W({
    id: id("sc-lane-heat"),
    kind: "chart",
    title: "Lane health · origin × region OTIF",
    source: { kind: "local" },
    sql: `SELECT "Origin Warehouse" AS "Origin", "Dest Region" AS "Region", ROUND(AVG("On Time Num"),0) AS "OTIF %" FROM supply_shipments GROUP BY "Origin Warehouse", "Dest Region" ORDER BY "Origin", "Region"`,
    chart: { type: "heatmap", xField: "Region", yField: "Origin", valueField: "OTIF %" },
    refreshed_at: REFRESHED,
    theme: { card: "glass" },
  }),
  W({
    id: id("sc-mode-mix"),
    kind: "chart",
    title: "Mode mix",
    source: { kind: "local" },
    sql: `SELECT Mode, COUNT(*) AS "Shipments" FROM supply_shipments GROUP BY Mode ORDER BY "Shipments" DESC, Mode`,
    chart: { type: "pie", nameField: "Mode", valueField: "Shipments" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "blue" },
  }),
  W({
    id: id("sc-country-map"),
    kind: "chart",
    title: "Shipments by destination",
    source: { kind: "local" },
    sql: `SELECT "Dest Country" AS "Country", COUNT(*) AS "Shipments" FROM supply_shipments GROUP BY "Dest Country" ORDER BY "Shipments" DESC, "Country"`,
    chart: { type: "bubblemap", locationField: "Country", valueField: "Shipments" },
    refreshed_at: REFRESHED,
    theme: { card: "glass" },
  }),
  W({
    id: id("sc-cost-transit"),
    kind: "chart",
    title: "Cost vs speed by carrier & mode",
    source: { kind: "local" },
    sql: `SELECT Carrier || ' · ' || Mode AS "Service", ROUND(AVG("Freight Cost"),0) AS "Avg Freight", ROUND(AVG("Transit Days"),1) AS "Avg Transit", COUNT(*) AS "Shipments" FROM supply_shipments GROUP BY Carrier, Mode ORDER BY Carrier, Mode`,
    chart: {
      type: "scatter",
      xField: "Avg Transit",
      yField: "Avg Freight",
      sizeField: "Shipments",
      format: "currency",
    },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "rose" },
    narrative:
      "The classic trade-off, priced: BlueDart air services sit top-left (fast, dear), Arctic sea bottom-right (slow, cheap). Anything drifting toward top-right is a renegotiation candidate.",
  }),
  W({
    id: id("sc-damage"),
    kind: "chart",
    title: "Damage rate by category",
    source: { kind: "local" },
    sql: `SELECT Category, ROUND(AVG("Damaged Num"),1) AS "Damage %" FROM supply_shipments GROUP BY Category ORDER BY "Damage %" DESC, Category`,
    chart: { type: "hbar", xField: "Category", yField: "Damage %" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "amber" },
  }),
  W({
    id: id("sc-ontology"),
    kind: "chart",
    title: "Business ontology · data ↔ knowledge",
    source: { kind: "local" },
    sql: "",
    columns: [],
    rows: [],
    chart: { type: "ontology", spec: supplyOntology },
    refreshed_at: REFRESHED,
    theme: { card: "glass" },
  }),
];
const supplyLayout = [
  { i: id("sc-about"), x: 0, y: 0, w: 12, h: 2 },
  { i: id("sc-kpi-otif"), x: 0, y: 2, w: 3, h: 3 },
  { i: id("sc-kpi-transit"), x: 3, y: 2, w: 3, h: 3 },
  { i: id("sc-kpi-freight"), x: 6, y: 2, w: 3, h: 3 },
  { i: id("sc-kpi-co2"), x: 9, y: 2, w: 3, h: 3 },
  { i: id("sc-otif-trend"), x: 0, y: 5, w: 7, h: 5 },
  { i: id("sc-mode-mix"), x: 7, y: 5, w: 5, h: 5 },
  { i: id("sc-carrier-otif"), x: 0, y: 10, w: 12, h: 5 },
  { i: id("sc-freight-mode"), x: 0, y: 15, w: 6, h: 5 },
  { i: id("sc-lane-heat"), x: 6, y: 15, w: 6, h: 5 },
  { i: id("sc-country-map"), x: 0, y: 20, w: 7, h: 6 },
  { i: id("sc-cost-transit"), x: 7, y: 20, w: 5, h: 6 },
  { i: id("sc-damage"), x: 0, y: 26, w: 5, h: 4 },
  { i: id("sc-ontology"), x: 0, y: 30, w: 12, h: 8 },
];
const supplyFilters = [
  { id: "f-carrier", label: "Carrier", column: "Carrier", kind: "select" },
  { id: "f-mode", label: "Mode", column: "Mode", kind: "select" },
  { id: "f-region", label: "Dest region", column: "Dest Region", kind: "select" },
  { id: "f-date", label: "Order date", column: "Order Date", kind: "daterange" },
];

const peopleWidgets: Widget[] = [
  W({
    id: id("hr-about"),
    kind: "text",
    title: "About this sample",
    text: "## 👥 People Analytics\nA **sample project** on the bundled `hr_roster` (420 employees) and `hr_dept_monthly` — the output of the **Attrition by month · Sample** prep flow. Definitions follow the **People Operations Playbook** knowledge base: attrition = exits ÷ month-end headcount, engagement is a 1–10 pulse score. Cross-filter by department or level, or open **Ask AI** to interrogate the roster in plain English. The **Business ontology** widget maps the roster, the rollup, and the playbook's concepts.",
  }),
  W({
    id: id("hr-kpi-head"),
    kind: "chart",
    title: "Headcount",
    source: { kind: "local" },
    sql: `SELECT COUNT(*) AS "Active" FROM hr_roster WHERE Status = 'Active'`,
    chart: { type: "kpi", valueField: "Active", label: "Active employees" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "blue" },
  }),
  W({
    id: id("hr-kpi-attr"),
    kind: "chart",
    title: "Attrition",
    source: { kind: "local" },
    sql: `SELECT ROUND(AVG("Exited Num")*100,1) AS "Attrition %" FROM hr_roster`,
    chart: { type: "kpi", valueField: "Attrition %", label: "Exited over the window" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "rose" },
  }),
  W({
    id: id("hr-kpi-tenure"),
    kind: "chart",
    title: "Tenure",
    source: { kind: "local" },
    sql: `SELECT ROUND(AVG("Tenure Months")/12.0,1) AS "Avg Tenure Years" FROM hr_roster WHERE Status = 'Active'`,
    chart: { type: "kpi", valueField: "Avg Tenure Years", label: "Avg tenure (years)" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "teal" },
  }),
  W({
    id: id("hr-kpi-eng"),
    kind: "chart",
    title: "Engagement",
    source: { kind: "local" },
    sql: `SELECT ROUND(AVG(Engagement),1) AS "Engagement" FROM hr_roster WHERE Status = 'Active'`,
    chart: { type: "kpi", valueField: "Engagement", label: "Pulse score /10" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "emerald" },
  }),
  W({
    id: id("hr-head-trend"),
    kind: "chart",
    title: "Headcount by department",
    source: { kind: "local" },
    sql: `SELECT Month, Department, Headcount FROM hr_dept_monthly ORDER BY Month, Department`,
    chart: {
      type: "area",
      xField: "Month",
      yField: "Headcount",
      seriesField: "Department",
      stacked: true,
    },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "blue" },
    narrative:
      "Prep-flow output: month-end headcount per department, stacked to the company total.",
  }),
  W({
    id: id("hr-flow"),
    kind: "chart",
    title: "Hires vs exits",
    source: { kind: "local" },
    sql: `SELECT Month, SUM(Hires) AS "Hires", SUM(Exits) AS "Exits" FROM hr_dept_monthly GROUP BY Month ORDER BY Month`,
    chart: { type: "combo", xField: "Month", barField: "Hires", lineField: "Exits" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "violet" },
  }),
  W({
    id: id("hr-attr-dept"),
    kind: "chart",
    title: "Attrition by department",
    source: { kind: "local" },
    sql: `SELECT Department, ROUND(AVG("Exited Num")*100,1) AS "Attrition %" FROM hr_roster GROUP BY Department ORDER BY "Attrition %" DESC, Department`,
    chart: { type: "hbar", xField: "Department", yField: "Attrition %" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "rose" },
    narrative:
      "Support and Sales run hottest — consistent with the playbook's risk note that customer-facing teams carry structurally higher churn.",
  }),
  W({
    id: id("hr-eng-matrix"),
    kind: "chart",
    title: "Engagement · department × level",
    source: { kind: "local" },
    sql: `SELECT Department, Level, ROUND(AVG(Engagement),1) AS "Engagement" FROM hr_roster WHERE Status = 'Active' GROUP BY Department, Level ORDER BY Department, Level`,
    chart: {
      type: "matrix",
      rowField: "Department",
      colField: "Level",
      valueField: "Engagement",
      condFormat: { mode: "scale", color: "emerald" },
    },
    refreshed_at: REFRESHED,
    theme: { card: "glass" },
  }),
  W({
    id: id("hr-salary-perf"),
    kind: "chart",
    title: "Pay vs performance by level",
    source: { kind: "local" },
    sql: `SELECT Level, ROUND(AVG("Salary USD"),0) AS "Avg Salary", ROUND(AVG(Performance),2) AS "Avg Performance", COUNT(*) AS "People" FROM hr_roster WHERE Status = 'Active' GROUP BY Level ORDER BY Level`,
    chart: {
      type: "scatter",
      xField: "Avg Performance",
      yField: "Avg Salary",
      sizeField: "People",
      format: "currency",
    },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "amber" },
  }),
  W({
    id: id("hr-loc-tree"),
    kind: "chart",
    title: "Headcount by location",
    source: { kind: "local" },
    sql: `SELECT Location, COUNT(*) AS "People" FROM hr_roster WHERE Status = 'Active' GROUP BY Location ORDER BY "People" DESC, Location`,
    chart: { type: "treemap", nameField: "Location", valueField: "People" },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "teal" },
  }),
  W({
    id: id("hr-gender"),
    kind: "chart",
    title: "Gender mix by department",
    source: { kind: "local" },
    sql: `SELECT Department, Gender, COUNT(*) AS "People" FROM hr_roster WHERE Status = 'Active' GROUP BY Department, Gender ORDER BY Department, Gender`,
    chart: {
      type: "bar",
      xField: "Department",
      yField: "People",
      seriesField: "Gender",
      stacked: true,
    },
    refreshed_at: REFRESHED,
    theme: { card: "glass", accent: "violet" },
  }),
  W({
    id: id("hr-ontology"),
    kind: "chart",
    title: "Business ontology · data ↔ knowledge",
    source: { kind: "local" },
    sql: "",
    columns: [],
    rows: [],
    chart: { type: "ontology", spec: peopleOntology },
    refreshed_at: REFRESHED,
    theme: { card: "glass" },
  }),
];
const peopleLayout = [
  { i: id("hr-about"), x: 0, y: 0, w: 12, h: 2 },
  { i: id("hr-kpi-head"), x: 0, y: 2, w: 3, h: 3 },
  { i: id("hr-kpi-attr"), x: 3, y: 2, w: 3, h: 3 },
  { i: id("hr-kpi-tenure"), x: 6, y: 2, w: 3, h: 3 },
  { i: id("hr-kpi-eng"), x: 9, y: 2, w: 3, h: 3 },
  { i: id("hr-head-trend"), x: 0, y: 5, w: 7, h: 5 },
  { i: id("hr-flow"), x: 7, y: 5, w: 5, h: 5 },
  { i: id("hr-attr-dept"), x: 0, y: 10, w: 5, h: 5 },
  { i: id("hr-eng-matrix"), x: 5, y: 10, w: 7, h: 5 },
  { i: id("hr-salary-perf"), x: 0, y: 15, w: 6, h: 5 },
  { i: id("hr-loc-tree"), x: 6, y: 15, w: 3, h: 5 },
  { i: id("hr-gender"), x: 9, y: 15, w: 3, h: 5 },
  { i: id("hr-ontology"), x: 0, y: 20, w: 12, h: 8 },
];
const peopleFilters = [
  { id: "f-dept", label: "Department", column: "Department", kind: "select" },
  { id: "f-level", label: "Level", column: "Level", kind: "select" },
  { id: "f-loc", label: "Location", column: "Location", kind: "select" },
];

// ═════════════════════════════════════════════════════════════════════════════
// 5. Snapshots via DuckDB, then emit the migration
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const load = async (t: string) => {
    const p = resolve(ASSETS, `${t}.csv`).replace(/\\/g, "/");
    await conn.run(`CREATE TABLE "${t}" AS SELECT * FROM read_csv_auto('${p}', header=true)`);
  };
  for (const t of ["supply_shipments", "supply_carrier_scorecard", "hr_roster", "hr_dept_monthly"])
    await load(t);

  const sanitize = (v: unknown): unknown => {
    if (typeof v === "bigint") return Number(v);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v && typeof v === "object") {
      const s = String(v);
      const n = Number(s);
      return Number.isFinite(n) && s.trim() !== "" ? n : s;
    }
    return v;
  };

  for (const w of [...supplyWidgets, ...peopleWidgets]) {
    if (w.kind !== "chart" || !w.sql) continue;
    const reader = await conn.runAndReadAll(String(w.sql));
    const rows = reader.getRowObjects().map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) out[k] = sanitize(v);
      return out;
    });
    w.columns = reader.columnNames();
    w.rows = rows;
    if (rows.length === 0) throw new Error(`Widget "${w.title}" returned 0 rows`);
  }
  console.log("snapshots computed for all widgets");

  // ── Migration SQL ──────────────────────────────────────────────────────────
  const jq = (v: unknown) => {
    const json = JSON.stringify(v);
    if (json.includes("$sample$")) throw new Error("dollar-quote collision");
    return `$sample$${json}$sample$`;
  };
  const tq = (s: string) => {
    if (s.includes("$sample$")) throw new Error("dollar-quote collision");
    return `$sample$${s}$sample$`;
  };

  const kbDocs = (await import("./biSamplesKbDocs")).KB_DOCS;

  const migration = `-- Two more end-to-end samples: "Supply Chain Pulse" and "People Analytics".
--
-- Generated by scripts/buildBiSamples.ts — edit that script and re-run it
-- rather than editing this file. Each sample is the full story in one place:
--   dataset (bundled CSV, seeded as a global sample by src/lib/sampleData.ts)
--   → prep flow (seeded per user; its precomputed output also ships as a CSV
--     so the dashboard renders before anyone presses Run)
--   → semantic model (seeded per user, governed metrics over the dataset)
--   → dashboard (template below; widget snapshots computed in DuckDB from
--     the shipped CSVs, so ↻ reproduces exactly what you see)
--   → knowledge base (global sample docs) whose concepts appear in the
--     dashboard's ontology widget.

-- ── Knowledge bases ──────────────────────────────────────────────────────────
${kbDocs}

-- ── Dashboard templates ──────────────────────────────────────────────────────
INSERT INTO public.bi_sample_dashboards (sort, name, description, widgets, layout, filters, theme)
VALUES (7, ${tq("Supply Chain Pulse · Sample")}, ${tq(
    "Carrier OTIF, freight cost, lane health and CO₂ across 360 shipments — with the carrier scorecard built by the bundled prep flow and an ontology tying data to the Logistics Operations Handbook.",
  )}, ${jq(supplyWidgets)}, ${jq(supplyLayout)}, ${jq(supplyFilters)}, ${jq({})})
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.bi_sample_dashboards (sort, name, description, widgets, layout, filters, theme)
VALUES (8, ${tq("People Analytics · Sample")}, ${tq(
    "Headcount, attrition, engagement and pay equity across a 420-person roster — with the monthly rollup built by the bundled prep flow and an ontology tying data to the People Operations Playbook.",
  )}, ${jq(peopleWidgets)}, ${jq(peopleLayout)}, ${jq(peopleFilters)}, ${jq({})})
ON CONFLICT (name) DO NOTHING;

-- ── Per-user extras: semantic models + prep flows ────────────────────────────
-- Both tables are strictly per-user (user_id NOT NULL), so these seed like the
-- sample dashboards do: a SECURITY DEFINER function, called on signup and
-- backfilled below. table_id / output_table_id resolve lazily by name — NULL
-- until the global sample datasets exist, which is fine: the semantic layer
-- compiles from source_table (the name), and the prep flow resolves its output
-- when run.
CREATE OR REPLACE FUNCTION public.seed_bi_sample_extras(_uid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _ship_tid uuid;
  _roster_tid uuid;
BEGIN
  SELECT id INTO _ship_tid FROM public.user_data_tables
    WHERE name = 'supply_shipments' AND is_sample = true AND user_id IS NULL LIMIT 1;
  SELECT id INTO _roster_tid FROM public.user_data_tables
    WHERE name = 'hr_roster' AND is_sample = true AND user_id IS NULL LIMIT 1;

  INSERT INTO public.semantic_models
    (user_id, name, label, description, source_kind, table_id, source_table, dimensions, metrics)
  SELECT _uid, 'supply_shipments_model', 'Supply Shipments',
         'Governed logistics metrics over supply_shipments — OTIF, transit, freight and CO₂, sliced by carrier, mode, lane and month.',
         'data_table', _ship_tid, 'supply_shipments',
         ${jq([
           { name: "carrier", sql: '"Carrier"', type: "categorical" },
           { name: "mode", sql: '"Mode"', type: "categorical" },
           { name: "origin_warehouse", sql: '"Origin Warehouse"', type: "categorical" },
           { name: "dest_region", sql: '"Dest Region"', type: "categorical" },
           { name: "category", sql: '"Category"', type: "categorical" },
           { name: "order_date", sql: '"Order Date"', type: "time" },
         ])}::jsonb,
         ${jq([
           { name: "shipments", agg: "count" },
           { name: "units", agg: "sum", sql: '"Units"' },
           { name: "freight_cost", agg: "sum", sql: '"Freight Cost"' },
           { name: "order_value", agg: "sum", sql: '"Order Value"' },
           { name: "otif_pct", agg: "avg", sql: '"On Time Num"' },
           { name: "avg_transit_days", agg: "avg", sql: '"Transit Days"' },
           { name: "co2_kg", agg: "sum", sql: '"CO2 Kg"' },
         ])}::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM public.semantic_models m WHERE m.user_id = _uid AND m.name = 'supply_shipments_model'
  );

  INSERT INTO public.semantic_models
    (user_id, name, label, description, source_kind, table_id, source_table, dimensions, metrics)
  SELECT _uid, 'hr_roster_model', 'Employee Roster',
         'Governed people metrics over hr_roster — headcount, attrition, tenure, pay and engagement by department, level and location.',
         'data_table', _roster_tid, 'hr_roster',
         ${jq([
           { name: "department", sql: '"Department"', type: "categorical" },
           { name: "level", sql: '"Level"', type: "categorical" },
           { name: "location", sql: '"Location"', type: "categorical" },
           { name: "gender", sql: '"Gender"', type: "categorical" },
           { name: "work_mode", sql: '"Work Mode"', type: "categorical" },
           { name: "hire_date", sql: '"Hire Date"', type: "time" },
         ])}::jsonb,
         ${jq([
           { name: "headcount", agg: "count" },
           { name: "exits", agg: "sum", sql: '"Exited Num"' },
           { name: "avg_tenure_months", agg: "avg", sql: '"Tenure Months"' },
           { name: "avg_salary", agg: "avg", sql: '"Salary USD"' },
           { name: "avg_engagement", agg: "avg", sql: '"Engagement"' },
           { name: "avg_performance", agg: "avg", sql: '"Performance"' },
         ])}::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM public.semantic_models m WHERE m.user_id = _uid AND m.name = 'hr_roster_model'
  );

  INSERT INTO public.user_prep_flows (user_id, name, config, output_table_name)
  SELECT _uid, 'Carrier scorecard · Sample',
         ${jq({
           base: "supply_shipments",
           joins: [],
           columns: [
             {
               key: "supply_shipments.Month",
               table: "supply_shipments",
               column: "Month",
               include: true,
               outputName: "Month",
               type: "text",
             },
             {
               key: "supply_shipments.Carrier",
               table: "supply_shipments",
               column: "Carrier",
               include: true,
               outputName: "Carrier",
               type: "text",
             },
             {
               key: "supply_shipments.On Time Num",
               table: "supply_shipments",
               column: "On Time Num",
               include: true,
               outputName: "On Time Num",
               type: "number",
             },
             {
               key: "supply_shipments.Transit Days",
               table: "supply_shipments",
               column: "Transit Days",
               include: true,
               outputName: "Transit Days",
               type: "number",
             },
             {
               key: "supply_shipments.Freight Cost",
               table: "supply_shipments",
               column: "Freight Cost",
               include: true,
               outputName: "Freight Cost",
               type: "number",
             },
             {
               key: "supply_shipments.Damaged Num",
               table: "supply_shipments",
               column: "Damaged Num",
               include: true,
               outputName: "Damaged Num",
               type: "number",
             },
           ],
           steps: [
             {
               id: "st-agg",
               kind: "aggregate",
               groupBy: ["Month", "Carrier"],
               measures: [
                 { id: "m1", column: "", fn: "count", name: "Shipments" },
                 { id: "m2", column: "On Time Num", fn: "avg", name: "On Time Pct" },
                 { id: "m3", column: "Transit Days", fn: "avg", name: "Avg Transit Days" },
                 { id: "m4", column: "Freight Cost", fn: "sum", name: "Freight Cost" },
                 { id: "m5", column: "Damaged Num", fn: "avg", name: "Damage Pct" },
               ],
             },
           ],
         })}::jsonb,
         'supply_carrier_scorecard_run'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_prep_flows f WHERE f.user_id = _uid AND f.name = 'Carrier scorecard · Sample'
  );

  INSERT INTO public.user_prep_flows (user_id, name, config, output_table_name)
  SELECT _uid, 'Attrition by month · Sample',
         ${jq({
           base: "hr_roster",
           joins: [],
           columns: [
             {
               key: "hr_roster.Exit Month",
               table: "hr_roster",
               column: "Exit Month",
               include: true,
               outputName: "Exit Month",
               type: "text",
             },
             {
               key: "hr_roster.Department",
               table: "hr_roster",
               column: "Department",
               include: true,
               outputName: "Department",
               type: "text",
             },
             {
               key: "hr_roster.Tenure Months",
               table: "hr_roster",
               column: "Tenure Months",
               include: true,
               outputName: "Tenure Months",
               type: "number",
             },
             {
               key: "hr_roster.Status",
               table: "hr_roster",
               column: "Status",
               include: true,
               outputName: "Status",
               type: "text",
             },
           ],
           steps: [
             {
               id: "st-f",
               kind: "filter",
               combine: "AND",
               conditions: [{ id: "c1", column: "Status", op: "=", value: "Exited" }],
             },
             {
               id: "st-agg",
               kind: "aggregate",
               groupBy: ["Exit Month", "Department"],
               measures: [
                 { id: "m1", column: "", fn: "count", name: "Exits" },
                 { id: "m2", column: "Tenure Months", fn: "avg", name: "Avg Tenure At Exit" },
               ],
             },
           ],
         })}::jsonb,
         'hr_exits_by_month'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_prep_flows f WHERE f.user_id = _uid AND f.name = 'Attrition by month · Sample'
  );
END;
$$;

-- Signup trigger now seeds dashboards AND the extras.
CREATE OR REPLACE FUNCTION public.handle_new_user_bi_samples()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_bi_sample_dashboards(NEW.id);
  PERFORM public.seed_bi_sample_extras(NEW.id);
  RETURN NEW;
END;
$$;

-- Backfill: existing accounts get the new dashboards, models and flows.
DO $$
DECLARE u record;
BEGIN
  FOR u IN SELECT id FROM auth.users LOOP
    PERFORM public.seed_bi_sample_dashboards(u.id);
    PERFORM public.seed_bi_sample_extras(u.id);
  END LOOP;
END $$;
`;

  const out = resolve(
    __dirname,
    "../supabase/migrations/20260807000000_bi_samples_supply_people.sql",
  );
  writeFileSync(out, migration);
  console.log(`migration written: ${out} (${(migration.length / 1024).toFixed(0)} KB)`);
  conn.closeSync?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
