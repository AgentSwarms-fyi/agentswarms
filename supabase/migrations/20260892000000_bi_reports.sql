-- Paginated reports: the print-layout half of BI.
--
-- A dashboard is a grid you scroll: it has no pages, and exporting one is a
-- screenshot of that grid at whatever size it happened to be. A paginated
-- report is the other shape — a fixed page, a flow of blocks down it, a
-- running header and footer, and a table that CONTINUES onto the next page
-- with its header row drawn again. That last part is the whole difference,
-- and it is what an invoice, a month-end pack or a regulatory return needs.
--
-- The content is deliberately the dashboard's own. A chart block holds a
-- `BiWidget` exactly as `bi_dashboards.widgets` does, so the same query, the
-- same cached rows, the same ChartSpec and the same renderer serve both, and
-- a widget lifted off a dashboard keeps working. Only the layout is new.

CREATE TABLE IF NOT EXISTS public.bi_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text,
  -- { size: 'a4'|'letter'|'legal'|'a3', orientation, margin }
  page jsonb NOT NULL DEFAULT '{"size":"a4","orientation":"portrait","margin":40}'::jsonb,
  -- Running bands, three slots each, holding {{page}} / {{pages}} / {{title}}
  -- / {{date}} / {{time}} tokens. {{pages}} is why the footer is stamped in a
  -- second pass at render: the total is not known until the last block lands.
  header jsonb NOT NULL DEFAULT '{}'::jsonb,
  footer jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The ordered flow. Blocks are heading / text / spacer / pagebreak / chart /
  -- table; chart and table each carry a BiWidget.
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bi_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own reports"
  ON public.bi_reports FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Owner-only, deliberately, for now. A dashboard is shareable because
-- `iam_resource_grants.resource_type` admits 'bi_dashboard'; adding a
-- 'bi_report' grant type is a separate change with a UI behind it, and a
-- policy that reads a grant nobody can create would be dead code pretending
-- to be a feature.

CREATE INDEX IF NOT EXISTS bi_reports_user_idx ON public.bi_reports (user_id, updated_at DESC);

-- The layout is configuration a colleague can be handed; its blocks carry
-- cached rows, which are data. Audit the shape, not every refresh.
DROP TRIGGER IF EXISTS audit_bi_reports ON public.bi_reports;
CREATE TRIGGER audit_bi_reports
  AFTER INSERT OR DELETE OR UPDATE OF name, page, header, footer
  ON public.bi_reports
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('bi_report');
