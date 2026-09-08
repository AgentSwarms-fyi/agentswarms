// Continuous pipelines.
//
// A stream source (Kafka, Kinesis, Pub/Sub), webhook ingest and change data
// capture were read in micro-batches on the scheduler's clock: one run per
// sweep, sixty seconds apart at best, each paying a sandbox start. A
// continuous pipeline is the same compiled program told to loop: one
// long-running sandbox drains the source, loads, reports its positions so
// the platform persists them, advances its own cursors, and goes again after
// a short poll. The sweep keeps exactly one run live per pipeline and starts
// a fresh one when the run rolls over or dies. Everything here is pure so a
// test can read the whole program.

export const CONTINUOUS_SCHEDULE = "continuous";
export const CONTINUOUS_DEFAULT_POLL_SECONDS = 5;

/**
 * How long one run may live before it ends cleanly and the sweep starts the
 * next: a bounded container lifetime, so memory and log growth reset and an
 * image upgrade reaches a pipeline that never stops. Env, then a default.
 */
export function continuousRolloverMinutes(): number {
  return Number(process.env.ETL_CONTINUOUS_ROLLOVER_MINUTES ?? "") || 720;
}

/** After a run fails outright, how long the sweep waits before starting another. */
export function continuousRestartBackoffMs(): number {
  return (Number(process.env.ETL_CONTINUOUS_RESTART_BACKOFF_SECONDS ?? "") || 300) * 1000;
}

const DRAINABLE = new Set(["kafka", "kinesis", "pubsub", "ingest"]);

/**
 * Why a pipeline cannot run continuously, or null when it can. The loop
 * wraps the compiled graph, so a code pipeline (which owns its entrypoint)
 * is out; and a source that re-reads everything on every tick would turn
 * "continuous" into a tight loop over the same rows.
 */
export function canRunContinuously(
  mode: string,
  graph: { nodes?: { kind?: string; config?: unknown }[] } | null | undefined,
): string | null {
  if (mode !== "visual") {
    return "A continuous pipeline is a visual one: the loop wraps the compiled graph, and a code pipeline owns its own entrypoint.";
  }
  const drains = (graph?.nodes ?? [])
    .filter((n) => n.kind === "source")
    .some((n) => {
      const c = (n.config ?? {}) as {
        type?: string;
        mode?: string;
        incremental?: { cursor_column?: string };
      };
      return (
        DRAINABLE.has(c.type ?? "") || c.mode === "cdc" || Boolean(c.incremental?.cursor_column)
      );
    });
  if (!drains) {
    return "A continuous pipeline needs a source it can drain again and again — a Kafka, Kinesis or Pub/Sub stream, webhook ingest, change data capture, or an incremental cursor. A plain batch source would re-read everything on every tick.";
  }
  return null;
}

/**
 * The loop, as Python appended to a compiled program whose per-tick body is
 * `_tick`. `cursorEnv` maps each incremental node to its env stem, so the
 * position a tick reports becomes the position the next tick starts from
 * without a round trip. Off (`ETL_CONTINUOUS` unset) the program runs once,
 * exactly as before.
 */
export function continuousWrapper(cursorEnv: Record<string, string>): string {
  const map =
    "{" +
    Object.entries(cursorEnv)
      .map(([node, stem]) => `${JSON.stringify(node)}: ${JSON.stringify(stem)}`)
      .join(", ") +
    "}";
  return [
    `_CURSOR_ENV = ${map}`,
    ``,
    `def _post_progress(progress):`,
    `    # Best effort, every tick: the platform persists the positions (so a`,
    `    # crash replays at most one tick) and shows the counters live.`,
    `    try:`,
    `        import httpx`,
    `        httpx.post(`,
    `            os.environ['AGENTSWARMS_ORIGIN'].rstrip('/') + '/api/notebook/runtime/result',`,
    `            json={'partial': True, 'progress': progress},`,
    `            headers={'Authorization': 'Bearer ' + os.environ.get('AGENTSWARMS_TOKEN', '')},`,
    `            timeout=30,`,
    `        )`,
    `        return True`,
    `    except Exception as e:`,
    `        print('[etl] progress not recorded: ' + str(e)[:200])`,
    `        return False`,
    ``,
    `def _run_continuous(inputs):`,
    `    import time as _time`,
    `    poll = max(1.0, float(os.environ.get('ETL_POLL_SECONDS') or ${CONTINUOUS_DEFAULT_POLL_SECONDS}))`,
    `    budget = max(60.0, float(os.environ.get('ETL_CONTINUOUS_MAX_SECONDS') or 43200))`,
    `    started = _time.monotonic()`,
    `    total = {'continuous': True, 'rows_loaded': 0, 'ticks': 0, 'targets': {}, 'watermarks': {},`,
    `             'started_at': _time.strftime('%Y-%m-%dT%H:%M:%SZ', _time.gmtime())}`,
    `    print('[etl] continuous: polling every ' + str(poll) + ' s, rolling over after ' + str(int(budget)) + ' s')`,
    `    while _time.monotonic() - started < budget:`,
    `        m = _tick(inputs) or {}`,
    `        rows = int(m.get('rows_loaded') or 0)`,
    `        total['ticks'] += 1`,
    `        total['rows_loaded'] += rows`,
    `        total['last_tick_rows'] = rows`,
    `        total['last_tick_at'] = _time.strftime('%Y-%m-%dT%H:%M:%SZ', _time.gmtime())`,
    `        for l in m.get('targets') or []:`,
    `            _t = total['targets']`,
    `            _t[l['target']] = _t.get(l['target'], 0) + int(l.get('rows') or 0)`,
    `        for k, v in (m.get('watermarks') or {}).items():`,
    `            if v is None:`,
    `                continue`,
    `            total['watermarks'][k] = v`,
    `            # The next tick starts where this one stopped: the source reads`,
    `            # its cursor from env, so env is where the new position goes.`,
    `            _stem = _CURSOR_ENV.get(k)`,
    `            if _stem:`,
    `                os.environ[_stem + '_CURSOR'] = str(v)`,
    `        for k in ('schemas', 'lineage_sources'):`,
    `            if k in m:`,
    `                total[k] = m[k]`,
    `        if 'quality' in m:`,
    `            # Gate outcomes are per tick; keeping every tick's would grow without bound.`,
    `            total['quality'] = list(m['quality'])`,
    `            try:`,
    `                del _quality[:]`,
    `            except NameError:`,
    `                pass`,
    `        _post_progress(total)`,
    `        if rows == 0:`,
    `            _time.sleep(poll)`,
    `    print('[etl] continuous: rolling over after ' + str(total['ticks']) + ' tick(s), ' + str(total['rows_loaded']) + ' row(s)')`,
    `    metrics = dict(total)`,
    `    metrics['targets'] = [{'target': k, 'fqn': k, 'rows': v, 'load_id': None} for k, v in total['targets'].items()]`,
    `    print('[etl] ' + json.dumps(metrics))`,
    `    return metrics`,
    ``,
    `def entrypoint(inputs=None):`,
    `    if os.environ.get('ETL_CONTINUOUS') != '1':`,
    `        return _tick(inputs)`,
    `    return _run_continuous(inputs)`,
  ].join("\n");
}
