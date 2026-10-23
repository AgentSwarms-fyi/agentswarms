/**
 * The fields an ETL pipeline's save writes, as they are stored, for its
 * fingerprint (R287, sweep 9). Run state, the next run time, the trigger
 * token and the timestamps are left out: a run, a schedule tick or a rotated
 * token changes those without changing what the pipeline is.
 */
export function etlPipelineDefinition(p: Record<string, unknown>) {
  return {
    name: p.name ?? null,
    description: p.description ?? null,
    mode: p.mode ?? null,
    engine: p.engine ?? null,
    source_code: p.source_code ?? "",
    graph: p.graph ?? null,
    requirements: p.requirements ?? "",
    secret_refs: p.secret_refs ?? "",
    dest_catalog_source_id: p.dest_catalog_source_id ?? null,
    schedule: p.schedule ?? null,
    cron_expr: p.cron_expr ?? null,
    timezone: p.timezone ?? null,
    retry_count: p.retry_count ?? 0,
    alerts: p.alerts ?? null,
    allow_concurrent: p.allow_concurrent ?? false,
    poll_seconds: p.poll_seconds ?? null,
    default_params: p.default_params ?? null,
    run_after: p.run_after ?? null,
    chain_sql_models: p.chain_sql_models ?? null,
    chain_ml_schedules: p.chain_ml_schedules ?? [],
    is_active: p.is_active ?? null,
    timeout_minutes: p.timeout_minutes ?? null,
  };
}
