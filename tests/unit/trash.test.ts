// Trash with restore (R516). What the database does is proven against a real
// Postgres by the migration's own harness; these hold what the app says and
// the rules that keep the two in step.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { isObjectKindId, OBJECT_KINDS } from "@/lib/objectKinds";
import {
  daysLeft,
  isTrashable,
  purgeLabel,
  RESTORE_HINT,
  TRASH_RETENTION_DAYS,
  TRASHABLE_KINDS,
  trashEntryFromRow,
  trashErrorText,
  trashMissing,
} from "@/lib/trash";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const migration = (() => {
  const dir = path.join(REPO, "supabase/migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_trash.sql"));
  return file ? readFileSync(path.join(dir, file), "utf8") : "";
})();

describe("what can go in the trash", () => {
  // The kinds the database lists in trash_kinds(), in its own words.
  const listed = [
    ...migration.matchAll(/\('([a-z_]+)', 'public\.([a-z_]+)'::regclass, '([a-z_,]+)'\)/g),
  ];

  it("is the same list in the app and in the database", () => {
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.map((m) => m[1]).sort()).toEqual([...TRASHABLE_KINDS].sort());
  });

  it("is kinds the app has, each in the table search reads it from", () => {
    const sources = rd("src/utils/objectSearch/sources.server.ts");
    for (const [, kind, table, nameCol] of listed) {
      expect(isObjectKindId(kind), kind).toBe(true);
      if (kind === "semantic_model") {
        // Search names a semantic model by its label, else its name; so does the trash.
        expect(nameCol).toBe("label,name");
        expect(sources).toContain("name: label ?? name,");
        continue;
      }
      // Search reads this kind from the same table and the same name column,
      // so what the trash lists is named as search names it.
      expect(flat(sources), kind).toContain(
        `kind: "${kind}", table: "${table}", name: "${nameCol}"`,
      );
    }
  });

  it("leaves out what a copy of its rows cannot bring back", () => {
    // Each of these also removes something outside the database when deleted.
    for (const kind of [
      "dataset",
      "knowledge_base",
      "ml_model",
      "mcp_app",
      "mcp_server",
      "etl_pipeline",
      "lakehouse_table",
    ]) {
      expect(isTrashable(kind), kind).toBe(false);
      expect(migration, kind).not.toContain(`('${kind}',`);
    }
    // And says why, where the list is kept.
    for (const why of ["vectors", "Parquet", "replication slots", "trigger"]) {
      expect(migration).toContain(why);
    }
  });

  it("knows every other kind, one way or the other", () => {
    const decided = new Set<string>([
      ...TRASHABLE_KINDS,
      "dataset",
      "knowledge_base",
      "ml_model",
      "mcp_app",
      "mcp_server",
      "etl_pipeline",
      "lakehouse_table",
      // No delete of their own: an ontology has no delete in the app, an
      // analysis goes with its analyst, a metric lives inside its model.
      "ontology",
      "analysis",
      "metric",
    ]);
    // A kind added to the registry has to be put on one side or the other.
    for (const k of OBJECT_KINDS) expect(decided.has(k.id), k.id).toBe(true);
  });
});

