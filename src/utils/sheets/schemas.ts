// The shapes the Sheets server functions accept, shared with the editor.
import { z } from "zod";

export const tokenOnly = z.object({ access_token: z.string().min(1) });

export const nameStr = z.string().min(1).max(255);

export const filterSchema = z
  .object({
    column: nameStr,
    op: z.enum([
      "eq",
      "ne",
      "gt",
      "ge",
      "lt",
      "le",
      "contains",
      "not_contains",
      "starts",
      "ends",
      "blank",
      "not_blank",
      "in",
    ]),
    value: z.string().max(1000).optional(),
    values: z.array(z.string().max(1000)).max(10_000).optional(),
    blanks: z.boolean().optional(),
  })
  .strict();

export const originSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lakehouse") }).strict(),
  z
    .object({ kind: z.literal("catalog"), asset_id: z.string().max(200), fqn: z.string().max(512) })
    .strict(),
  z
    .object({
      kind: z.literal("warehouse"),
      connection_id: z.string().uuid(),
      connection_name: z.string().max(200),
      query: z.string().max(20_000),
    })
    .strict(),
  z.object({ kind: z.literal("upload"), filename: z.string().max(255) }).strict(),
]);

export const tableConfigSchema = z
  .object({
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("lakehouse"), schema: nameStr, table: nameStr }).strict(),
      z
        .object({
          kind: z.literal("pivot"),
          from: nameStr,
          rows: z.array(nameStr).max(10),
          values: z
            .array(
              z
                .object({
                  column: nameStr,
                  agg: z.enum(["sum", "avg", "count", "count_distinct", "min", "max"]),
                })
                .strict(),
            )
            .min(1)
            .max(20),
        })
        .strict(),
    ]),
    columns: z.array(z.object({ name: nameStr, type: z.string().max(200) }).strict()).max(2000),
    calculated: z
      .array(
        z
          .object({ name: z.string().trim().min(1).max(128), formula: z.string().max(8000) })
          .strict(),
      )
      .max(100),
    sort: z.array(z.object({ column: nameStr, desc: z.boolean() }).strict()).max(10),
    filters: z.array(filterSchema).max(50),
    hidden: z.array(nameStr).max(2000),
    widths: z.record(z.string().max(255), z.number().min(16).max(2000)),
    origin: originSchema.optional(),
  })
  .strict();
