-- Named ranges for Sheets workbooks (Excel's defined names), and in each
-- version, so a restore brings back the names the sheets used (R148).
--
-- names: [{ "name": "Revenue", "ref": "Data!$B$2:$B$13", "comment": "…" }]
-- A version taken before names existed has none (null), and restoring it
-- leaves the workbook's names as they are.

alter table public.sheet_workbooks
  add column if not exists names jsonb not null default '[]'::jsonb;

alter table public.sheet_workbook_versions
  add column if not exists names jsonb;
