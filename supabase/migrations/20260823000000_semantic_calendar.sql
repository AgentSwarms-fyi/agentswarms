-- Fiscal calendar tables for semantic models (4-4-5 / 13-period / ISO-week
-- calendars that month arithmetic cannot express). The column stores the
-- declaration only — { table, dateColumn, grains: { <grain>: { seq, start } } };
-- the calendar DATA itself lives in the model's own backend, next to the
-- facts it describes. Mutually exclusive with fiscal_year_start_month,
-- enforced in the app's save path (two sources of truth for the same fiscal
-- year would disagree quietly).
alter table public.semantic_models
  add column if not exists calendar jsonb;
