-- Semantic models: fiscal calendar, query parameters, drill hierarchies.
--
-- fiscal_year_start_month: 1-12, NULL = calendar (January). With it set,
-- the fiscal_year / fiscal_quarter grains and the fiscal relative-date
-- windows (fiscal_ytd, this/last_fiscal_year, this/last_fiscal_quarter)
-- roll along the business's year instead of the calendar's. Convention:
-- a fiscal year is NAMED BY THE CALENDAR YEAR IT ENDS IN (a July-start FY
-- covering Jul 2025 – Jun 2026 is FY2026) — the US-federal and most common
-- corporate reading, and documented rather than assumed.
--
-- parameters: [{name, type: number|string, default, label?, description?}].
-- Authored SQL fragments may reference them as {{name}}; the compiler
-- substitutes a literal-escaped value (query-supplied or default) and
-- REFUSES undeclared or missing-with-no-default parameters. What-if
-- thresholds without a second copy of the metric.
--
-- hierarchies: [{name, levels: [dimension names]}] — declared drill paths
-- (region → subregion → city). Validated against the model's dimensions and
-- surfaced in the agent catalog, so "drill into EMEA" has a governed answer.
ALTER TABLE public.semantic_models
  ADD COLUMN IF NOT EXISTS fiscal_year_start_month int
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS parameters jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS hierarchies jsonb NOT NULL DEFAULT '[]'::jsonb;
