// The shapes the Sheets server functions accept, shared with the editor.
import { z } from "zod";
import { normalizeLink } from "@/lib/sheets/style";

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

// ── Grid sheets ────────────────────────────────────────────────────────────

const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "A color is #RRGGBB");
const borderSide = z
  .object({
    s: z.enum(["thin", "medium", "thick", "dashed", "dotted", "double"]),
    c: color.optional(),
  })
  .strict();
const A1_RANGE = /^\$?[A-Z]{1,3}\$?\d{1,7}(:\$?[A-Z]{1,3}\$?\d{1,7})?$/;

export const styleSchema = z
  .object({
    b: z.boolean().optional(),
    i: z.boolean().optional(),
    u: z.boolean().optional(),
    st: z.boolean().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    va: z.enum(["top", "middle", "bottom"]).optional(),
    wrap: z.boolean().optional(),
    ind: z.number().int().min(0).max(15).optional(),
    // A font name is drawn into CSS: no quotes, backslashes or angle brackets.
    font: z
      .string()
      .max(64)
      .regex(/^[^"'\\<>;{}]+$/)
      .optional(),
    sz: z.number().min(1).max(409).optional(),
    color: color.optional(),
    bg: color.optional(),
    bd: z
      .object({
        t: borderSide.optional(),
        r: borderSide.optional(),
        b: borderSide.optional(),
        l: borderSide.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Conditional formatting, data validation and the filter: colors are drawn
// into CSS, so they are #RRGGBB only; icons come from a fixed set; formulas
// and operands are text the engine parses (never run as script).
const ranges = z.array(z.string().regex(A1_RANGE)).min(1).max(100);
const operand = z.string().max(8192);
const cfStyle = z
  .object({
    color: color.optional(),
    bg: color.optional(),
    b: z.boolean().optional(),
    i: z.boolean().optional(),
    u: z.boolean().optional(),
    st: z.boolean().optional(),
  })
  .strict();
const scaleStop = z
  .object({
    type: z.enum(["min", "max", "num", "percent", "percentile"]),
    value: z.number().finite().optional(),
    color,
  })
  .strict();
const cmpOp = z.enum(["gt", "ge", "lt", "le", "eq", "ne", "between", "notBetween"]);
const cfRule = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cell"),
      op: cmpOp,
      a: operand,
      b: operand.optional(),
      style: cfStyle,
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      op: z.enum(["contains", "notContains", "begins", "ends"]),
      text: z.string().max(255),
      style: cfStyle,
    })
    .strict(),
  z.object({ kind: z.literal("blank"), style: cfStyle }).strict(),
  z.object({ kind: z.literal("notBlank"), style: cfStyle }).strict(),
  z.object({ kind: z.literal("errors"), style: cfStyle }).strict(),
  z.object({ kind: z.literal("noErrors"), style: cfStyle }).strict(),
  z
    .object({
      kind: z.literal("date"),
      period: z.enum([
        "yesterday",
        "today",
        "tomorrow",
        "last7",
        "lastWeek",
        "thisWeek",
        "nextWeek",
        "lastMonth",
        "thisMonth",
        "nextMonth",
      ]),
      style: cfStyle,
    })
    .strict(),
  z
    .object({
      kind: z.literal("top"),
      n: z.number().int().min(1).max(1000),
      percent: z.boolean().optional(),
      bottom: z.boolean().optional(),
      style: cfStyle,
    })
    .strict(),
  z
    .object({
      kind: z.literal("average"),
      below: z.boolean().optional(),
      equal: z.boolean().optional(),
      style: cfStyle,
    })
    .strict(),
  z.object({ kind: z.literal("duplicate"), style: cfStyle }).strict(),
  z.object({ kind: z.literal("unique"), style: cfStyle }).strict(),
  z.object({ kind: z.literal("formula"), formula: operand, style: cfStyle }).strict(),
  z
    .object({
      kind: z.literal("scale"),
      min: scaleStop,
      mid: scaleStop.optional(),
      max: scaleStop,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bar"),
      color,
      min: scaleStop.optional(),
      max: scaleStop.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("icons"),
      set: z.enum(["3arrows", "3traffic", "3symbols", "3flags", "4arrows", "5arrows", "3stars"]),
      reverse: z.boolean().optional(),
    })
    .strict(),
]);
const condSchema = z
  .object({
    id: z.string().min(1).max(64),
    ranges,
    rule: cfRule,
    stop: z.boolean().optional(),
  })
  .strict();
const dvRule = z.union([
  z
    .object({
      kind: z.literal("list"),
      items: z.array(z.string().max(255)).max(1000).optional(),
      source: operand.optional(),
      dropdown: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["whole", "decimal", "date", "time", "length"]),
      op: cmpOp,
      a: operand,
      b: operand.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("custom"), formula: operand }).strict(),
]);
const validationSchema = z
  .object({
    id: z.string().min(1).max(64),
    ranges,
    rule: dvRule,
    allowBlank: z.boolean().optional(),
    prompt: z
      .object({ title: z.string().max(255).optional(), message: z.string().max(1024) })
      .strict()
      .optional(),
    error: z
      .object({
        style: z.enum(["stop", "warning", "info"]),
        title: z.string().max(255).optional(),
        message: z.string().max(1024).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const filterSchemaGrid = z
  .object({
    range: z.string().regex(A1_RANGE),
    cols: z.record(
      z.string().regex(/^\d{1,5}$/),
      z
        .object({
          values: z.array(z.string().max(32767)).max(100_000).optional(),
          cond: z
            .object({
              op: z.enum([
                "eq",
                "ne",
                "gt",
                "ge",
                "lt",
                "le",
                "between",
                "contains",
                "notContains",
                "begins",
                "ends",
                "blank",
                "notBlank",
                "top",
                "bottom",
                "aboveAverage",
                "belowAverage",
              ]),
              a: z.string().max(255).optional(),
              b: z.string().max(255).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    hidden: z.array(z.number().int().min(0).max(1_048_575)).max(1_048_576).optional(),
  })
  .strict();

export const gridSchema = z
  .object({
    // Excel's own ceiling on what one cell holds: 32,767 characters.
    cells: z.record(
      z.string().regex(/^\d{1,7},\d{1,5}$/),
      z
        .object({
          i: z.string().max(32767),
          f: z.string().max(255).optional(),
          s: styleSchema.optional(),
          // Stored only when it is a link the editor would open (the same check).
          l: z
            .string()
            .max(2048)
            .refine((u) => normalizeLink(u) === u, "Only web, email and in-workbook links")
            .optional(),
          // Excel's saved value for a formula this engine cannot compute.
          c: z.union([z.string().max(32767), z.number(), z.boolean()]).optional(),
        })
        .strict(),
    ),
    colWidths: z.record(z.string().regex(/^\d{1,5}$/), z.number().min(0).max(2000)).optional(),
    rowHeights: z.record(z.string().regex(/^\d{1,7}$/), z.number().min(0).max(800)).optional(),
    frozenRows: z.number().int().min(0).max(100).optional(),
    frozenCols: z.number().int().min(0).max(50).optional(),
    merges: z.array(z.string().regex(A1_RANGE)).max(20_000).optional(),
    hiddenRows: z.array(z.number().int().min(0).max(1_048_575)).max(1_048_576).optional(),
    hiddenCols: z.array(z.number().int().min(0).max(16_383)).max(16_384).optional(),
    hideGrid: z.boolean().optional(),
    cond: z.array(condSchema).max(1000).optional(),
    validations: z.array(validationSchema).max(1000).optional(),
    filter: filterSchemaGrid.optional(),
  })
  .strict();
