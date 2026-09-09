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
 * An object-storage source that reads only files not loaded before. Its
 * ledger rides the engine cursor like a stream's positions, which is what
 * makes it drainable: every tick lists the prefix and loads what is new.
 */
export function isAutoIngest(config: unknown): boolean {
  const c = config as { type?: string; new_files_only?: boolean } | null | undefined;
  return c?.type === "object_storage" && c.new_files_only === true;
}

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
        DRAINABLE.has(c.type ?? "") ||
        c.mode === "cdc" ||
        Boolean(c.incremental?.cursor_column) ||
        isAutoIngest(c)
      );
    });
  if (!drains) {
    return "A continuous pipeline needs a source it can drain again and again — a Kafka, Kinesis or Pub/Sub stream, webhook ingest, change data capture, or an incremental cursor. A plain batch source would re-read everything on every tick.";
  }
  return null;
}

/**
 * Whether a continuous pipeline can be exactly-once: every target is a
 * lakehouse table, so a tick's loads and its source positions can commit in
 * ONE DuckLake transaction. A storage, database, HTTP or SaaS target has no
 * part in that transaction, and a pipeline with one stays at-least-once.
 */
export function exactlyOnceEligible(
  graph: { nodes?: { kind?: string; config?: unknown }[] } | null | undefined,
): boolean {
  const targets = (graph?.nodes ?? []).filter((n) => n.kind === "target");
  if (!targets.length) return false;
  return targets.every((n) => (n.config as { type?: string } | undefined)?.type === "lakehouse");
}

/**
 * The loop, as Python appended to a compiled program whose per-tick body is
 * `_tick`. `cursorEnv` maps each incremental node to its env stem, so the
 * position a tick reports becomes the position the next tick starts from
 * without a round trip. Off (`ETL_CONTINUOUS` unset) the program runs once,
 * exactly as before.
 *
 * Exactly-once (`ETL_EXACTLY_ONCE=1`, set by the platform when every target
 * is a lakehouse table): each tick opens one lakehouse connection, begins a
 * transaction, lets every target load through it, writes the tick's source
 * positions to `_agentswarms.etl_cursors` in the same transaction, and
 * commits. A crash anywhere before the commit loses nothing and replays the
 * tick; a crash after it cannot replay, because the next run resumes from
 * the positions that committed WITH the rows, not from the report the
 * platform may never have received.
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
    `_tick_con = None`,
    `_EXACTLY_ONCE = os.environ.get('ETL_EXACTLY_ONCE') == '1'`,
    `_PIPELINE_ID = os.environ.get('ETL_PIPELINE_ID', '')`,
    ``,
    `def _cursor_table(con):`,
    `    # Hidden from the platform's schema list, so no user can query or drop it.`,
    `    con.execute('CREATE SCHEMA IF NOT EXISTS "_agentswarms"')`,
    `    con.execute('CREATE TABLE IF NOT EXISTS "_agentswarms"."etl_cursors" (pipeline_id VARCHAR, node_id VARCHAR, cursor VARCHAR, updated_at TIMESTAMP)')`,
    ``,
    `def _load_committed_cursors():`,
    `    # The positions that committed with the last load win over the ones the`,
    `    # platform recorded: the report is what a crash can lose, the commit is not.`,
    `    con = _lakehouse_con()`,
    `    try:`,
    `        _cursor_table(con)`,
    `        rows = con.execute('SELECT node_id, cursor FROM "_agentswarms"."etl_cursors" WHERE pipeline_id = ?', [_PIPELINE_ID]).fetchall()`,
    `    finally:`,
    `        con.close()`,
    `    n = 0`,
    `    for node_id, cur in rows:`,
    `        stem = _CURSOR_ENV.get(node_id)`,
    `        if stem and cur is not None:`,
    `            os.environ[stem + '_CURSOR'] = str(cur)`,
    `            n += 1`,
    `    print('[etl] exactly-once: resumed ' + str(n) + ' cursor(s) committed with the last load')`,
    ``,
    `def _commit_cursors(con, watermarks):`,
    `    for k, v in watermarks.items():`,
    `        if v is None or k not in _CURSOR_ENV:`,
    `            continue`,
    `        con.execute('DELETE FROM "_agentswarms"."etl_cursors" WHERE pipeline_id = ? AND node_id = ?', [_PIPELINE_ID, k])`,
    `        con.execute('INSERT INTO "_agentswarms"."etl_cursors" VALUES (?, ?, ?, now())', [_PIPELINE_ID, k, str(v)])`,
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
    `    global _tick_con`,
    `    import time as _time`,
    `    poll = max(1.0, float(os.environ.get('ETL_POLL_SECONDS') or ${CONTINUOUS_DEFAULT_POLL_SECONDS}))`,
    `    budget = max(60.0, float(os.environ.get('ETL_CONTINUOUS_MAX_SECONDS') or 43200))`,
    `    started = _time.monotonic()`,
    `    total = {'continuous': True, 'exactly_once': _EXACTLY_ONCE, 'rows_loaded': 0, 'ticks': 0, 'targets': {}, 'watermarks': {},`,
    `             'started_at': _time.strftime('%Y-%m-%dT%H:%M:%SZ', _time.gmtime())}`,
    `    print('[etl] continuous: polling every ' + str(poll) + ' s, rolling over after ' + str(int(budget)) + ' s' + (', exactly-once into the lakehouse' if _EXACTLY_ONCE else ''))`,
    `    if _EXACTLY_ONCE:`,
    `        _load_committed_cursors()`,
    `    conflicts = 0`,
    `    while _time.monotonic() - started < budget:`,
    `        if _EXACTLY_ONCE:`,
    `            # One connection, one transaction: every target's load and the`,
    `            # tick's positions commit together, or not at all.`,
    `            _tick_con = _lakehouse_con()`,
    `            _cursor_table(_tick_con)`,
    `            _tick_con.execute('BEGIN TRANSACTION')`,
    `        retry = False`,
    `        try:`,
    `            m = _tick(inputs) or {}`,
    `            if _EXACTLY_ONCE:`,
    `                _commit_cursors(_tick_con, m.get('watermarks') or {})`,
    `                _tick_con.execute('COMMIT')`,
    `        except Exception as e:`,
    `            if _tick_con is not None:`,
    `                try:`,
    `                    _tick_con.execute('ROLLBACK')`,
    `                except Exception:`,
    `                    pass`,
    `            # A commit conflict means another writer touched the same rows`,
    `            # meanwhile — a run being stopped that is still winding down, a`,
    `            # user's DML on the target. Nothing was committed and the cursors`,
    `            # in env have not moved, so the tick re-reads the same batch: retry`,
    `            # it rather than fail the run and pay the restart backoff.`,
    `            if _EXACTLY_ONCE and 'conflict' in str(e).lower() and conflicts < 20:`,
    `                conflicts += 1`,
    `                print('[etl] exactly-once: commit conflict, retrying the tick (' + str(conflicts) + ')')`,
    `                retry = True`,
    `            else:`,
    `                raise`,
    `        finally:`,
    `            if _tick_con is not None:`,
    `                try:`,
    `                    _tick_con.close()`,
    `                except Exception:`,
    `                    pass`,
    `                _tick_con = None`,
    `        if retry:`,
    `            _time.sleep(poll)`,
    `            continue`,
    `        conflicts = 0`,
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
