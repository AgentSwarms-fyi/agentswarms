// Print a divergence report for the corpus. Run with:
//   npx tsx tests/differential/report.ts
//
// This is the exploratory view. The committed expectations in
// differential.test.ts are derived from it — never the other way round.
import { CORPUS } from "./corpus";
import { canonRows, runAll, ENGINES } from "./engines";

let agree = 0;
let differ = 0;
let errored = 0;

for (const entry of CORPUS) {
  const results = runAll(entry.sql);
  const canon: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const e of ENGINES) {
    const r = results[e.id];
    if (r.ok) canon[e.id] = canonRows(r.rows, Boolean(entry.ordered));
    else errors[e.id] = r.error;
  }
  const values = Object.values(canon);
  const anyError = Object.keys(errors).length > 0;
  const same = values.length === ENGINES.length && values.every((v) => v === values[0]);

  if (same) {
    agree++;
    continue;
  }
  if (anyError) errored++;
  else differ++;

  console.log(`\n── ${entry.id} ${anyError ? "(ERROR)" : "(DIFFER)"}`);
  console.log(`   ${entry.sql}`);
  for (const e of ENGINES) {
    const r = results[e.id];
    if (!r.ok) {
      console.log(`   ${e.id.padEnd(12)} ERROR: ${r.error.slice(0, 120)}`);
    } else {
      const c = canon[e.id];
      const preview = c.split("\n").slice(0, 4).join(" ;; ");
      console.log(
        `   ${e.id.padEnd(12)} ${r.rows.length} rows: ${preview.slice(0, 160)}${c.split("\n").length > 4 ? " …" : ""}`,
      );
    }
  }
}

console.log(
  `\n${agree} agree · ${differ} differ · ${errored} at least one engine errored · ${CORPUS.length} total\n`,
);
