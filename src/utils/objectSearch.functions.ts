// Search's server side: the names a person may find, and nothing else.
//
// Three calls, so a slow source never holds up a fast one:
//   objectIndex            every kind kept in the database, read with the
//                          caller's own token (row-level security decides);
//   objectIndexLakehouse   lakehouse tables, which live in the lake's catalog
//                          and are listed through the schemas the caller may
//                          read;
//   objectSearchMore       an older name in a kind too large for the index;
//   objectsByIds           the names of marked objects (favourites, recently
//                          opened) that are older than the index holds.
//
// The palette opens on what the first call returns and adds the second when it
// arrives.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isObjectKindId, type ObjectEntry, type ObjectKindId } from "@/lib/objectKinds";
import { listLakehouseTablesForUser } from "@/utils/lakehouse/tables.server";
import { indexExtrasFor, SEALED_NAMES } from "@/utils/objectSearch/extras.server";
import {
  BY_ID_CAP,
  loadObjectIndex,
  readObjectsByIds,
  searchCappedKinds,
  type IndexResult,
} from "@/utils/objectSearch/sources.server";

type Fail = { ok: false; error: string };

export const objectIndex = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Fail | ({ ok: true } & IndexResult)> => {
    try {
      const index = await loadObjectIndex(
        context.supabase,
        context.userId,
        indexExtrasFor(context.supabase, context.userId),
      );
      return { ok: true, ...index };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Search could not load" };
    }
  });

export const objectIndexLakehouse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Fail | { ok: true; entries: ObjectEntry[] }> => {
    try {
      const { tables, schemas } = await listLakehouseTablesForUser(context.userId);
      // A schema the caller can write is theirs; any other was shared or mounted.
      const own = new Set(schemas.filter((s) => s.writable).map((s) => s.name));
      return {
        ok: true,
        entries: tables.map((t) => ({
          kind: "lakehouse_table" as const,
          // A lakehouse table has no id of its own: its name in its schema is
          // its identity, and what the lakehouse page opens by.
          id: `${t.schema}.${t.table}`,
          name: t.table,
          detail: `${t.schema} · ${t.columns.length} column${t.columns.length === 1 ? "" : "s"}`,
          updatedAt: null,
          mine: own.has(t.schema),
        })),
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "The lakehouse could not be read",
      };
    }
  });

export const objectSearchMore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        q: z.string().trim().min(2).max(200),
        kinds: z.array(z.string()).max(40),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<{ ok: true; entries: ObjectEntry[] }> => {
    const kinds = data.kinds.filter(isObjectKindId) as ObjectKindId[];
    const entries = await searchCappedKinds(
      context.supabase,
      context.userId,
      data.q,
      kinds,
      Object.keys(SEALED_NAMES) as ObjectKindId[],
    );
    return { ok: true, entries };
  });

export const objectsByIds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        ids: z.record(z.string().max(40), z.array(z.string().min(1).max(400)).max(BY_ID_CAP)),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<{ ok: true; entries: ObjectEntry[] }> => {
    const wanted: Partial<Record<ObjectKindId, string[]>> = {};
    for (const [kind, ids] of Object.entries(data.ids)) {
      if (isObjectKindId(kind)) wanted[kind] = ids;
    }
    const entries = await readObjectsByIds(context.supabase, context.userId, wanted, SEALED_NAMES);
    return { ok: true, entries };
  });
