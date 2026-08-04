// Does the DIALECT branch of buildSqlPrompt produce SQL a real warehouse runs?
//
//   EVAL_ACCESS_TOKEN=... EVAL_CONNECTION_ID=... npx tsx evals/nl2sql/dialect-probe.ts
//
// The NL-to-SQL eval only ever exercises the LOCAL engine path: it sets
// `localEngine` and leaves `dialect` unset. buildSqlPrompt has a completely
// separate branch for a warehouse — different quoting advice, different
// instructions — and it had never been executed once in any measurement.
// "Works with Snowflake" was an untested claim.
//
// SAFETY, because this bills someone's warehouse. The probe:
//   * queries only SMALL tables (the largest here is ITEM at ~500k rows;
//     CATALOG_SALES in the same schema is 144 BILLION and is never touched),
//   * asks only aggregate questions, so nothing streams rows back,
//   * caps max_rows, and
//   * runs a fixed handful of questions, not a 61-question sweep.
// Adding a question over a fact table would change the cost by orders of
// magnitude; that is a decision for whoever owns the account, not a default.
import { buildSqlPrompt } from "@/lib/biAgent";
import { parseModelChoice } from "@/utils/providers/modelChoice";

const BASE = process.env.EVAL_BASE_URL ?? "http://localhost:8080";
const TOKEN = process.env.EVAL_ACCESS_TOKEN ?? "";
const CONNECTION = process.env.EVAL_CONNECTION_ID ?? "";
const MODEL = process.env.EVAL_MODEL;
const DIALECT = process.env.EVAL_DIALECT ?? "Snowflake";

if (!TOKEN || !CONNECTION) {
  console.error("EVAL_ACCESS_TOKEN and EVAL_CONNECTION_ID are required.");
  process.exit(1);
}

/** Schema text in the same shape describeSchema produces for the app. */
const SCHEMA = `TABLES:
TPCDS_SF100TCL.REASON: r_reason_sk (number), r_reason_id (string), r_reason_desc (string)
TPCDS_SF100TCL.CALL_CENTER: cc_call_center_sk (number), cc_name (string), cc_class (string), cc_employees (number), cc_city (string), cc_state (string), cc_country (string)
TPCDS_SF100TCL.INCOME_BAND: ib_income_band_sk (number), ib_lower_bound (number), ib_upper_bound (number)
TPCDS_SF100TCL.SHIP_MODE: sm_ship_mode_sk (number), sm_type (string), sm_code (string), sm_carrier (string)
TPCDS_SF100TCL.PROMOTION: p_promo_sk (number), p_promo_name (string), p_channel_email (string), p_channel_tv (string), p_discount_active (string), p_cost (number)`;

type Probe = {
  id: string;
  question: string;
  reference: string;
  /** Compare as a SET — the reference has ties, so row order is arbitrary. */ unordered?: boolean;
};

/** Aggregates over small dimension tables only. */
const PROBES: Probe[] = [
  {
    id: "count-small",
    question: "How many reasons are there?",
    reference: "SELECT COUNT(*) AS N FROM TPCDS_SF100TCL.REASON",
  },
  {
    // Compared as a SET. Several states tie at 3, so a graded row ORDER is a
    // coin toss on the tie-break — my reference sorted them alphabetically and
    // the model did not, which is not a defect in either. Third time I have
    // made this mistake in this eval; ties and `ordered` do not mix.
    id: "group-by-state",
    question: "How many call centers are in each state?",
    reference: "SELECT cc_state, COUNT(*) AS N FROM TPCDS_SF100TCL.CALL_CENTER GROUP BY cc_state",
    unordered: true,
  },
  {
    id: "avg-employees",
    question: "What is the average number of employees per call center?",
    reference: "SELECT AVG(cc_employees) AS AVG_EMP FROM TPCDS_SF100TCL.CALL_CENTER",
  },
  {
    id: "distinct-carriers",
    question: "How many distinct shipping carriers are there?",
    reference: "SELECT COUNT(DISTINCT sm_carrier) AS N FROM TPCDS_SF100TCL.SHIP_MODE",
  },
  {
    // Asks for the VALUE, not the row. Dozens of promotions tie at cost 1000,
    // so "which promotion" has no single answer and the winner is whichever
    // the engine emits first — I wrote that bug into this eval four separate
    // times before writing it down. The null trap this question exists for is
    // unaffected: it is still a superlative over a column with 28 nulls.
    id: "top-promo-cost",
    question: "What is the highest promotion cost?",
    reference: "SELECT MAX(p_cost) AS MAX_COST FROM TPCDS_SF100TCL.PROMOTION",
  },
  {
    id: "band-width",
    question: "What is the widest income band range?",
    reference:
      "SELECT MAX(ib_upper_bound - ib_lower_bound) AS WIDEST FROM TPCDS_SF100TCL.INCOME_BAND",
  },
];

