#!/usr/bin/env node
// Can the previous release still run on the new schema? (R468)
//
// Rolling the app back one release is a redeploy of the older image, onto a
// database the newer release's migrations have already changed. That is safe
// only while every migration EXPANDS the schema: it adds tables, columns,
// functions and enum values, and removes or narrows nothing the older release
// reads, writes or calls. Taking something away (CONTRACTING) waits one
// release, until no release that can still be rolled back to uses it.
//
// This compares two snapshots of the public schema
// (deploy/ci/migrations/schema-snapshot.sql), one taken before an upgrade's
// migrations and one after, and names everything that breaks the older
// release:
//
//   - a table, view or column that is gone, or a table that became a view
//   - a column whose type changed, unless it only widened (integer to
//     bigint, real to numeric, varchar(50) to text ...)
//   - a column that became NOT NULL with no default, or a new NOT NULL column
//     with no default: the older release's inserts leave it out and fail
//   - a function that is gone, whose arguments changed, or that returns
//     something else
//   - an enum value that is gone
//
// A deliberate contraction says so in its migration, on its own line:
//
//   -- contract: public.old_table   (no release that can be rolled back to reads it)
//   -- contract: public.runs.legacy_status
//
// and is reported as allowed, not as a failure. Name the narrowest object.
//
// Usage: two lines of JSON on stdin (before, after), the new migration files
// as arguments (their contract lines are read):
//
//   { psql ... -f schema-snapshot.sql; psql ... -f schema-snapshot.sql; } \
//     | node deploy/ci/migrations/schema-compat.mjs supabase/migrations/2026....sql
//
// Exits 1 when anything breaks. deploy/ci/supabase-image/run.sh --upgrade-from
// runs it; tests/unit/schemaCompat.test.ts pins the rules.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const KIND = { r: "table", p: "table", v: "view", m: "materialized view", f: "foreign table" };
const WRITABLE = new Set(["r", "p", "f"]);

// A value of the old type always fits the new one, and PostgREST returns both
// as the same JSON type.
const WIDER = {
  smallint: ["integer", "bigint", "numeric", "real", "double precision"],
  integer: ["bigint", "numeric", "double precision"],
  bigint: ["numeric"],
  real: ["double precision", "numeric"],
  "double precision": ["numeric"],
  character: ["character varying", "text"],
  "character varying": ["text"],
};

function splitType(type) {
  const array = type.endsWith("[]");
  const t = array ? type.slice(0, -2) : type;
  const m = /^([a-z ]+?)\((\d+)(?:,(\d+))?\)$/.exec(t);
  if (!m) return { base: t, array, size: null, scale: null };
  return { base: m[1], array, size: Number(m[2]), scale: m[3] === undefined ? null : Number(m[3]) };
}

/** True when every value of `from` is a value of `to`. */
export function typeWidens(from, to) {
  if (from === to) return true;
  const a = splitType(from);
  const b = splitType(to);
  if (a.array !== b.array) return false;
  if (a.base === b.base) {
    if (b.size === null) return true; // varchar(50) -> varchar, numeric(10,2) -> numeric
    if (a.size === null) return false;
    if (a.base === "numeric") {
      // Room for as many digits before the point, and as many after it.
      return b.size - (b.scale ?? 0) >= a.size - (a.scale ?? 0) && (b.scale ?? 0) >= (a.scale ?? 0);
    }
    return b.size >= a.size;
  }
  if (!(WIDER[a.base] ?? []).includes(b.base)) return false;
  // A sized target (varchar(10), numeric(5,2)) can still be too small.
  return b.size === null;
}

const fnKey = (f) => `public.${f.name}(${f.args})`;

/**
 * Everything in `after` that the release which ran on `before` cannot use.
 * Each finding: { subject, problem }, where subject is public.<relation>,
 * public.<relation>.<column>, public.<function>(<args>) or public.<enum type>.
 */
