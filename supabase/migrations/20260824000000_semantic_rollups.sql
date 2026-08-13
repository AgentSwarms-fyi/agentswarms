-- Aggregate awareness: declared pre-aggregated rollup tables on semantic
-- models. The column stores declarations only — [{ table, label?,
-- dimensions: [{ dimension, column, grain? }], metrics: [{ metric, column }] }];
-- the rollup DATA lives in the model's own backend next to the fact it
-- summarises. Routing is compile-time and provable; Validate measures each
-- rollup's totals against the fact table so a stale rollup is a reported
-- drift, not a quietly different dashboard.
alter table public.semantic_models
  add column if not exists rollups jsonb;