async function generate(question: string): Promise<string> {
  const { systemPrompt, userPrompt } = buildSqlPrompt({
    question,
    plan: { intent: question, tables: [], steps: [] } as never,
    schema: SCHEMA,
    // THE POINT OF THIS FILE. Setting `dialect` takes the warehouse branch,
    // which the main runner never does.
    dialect: DIALECT,
  });
  const choice = parseModelChoice(MODEL);
  const res = await fetch(`${BASE}/api/bi`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      stage: "sql",
      systemPrompt,
      userPrompt,
      ...(choice ? { provider: choice.provider, model: choice.model } : {}),
    }),
  });
  if (!res.ok)
    throw new Error(`generation failed: ${res.status} ${(await res.text()).slice(0, 120)}`);
  // NESTED under `result` — the same shape run.ts reads. A first version read
  // body.sql and reported 0/6 "no sql in response", which looks exactly like a
  // total dialect failure and was entirely my own parsing.
  const j = (await res.json()) as { result?: { sql?: string }; error?: string };
  const sql = j.result?.sql ?? "";
  if (!sql) throw new Error(j.error ? `api: ${j.error}` : "the model returned no SQL");
  return sql;
}

async function run(sql: string): Promise<{ rows: Record<string, unknown>[]; ms: number }> {
  const res = await fetch(`${BASE}/api/warehouse/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ connection_id: CONNECTION, sql, max_rows: 50 }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(body.slice(0, 200));
  const j = JSON.parse(body) as { rows: Record<string, unknown>[]; duration_ms: number };
  return { rows: j.rows ?? [], ms: j.duration_ms ?? 0 };
}

/** Compare on values only — column NAMES differ freely between paraphrases. */
function signature(rows: Record<string, unknown>[], unordered = false): string {
  const lines = rows.map((r) =>
    Object.values(r)
      .map((v) => (typeof v === "number" ? v.toFixed(4) : String(v ?? "")))
      .join("|"),
  );
  // Sorting the LINES compares the rows as a set, which is what a question
  // with ties actually asks for.
  return (unordered ? [...lines].sort() : lines).join(" ;; ");
}

async function main() {
  console.log(`\nDialect probe · ${DIALECT} · ${PROBES.length} questions · small tables only\n`);
  let pass = 0;
  const failures: string[] = [];

  for (const p of PROBES) {
    let sql = "";
    try {
      sql = await generate(p.question);
      const [got, want] = await Promise.all([run(sql), run(p.reference)]);
      if (signature(got.rows, p.unordered) === signature(want.rows, p.unordered)) {
        pass++;
        console.log(`  PASS  ${p.id}  (${got.ms}ms)`);
      } else {
        failures.push(p.id);
        console.log(`  WRONG ${p.id}`);
        console.log(`        sql : ${sql.replace(/\s+/g, " ").slice(0, 150)}`);
        console.log(`        want: ${signature(want.rows, p.unordered).slice(0, 90)}`);
        console.log(`        got : ${signature(got.rows, p.unordered).slice(0, 90)}`);
      }
    } catch (e) {
      failures.push(p.id);
      console.log(`  ERROR ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
      if (sql) console.log(`        sql : ${sql.replace(/\s+/g, " ").slice(0, 150)}`);
    }
  }

  console.log(`\n${"─".repeat(58)}`);
  console.log(
    `Dialect accuracy: ${((pass / PROBES.length) * 100).toFixed(1)}%  (${pass}/${PROBES.length})`,
  );
  if (failures.length) console.log(`failed: ${failures.join(", ")}`);
  console.log(
    `\nThis measures the buildSqlPrompt DIALECT branch against a real warehouse.\n` +
      `It is not comparable to the local-engine score — different schema,\n` +
      `different questions, different engine.\n`,
  );
}

await main();
