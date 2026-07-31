// Guards on the migration directory itself.
//
// `supabase db push` tracks applied migrations by their VERSION — the numeric
// filename prefix. Two files sharing a prefix is not an error: the second is
// silently treated as already applied and SKIPPED. The symptom arrives much
// later and somewhere else, as "table not found in schema cache" against a
// table whose migration looks present in the repository.
//
// That has happened here. It costs an afternoon to diagnose and one assertion
// to prevent, and it is exactly the kind of thing a person cannot reliably
// check by eye across 130+ files.

import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve("supabase/migrations");

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/**
 * Supabase's own convention: <14-digit timestamp>_<name>.sql
 *
 * The name half is permissive on purpose. The oldest migrations here are
 * UUID-named from the original scaffolding, and hyphens are legal; renaming
 * applied migrations to satisfy a house style would churn history for no gain.
 * What must hold is that a 14-digit VERSION can be parsed, because that is the
 * part `db push` keys on.
 */
const NAME_RE = /^(\d{14})_([A-Za-z0-9_-]+)\.sql$/;

describe("supabase/migrations", () => {
  it("has migrations to check", () => {
    // A silently empty glob would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(50);
  });

  it("every filename follows <timestamp>_<name>.sql", () => {
    const bad = files.filter((f) => !NAME_RE.test(f));
    expect(bad, "the CLI ignores files it cannot parse a version from").toEqual([]);
  });

  it("no two migrations share a version prefix", () => {
    // The failure this file exists for. A duplicate is skipped, not rejected.
    const byVersion = new Map<string, string[]>();
    for (const f of files) {
      const version = NAME_RE.exec(f)?.[1];
      if (!version) continue;
      const list = byVersion.get(version);
      if (list) list.push(f);
      else byVersion.set(version, [f]);
    }
    const collisions = [...byVersion.entries()].filter(([, fs]) => fs.length > 1);
    expect(
      collisions.map(([v, fs]) => `${v}: ${fs.join(", ")}`),
      "a colliding version is treated as already applied and SKIPPED",
    ).toEqual([]);
  });

  it("versions sort in the same order as the filenames", () => {
    // db push applies in version order. If lexical filename order and numeric
    // version order disagree, the file you read top-to-bottom is not the order
    // the database sees.
    const versions = files.map((f) => NAME_RE.exec(f)?.[1] ?? "");
    const sorted = [...versions].sort();
    expect(versions).toEqual(sorted);
  });

  it("every version is exactly 14 digits, so they compare as strings", () => {
    // db push orders by the version STRING. A prefix of a different length
    // sorts somewhere unrelated and can run before the table it alters exists.
    //
    // Note these are NOT all real dates. The newer half of this directory uses
    // a synthetic counter formatted to look like a timestamp — 20260732…, day
    // "32"; 20260771…, day "71" — because versions only need to be unique and
    // increasing. That is workable but it is why a collision is easy to create
    // by hand and impossible to spot by eye, which is what the duplicate test
    // above is for. A new migration must take the next number, never today's
    // date, or it sorts BEFORE the existing ones and is skipped as already
    // applied.
    for (const f of files) {
      expect(NAME_RE.exec(f)![1], f).toHaveLength(14);
    }
  });

  it("the newest migration is the highest version", () => {
    // The mistake this catches: adding a migration stamped with the real
    // current date into a directory whose counter has run ahead of it. The new
    // file sorts into the middle, db push considers it already applied, and
    // the change silently never reaches the database.
    const versions = files.map((f) => NAME_RE.exec(f)![1]);
    const highest = [...versions].sort().at(-1);
    expect(versions.at(-1)).toBe(highest);
  });
});