describe("the database side, read from the migration", () => {
  const sql = flat(migration);

  it("keeps the copy unreadable, and lists names only", () => {
    expect(sql).toContain("ALTER TABLE public.trash_items ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("REVOKE ALL ON public.trash_items FROM anon, authenticated;");
    expect(sql).not.toMatch(/CREATE POLICY [^;]* ON public\.trash_items/);
    const list = sql.slice(
      sql.indexOf("FUNCTION public.my_trash()"),
      sql.indexOf("FUNCTION public.empty_trash"),
    );
    expect(list).toContain("WHERE t.user_id = auth.uid()");
    expect(list).not.toContain("payload");
  });

  it("checks the owner by hand in every function that bypasses row security", () => {
    for (const fn of ["trash_object", "restore_trash", "empty_trash"]) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}(`));
      const end = body.indexOf("$$; ", body.indexOf("AS $$") + 5);
      const def = body.slice(0, end);
      expect(def, fn).toContain("SECURITY DEFINER");
      expect(def, fn).toContain("SET search_path = ''");
      expect(def, fn).toContain("v_uid uuid := auth.uid();");
      expect(def, fn).toMatch(/IF v_uid IS NULL THEN/);
    }
    // Not there and not yours answer alike: a difference would confirm an id exists.
    expect(sql).toContain(
      "IF v_row IS NULL OR NULLIF(v_row ->> 'user_id', '')::uuid IS DISTINCT FROM v_uid THEN",
    );
    expect(sql).not.toContain("Only its owner");
    expect(sql).toContain("IF v_item.id IS NULL OR v_item.user_id IS DISTINCT FROM v_uid THEN");
  });

  it("finds what to copy from the foreign keys, and refuses one it cannot follow", () => {
    expect(sql).toContain("c.contype = 'f' AND c.confdeltype = 'c'");
    expect(sql).toContain("IF v_fk.width <> 1 OR v_fk.child_schema <> 'public' THEN");
    expect(sql).toContain("This is too large for the trash");
  });

  it("lets only the server purge, and keeps thirty days", () => {
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.purge_expired_trash() FROM public, anon, authenticated;",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.purge_expired_trash() TO service_role;",
    );
    expect(sql).toContain(`interval '${TRASH_RETENTION_DAYS} days'`);
  });

  it("writes only the columns the copy has, so a column added since takes its default", () => {
    expect(sql).toContain("AND (v_rows -> 0) ? a.attname;");
  });
});

describe("what the app says", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");

  it("counts whole days left, rounding up, never below zero", () => {
    expect(daysLeft("2026-12-21T12:00:00Z", now)).toBe(30);
    expect(daysLeft("2026-11-22T00:00:00Z", now)).toBe(1);
    expect(daysLeft("2026-11-23T00:00:01Z", now)).toBe(2);
    expect(daysLeft("2026-11-20T12:00:00Z", now)).toBe(0);
    expect(daysLeft("soon", now)).toBe(0);
    expect(purgeLabel("2026-12-21T12:00:00Z", now)).toBe("Deleted for good in 30 days");
    expect(purgeLabel("2026-11-22T00:00:00Z", now)).toBe("Deleted for good tomorrow");
    expect(purgeLabel("2026-11-21T11:00:00Z", now)).toBe("Deleted for good today");
  });

  it("reads a row of the trash, and refuses one it cannot name", () => {
    const row = {
      id: "t1",
      kind: "dashboard",
      object_id: "d1",
      name: "Sales",
      deleted_at: "2026-11-21T10:00:00Z",
      purge_after: "2026-12-21T10:00:00Z",
      row_count: 6,
    };
    expect(trashEntryFromRow(row, isObjectKindId)).toEqual({
      id: "t1",
      kind: "dashboard",
      objectId: "d1",
      name: "Sales",
      deletedAt: "2026-11-21T10:00:00Z",
      purgeAfter: "2026-12-21T10:00:00Z",
      rowCount: 6,
    });
    expect(trashEntryFromRow({ ...row, kind: "spaceship" }, isObjectKindId)).toBeNull();
    expect(trashEntryFromRow({ ...row, id: "" }, isObjectKindId)).toBeNull();
    expect(trashEntryFromRow(null, isObjectKindId)).toBeNull();
  });

  it("passes on the database's own words, and words anything else", () => {
    expect(
      trashErrorText(
        { code: "P0002", message: "It is not here any more, or it is not yours to delete." },
        "move",
      ),
    ).toBe("It is not here any more, or it is not yours to delete.");
    expect(
      trashErrorText(
        {
          code: "23505",
          message:
            "Something else has taken its place: x. Rename or remove that one, then restore again.",
        },
        "restore",
      ),
    ).toMatch(/^Something else has taken its place/);
    expect(trashErrorText({ code: "08006", message: "connection lost" }, "move")).toBe(
      "It could not be moved to the trash: connection lost",
    );
    expect(trashErrorText(null, "restore")).toBe("It could not be restored.");
  });

  it("tells a database without the trash from a failure", () => {
    expect(trashMissing({ code: "PGRST202", message: "" })).toBe(true);
    expect(
      trashMissing({
        message:
          "Could not find the function public.trash_object(p_id, p_kind) in the schema cache",
      }),
    ).toBe(true);
    expect(
      trashMissing({ code: "42501", message: "Only its owner can move it to the trash." }),
    ).toBe(false);
    expect(trashErrorText({ code: "PGRST202" }, "move")).toMatch(/Apply the latest migrations/);
  });

  it("ends a delete confirmation with how to get it back", () => {
    expect(RESTORE_HINT).toBe("You can restore it from Trash for 30 days.");
  });
});

describe("the Trash page", () => {
  const page = flat(rd("src/routes/_authenticated/trash.tsx"));

  it("asks before deleting for good, one thing or all of them", () => {
    expect(page).toContain('actionLabel: "Delete for good"');
    expect(page).toContain('actionLabel: "Empty trash"');
    expect(page.match(/await confirmAsk\(/g)).toHaveLength(2);
  });

  it("keeps a row where it was once restored or deleted", () => {
    // A vanished row pulled the next one up under the pointer.
    expect(page).toContain('setDone((d) => ({ ...d, [e.id]: { what: "restored" } }));');
    expect(page).toContain('setDone((d) => ({ ...d, [e.id]: { what: "deleted" } }));');
    expect(page).not.toMatch(/entries\.filter\(\(x\) => x\.id !== e\.id\)/);
  });

  it("is in the menu, under Overview", () => {
    expect(rd("src/lib/appNav.ts")).toContain('{ title: "Trash", url: "/trash", icon: Trash2 }');
  });

  it("is purged by the scheduled pass, and checked for by the schema guard", () => {
    expect(rd("src/utils/bi/refresh.server.ts")).toContain('"trash-purge"');
    expect(rd("src/lib/schemaHealthCheck.ts")).toContain('table: "trash_items"');
  });
});
