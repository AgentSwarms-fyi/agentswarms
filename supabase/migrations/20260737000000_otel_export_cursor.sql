-- Watermark cursors for the OTLP trace exporter.
--
-- The exporter (src/utils/observability/otelExport.server.ts) runs on the
-- scheduler pass and streams newly-finished swarm runs and LLM calls to an
-- OTLP/HTTP collector. It advances a per-stream keyset cursor (timestamp, id)
-- so each row is exported at-least-once and never scanned from the beginning
-- twice. One row per stream: 'execution_traces', 'swarm_runs'.
--
-- Service-role only: RLS is enabled with NO policies, so ordinary users can't
-- see or move the fleet-wide export position; the exporter uses supabaseAdmin.
create table if not exists public.otel_export_cursor (
  stream text primary key,
  -- Keyset position: the (ts, id) of the last row successfully exported.
  last_ts timestamptz not null default 'epoch'::timestamptz,
  last_id uuid not null default '00000000-0000-0000-0000-000000000000'::uuid,
  updated_at timestamptz not null default now()
);

alter table public.otel_export_cursor enable row level security;
-- Intentionally no policies: only the service role (which bypasses RLS) reads
-- or writes this table. Enabling RLS keeps it invisible to authenticated users.