export function compareSchemas(before, after) {
  const findings = [];
  const add = (subject, problem) => findings.push({ subject, problem });

  const relAfter = new Map(after.relations.map((r) => [r.name, r]));
  const goneRelations = new Set();
  for (const r of before.relations) {
    const now = relAfter.get(r.name);
    if (!now) {
      goneRelations.add(r.name);
      add(`public.${r.name}`, `${KIND[r.kind] ?? "relation"} removed`);
    } else if (WRITABLE.has(r.kind) && !WRITABLE.has(now.kind)) {
      add(`public.${r.name}`, `was a ${KIND[r.kind]}, now a ${KIND[now.kind]}: writes to it fail`);
    }
  }

  const colKey = (c) => `${c.relation}.${c.name}`;
  const colAfter = new Map(after.columns.map((c) => [colKey(c), c]));
  const colBefore = new Set(before.columns.map(colKey));
  const relBefore = new Map(before.relations.map((r) => [r.name, r]));
  for (const c of before.columns) {
    if (goneRelations.has(c.relation)) continue;
    const now = colAfter.get(colKey(c));
    const subject = `public.${c.relation}.${c.name}`;
    if (!now) {
      add(subject, "column removed");
      continue;
    }
    if (!typeWidens(c.type, now.type)) add(subject, `type ${c.type} became ${now.type}`);
    const writable = WRITABLE.has(relBefore.get(c.relation)?.kind ?? "r");
    if (writable && !c.notNull && now.notNull && !now.hasDefault) {
      add(
        subject,
        "became NOT NULL with no default: the older release's inserts that leave it out fail",
      );
    }
  }
  for (const c of after.columns) {
    if (colBefore.has(colKey(c))) continue;
    const rel = relBefore.get(c.relation);
    if (!rel || !WRITABLE.has(rel.kind)) continue; // a new table, or a view
    if (c.notNull && !c.hasDefault) {
      add(
        `public.${c.relation}.${c.name}`,
        "new column is NOT NULL with no default: the older release does not write it, so its inserts fail",
      );
    }
  }

  const fnAfter = new Map(after.functions.map((f) => [fnKey(f), f]));
  for (const f of before.functions) {
    const now = fnAfter.get(fnKey(f));
    if (!now) add(fnKey(f), "function removed, or its arguments changed");
    else if (now.returns !== f.returns) add(fnKey(f), `returned ${f.returns}, now ${now.returns}`);
  }

  const enumAfter = new Set(after.enums.map((e) => `${e.type}:${e.label}`));
  for (const e of before.enums) {
    if (!enumAfter.has(`${e.type}:${e.label}`))
      add(`public.${e.type}`, `enum value '${e.label}' removed`);
  }
  return findings;
}

/** The objects a migration says it contracts (`-- contract: public.x[.y]`). */
export function contractsIn(sql) {
  const out = [];
  for (const m of sql.matchAll(/^[ \t]*--[ \t]*contract:[ \t]*(public\.[A-Za-z0-9_.]+)/gim)) {
    out.push(m[1].replace(/\.+$/, ""));
  }
  return out;
}

/** True when a contract line covers the finding's subject. */
export function contractCovers(token, subject) {
  return subject === token || subject.startsWith(`${token}.`) || subject.startsWith(`${token}(`);
}

/** Splits findings into breaks and those a contract line allows. */
export function judge(findings, contracts) {
  const breaks = [];
  const allowed = [];
  for (const f of findings) {
    const by = contracts.find((c) => contractCovers(c.token, f.subject));
    if (by) allowed.push({ ...f, file: by.file });
    else breaks.push(f);
  }
  return { breaks, allowed };
}

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Statements that always contract the schema: DROP TABLE, DROP COLUMN and any
 * RENAME. A migration that has one must say what it contracts. (Type changes,
 * NOT NULL and function signatures depend on the before and after, so the
 * upgrade check measures those on a real database instead.)
 */
export function contractingStatements(sql) {
  const text = stripComments(sql);
  const found = [];
  const patterns = [
    [/\bdrop\s+table\b/gi, "DROP TABLE"],
    [/\bdrop\s+column\b/gi, "DROP COLUMN"],
    [/\brename\s+(?:column\s+)?[A-Za-z0-9_."]+\s+to\b/gi, "RENAME ... TO"],
    [/\brename\s+to\b/gi, "RENAME TO"],
  ];
  for (const [re, label] of patterns) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      found.push({ statement: label, line });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function main() {
  const lines = readFileSync(0, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 2) {
    console.error(`expected two snapshots on stdin, got ${lines.length} non-empty lines`);
    process.exit(2);
  }
  const [before, after] = lines.map((l) => JSON.parse(l));
  const contracts = process.argv
    .slice(2)
    .flatMap((file) => contractsIn(readFileSync(file, "utf8")).map((token) => ({ token, file })));
  const { breaks, allowed } = judge(compareSchemas(before, after), contracts);
  const count = (s) =>
    `${s.relations.length} relations, ${s.columns.length} columns, ${s.functions.length} functions, ${s.enums.length} enum values`;
  console.log(`  before: ${count(before)}`);
  console.log(`  after:  ${count(after)}`);
  for (const a of allowed) console.log(`  allowed by ${a.file}: ${a.subject}: ${a.problem}`);
  if (breaks.length === 0) {
    console.log(
      "  the previous release can run on the new schema: nothing it uses was removed or narrowed",
    );
    return;
  }
  for (const b of breaks) console.log(`  BREAKS THE PREVIOUS RELEASE: ${b.subject}: ${b.problem}`);
  console.log(
    `  ${breaks.length} change(s) the previous release cannot run on. Expand now and contract one release later, ` +
      "or mark a deliberate contraction with a `-- contract: public.<object>` line in its migration.",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
