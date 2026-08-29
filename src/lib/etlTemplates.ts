// Sample ETL pipelines — the challenging scenarios, solved.
//
// Each template is a complete, runnable pipeline against the messy datasets
// shipped under public/etl-samples/ (deterministic, generated — every defect
// in them is deliberate and counted). The visual ones exercise the canvas at
// its hardest: branching, joins, multiple targets. The code ones solve the
// problems a step palette cannot: state read-back (SCD2, watermarks), fuzzy
// entity resolution, gap-based sessionization.
//
// tests/unit/etlTemplates.test.ts compiles every visual graph and feeds every
// script to CPython's compile(), and pins the datasets these reference — a
// template that rots fails the build, not the first user who tries it.
import type { EtlGraph } from "@/utils/etl/codegen";

export type EtlTemplate = {
  id: string;
  name: string;
  description: string;
  mode: "visual" | "code";
  graph?: EtlGraph;
  source_code?: string;
  requirements: string;
};

// Shared Python snippet: fetch a sample dataset from this deployment's own
// origin — reachable from the sandbox by design (the batch runner reports its
// results to the same origin).
const FETCH_CSV = `import io as _io
import os
import requests

def _fetch_csv(name):
    base = os.environ.get('AGENTSWARMS_ORIGIN', 'http://127.0.0.1:8080').rstrip('/')
    r = requests.get(f"{base}/etl-samples/{name}", timeout=30)
    r.raise_for_status()
    return pd.read_csv(_io.StringIO(r.text))`;

// Destination helpers for code templates that must read their own previous
// output (SCD2 history, watermarks). Parses the documented ETL_DEST_* env.
const DEST_FS = `import json
import s3fs

def _dest():
    url = os.environ['ETL_DEST_BUCKET_URL']  # s3://bucket[/prefix]
    path = url[len('s3://'):]
    fs = s3fs.S3FileSystem(
        key=os.environ.get('ETL_DEST_ACCESS_KEY_ID', ''),
        secret=os.environ.get('ETL_DEST_SECRET_ACCESS_KEY', ''),
        endpoint_url=os.environ.get('ETL_DEST_ENDPOINT_URL') or None,
    )
    return fs, path

def _dest_loader():
    import dlt
    from dlt.destinations import filesystem
    return dlt, filesystem(
        bucket_url=os.environ['ETL_DEST_BUCKET_URL'],
        credentials={
            'aws_access_key_id': os.environ.get('ETL_DEST_ACCESS_KEY_ID', ''),
            'aws_secret_access_key': os.environ.get('ETL_DEST_SECRET_ACCESS_KEY', ''),
            'endpoint_url': os.environ.get('ETL_DEST_ENDPOINT_URL') or None,
        },
    )`;

// ── 1 · Medallion branch-out (visual) ───────────────────────────────────────

const MEDALLION_GRAPH: EtlGraph = {
  nodes: [
    {
      id: "n1",
      kind: "source",
      label: "Raw orders (bronze)",
      config: {
        type: "python",
        code: [
          "import io as _io, requests",
          "base = os.environ.get('AGENTSWARMS_ORIGIN', 'http://127.0.0.1:8080').rstrip('/')",
          'r = requests.get(f"{base}/etl-samples/orders.csv", timeout=30)',
          "r.raise_for_status()",
          "return pd.read_csv(_io.StringIO(r.text))",
        ].join("\n"),
      },
      position: { x: 40, y: 220 },
    },
    {
      id: "n2",
      kind: "transform",
      label: "Standardise + validate",
      config: {
        type: "python",
        code: [
          "# Normalise, then FLAG problems instead of dropping them — the",
          "# quarantine branch needs the rejects, with reasons attached.",
          "df = df.copy()",
          "df['currency'] = df['currency'].str.upper()",
          "df['amount'] = pd.to_numeric(df['amount'], errors='coerce')",
          "df['customer_id'] = df['customer_id'].fillna('')",
          "df = df.drop_duplicates(subset=['order_id'], keep='first')",
          "reasons = []",
          "for _, r in df.iterrows():",
          "    problems = []",
          "    if not r['amount'] or r['amount'] <= 0: problems.append('non_positive_amount')",
          "    if not r['customer_id']: problems.append('missing_customer')",
          "    c = str(r['country'])",
          "    if len(c) != 2 or not c.isalpha() or c == 'XX': problems.append('bad_country')",
          "    reasons.append(','.join(problems))",
          "df['reject_reason'] = reasons",
          "df['is_valid'] = df['reject_reason'] == ''",
          "return df",
        ].join("\n"),
      },
      position: { x: 300, y: 220 },
    },
    {
      id: "n3",
      kind: "transform",
      label: "Valid rows",
      config: { type: "filter", expr: "is_valid" },
      position: { x: 560, y: 100 },
    },
    {
      id: "n4",
      kind: "transform",
      label: "Rejected rows",
      config: { type: "filter", expr: "not is_valid" },
      position: { x: 560, y: 340 },
    },
    {
      id: "n5",
      kind: "transform",
      label: "Revenue by country",
      config: {
        type: "aggregate",
        group_by: ["country", "currency"],
        aggs: [
          { column: "amount", fn: "sum", as: "revenue" },
          { column: "order_id", fn: "count", as: "orders" },
        ],
      },
      position: { x: 820, y: 40 },
    },
    {
      id: "n6",
      kind: "target",
      label: "Silver: clean orders",
      config: {
        type: "object_storage",
        dataset: "medallion",
        table: "orders_silver",
        format: "parquet",
        write_mode: "replace",
      },
      position: { x: 820, y: 180 },
    },
    {
      id: "n7",
      kind: "target",
      label: "Gold: country KPIs",
      config: {
        type: "object_storage",
        dataset: "medallion",
        table: "revenue_by_country",
        format: "parquet",
        write_mode: "replace",
      },
      position: { x: 1080, y: 40 },
    },
    {
      id: "n8",
      kind: "target",
      label: "Quarantine",
      config: {
        type: "object_storage",
        dataset: "medallion",
        table: "orders_quarantine",
        format: "jsonl",
        write_mode: "replace",
      },
      position: { x: 820, y: 340 },
    },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2" },
    { id: "e2", from: "n2", to: "n3" },
    { id: "e3", from: "n2", to: "n4" },
    { id: "e4", from: "n3", to: "n5" },
    { id: "e5", from: "n3", to: "n6" },
    { id: "e6", from: "n5", to: "n7" },
    { id: "e7", from: "n4", to: "n8" },
  ],
};

// ── 2 · Reconciliation (visual) ─────────────────────────────────────────────

const RECONCILIATION_GRAPH: EtlGraph = {
  nodes: [
    {
      id: "n1",
      kind: "source",
      label: "Orders",
      config: {
        type: "python",
        code: [
          "import io as _io, requests",
          "base = os.environ.get('AGENTSWARMS_ORIGIN', 'http://127.0.0.1:8080').rstrip('/')",
          'r = requests.get(f"{base}/etl-samples/orders.csv", timeout=30)',
          "r.raise_for_status()",
          "return pd.read_csv(_io.StringIO(r.text))",
        ].join("\n"),
      },
      position: { x: 40, y: 120 },
    },
    {
      id: "n2",
      kind: "transform",
      label: "Dedupe orders",
      config: { type: "dedupe", columns: ["order_id"] },
      position: { x: 280, y: 120 },
    },
    {
      id: "n3",
      kind: "source",
      label: "Payments",
      config: {
        type: "python",
        code: [
          "import io as _io, requests",
          "base = os.environ.get('AGENTSWARMS_ORIGIN', 'http://127.0.0.1:8080').rstrip('/')",
          'r = requests.get(f"{base}/etl-samples/payments.csv", timeout=30)',
          "r.raise_for_status()",
          "return pd.read_csv(_io.StringIO(r.text))",
        ].join("\n"),
      },
      position: { x: 40, y: 340 },
    },
    {
      id: "n4",
      kind: "transform",
      label: "Payments per order",
      config: {
        type: "aggregate",
        group_by: ["order_id"],
        aggs: [
          { column: "paid_amount", fn: "sum", as: "paid_total" },
          { column: "payment_id", fn: "count", as: "n_payments" },
        ],
      },
      position: { x: 280, y: 340 },
    },
    {
      id: "n5",
      kind: "transform",
      label: "Full outer join",
      config: {
        type: "join",
        how: "outer",
        left_on: ["order_id"],
        right_on: ["order_id"],
        left_node: "n2",
      },
      position: { x: 540, y: 220 },
    },
    {
      id: "n6",
      kind: "transform",
      label: "Classify",
      config: {
        type: "python",
        code: [
          "# One row per order/payment pairing; classify the discrepancy.",
          "import numpy as np",
          "df = df.copy()",
          "df['paid_total'] = df['paid_total'].fillna(0)",
          "df['n_payments'] = df['n_payments'].fillna(0).astype(int)",
          "is_orphan = df['amount'].isna()",
          "unpaid = (~is_orphan) & (df['n_payments'] == 0)",
          "double = (~is_orphan) & (df['n_payments'] > 1)",
          "mismatch = (~is_orphan) & (df['n_payments'] == 1) & ((df['paid_total'] - df['amount']).abs() > 0.01)",
          "df['recon_status'] = np.select(",
          "    [is_orphan, unpaid, double, mismatch],",
          "    ['orphan_payment', 'missing_payment', 'duplicate_payment', 'amount_mismatch'],",
          "    default='ok',",
          ")",
          "return df",
        ].join("\n"),
      },
      position: { x: 800, y: 220 },
    },
    {
      id: "n7",
      kind: "transform",
      label: "Matched",
      config: { type: "filter", expr: "recon_status == 'ok'" },
      position: { x: 1060, y: 120 },
    },
    {
      id: "n8",
      kind: "transform",
      label: "Exceptions",
      config: { type: "filter", expr: "recon_status != 'ok'" },
      position: { x: 1060, y: 340 },
    },
    {
      id: "n9",
      kind: "target",
      label: "Reconciled",
      config: {
        type: "object_storage",
        dataset: "finance",
        table: "orders_reconciled",
        format: "parquet",
        write_mode: "replace",
      },
      position: { x: 1300, y: 120 },
    },
    {
      id: "n10",
      kind: "target",
      label: "Exception report",
      config: {
        type: "object_storage",
        dataset: "finance",
        table: "recon_exceptions",
        format: "jsonl",
        write_mode: "replace",
      },
      position: { x: 1300, y: 340 },
    },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2" },
    { id: "e2", from: "n2", to: "n5" },
    { id: "e3", from: "n3", to: "n4" },
    { id: "e4", from: "n4", to: "n5" },
    { id: "e5", from: "n5", to: "n6" },
    { id: "e6", from: "n6", to: "n7" },
    { id: "e7", from: "n6", to: "n8" },
    { id: "e8", from: "n7", to: "n9" },
    { id: "e9", from: "n8", to: "n10" },
  ],
};

// ── 3 · SCD Type 2 (code) ───────────────────────────────────────────────────

const SCD2_CODE = `# Slowly Changing Dimension, Type 2 — full history with validity ranges.
#
# THE HARD PART: a dimension row that changes must not be overwritten. The old
# version is closed out (valid_to stamped, is_current=False) and a new current
# version is inserted. That requires knowing the PREVIOUS state, so this
# pipeline reads its own destination table back before computing the delta —
# on the first run there is none, and every row is an insert.
#
# Datasets: employees_day1.csv, then employees_day2.csv (change SNAPSHOT below
# and re-run to watch history accumulate: 15 changed, 3 removed, 5 hired).
SNAPSHOT = 'employees_day1.csv'   # -> change to employees_day2.csv for run 2
SNAPSHOT_DATE = '2026-08-28'      # -> and this to 2026-08-29

import pandas as pd

__FETCH_CSV__

__DEST_FS__

TRACKED = ['name', 'department', 'salary']
HIGH_DATE = '9999-12-31'


def _read_history(fs, base):
    files = fs.glob(f"{base}/scd/dim_employees/*.parquet")
    if not files:
        return None
    frames = []
    for f in files:
        with fs.open(f, 'rb') as fh:
            frames.append(pd.read_parquet(fh))
    hist = pd.concat(frames, ignore_index=True)
    # dlt bookkeeping columns are not part of the dimension.
    return hist[[c for c in hist.columns if not c.startswith('_dlt')]]


def entrypoint(inputs=None):
    snap = _fetch_csv(SNAPSHOT)
    snap['salary'] = snap['salary'].astype(int)

    fs, base = _dest()
    history = _read_history(fs, base)

    if history is None:
        out = snap.copy()
        out['valid_from'] = SNAPSHOT_DATE
        out['valid_to'] = HIGH_DATE
        out['is_current'] = True
        inserts, closed = len(out), 0
    else:
        current = history[history['is_current']].set_index('emp_id')
        incoming = snap.set_index('emp_id')

        new_ids = incoming.index.difference(current.index)
        gone_ids = current.index.difference(incoming.index)
        shared = incoming.index.intersection(current.index)
        changed_ids = [
            e for e in shared
            if any(current.at[e, c] != incoming.at[e, c] for c in TRACKED)
        ]

        closed_ids = set(changed_ids) | set(gone_ids)
        history = history.copy()
        to_close = history['is_current'] & history['emp_id'].isin(closed_ids)
        history.loc[to_close, 'valid_to'] = SNAPSHOT_DATE
        history.loc[to_close, 'is_current'] = False

        fresh = incoming.loc[list(new_ids) + list(changed_ids)].reset_index()
        fresh['valid_from'] = SNAPSHOT_DATE
        fresh['valid_to'] = HIGH_DATE
        fresh['is_current'] = True

        out = pd.concat([history, fresh], ignore_index=True)
        inserts, closed = len(fresh), int(to_close.sum())

    dlt, dest = _dest_loader()
    pipe = dlt.pipeline(pipeline_name='scd_dim_employees', destination=dest, dataset_name='scd')
    resource = dlt.resource(out.to_dict('records'), name='dim_employees', write_disposition='replace')
    pipe.run(resource, loader_file_format='parquet')

    metrics = {
        'rows_loaded': int(len(out)),
        'versions_inserted': int(inserts),
        'versions_closed': int(closed),
        'current_rows': int(out['is_current'].sum()),
        'snapshot': SNAPSHOT,
    }
    print('[etl] ' + json.dumps(metrics))
    return metrics
`;

// ── 4 · Incremental load with a watermark (code) ────────────────────────────

const WATERMARK_CODE = `# Incremental load — only rows newer than the last successful run.
#
# THE HARD PART: "new since last time" needs durable state. The watermark
# lives as a small JSON object in the destination bucket itself, so it
# survives restarts, is visible to the operator, and belongs to the same
# credential scope as the data. Run twice: the first load takes every row,
# the second takes none — until the source moves.
import pandas as pd

__FETCH_CSV__

__DEST_FS__

STATE_KEY = '_state/orders_watermark.json'
EPOCH = '1970-01-01T00:00:00Z'


def _read_watermark(fs, base):
    try:
        with fs.open(f"{base}/{STATE_KEY}") as fh:
            return json.loads(fh.read())['watermark']
    except FileNotFoundError:
        return EPOCH


def _write_watermark(fs, base, value):
    with fs.open(f"{base}/{STATE_KEY}", 'w') as fh:
        fh.write(json.dumps({'watermark': value}))


def entrypoint(inputs=None):
    fs, base = _dest()
    watermark = _read_watermark(fs, base)

    df = _fetch_csv('orders.csv')
    fresh = df[df['updated_at'] > watermark].copy()

    if len(fresh):
        dlt, dest = _dest_loader()
        pipe = dlt.pipeline(pipeline_name='orders_incremental', destination=dest, dataset_name='incremental')
        resource = dlt.resource(fresh.to_dict('records'), name='orders', write_disposition='append')
        pipe.run(resource, loader_file_format='parquet')
        # Only after a durable load may the watermark advance — the other
        # order loses rows on a crash between the two writes.
        _write_watermark(fs, base, str(fresh['updated_at'].max()))

    metrics = {
        'rows_loaded': int(len(fresh)),
        'previous_watermark': watermark,
        'new_watermark': str(fresh['updated_at'].max()) if len(fresh) else watermark,
        'source_rows_seen': int(len(df)),
    }
    print('[etl] ' + json.dumps(metrics))
    return metrics
`;

// ── 5 · Fuzzy contact dedupe + survivorship (code) ──────────────────────────

const DEDUPE_CODE = `# Entity resolution across two CRM exports that disagree about formatting.
#
# THE HARD PART: the same person appears as "AVA STONE" / "ava stone", with
# phones as +15551234567 / (555) 123-4567 / 555.123.4567, and emails differing
# by case. Exact dedupe finds nothing. The fix is a canonical match key built
# from normalised fields, then SURVIVORSHIP: for each entity, keep the most
# recently updated values and record which systems contributed.
import re

import pandas as pd

__FETCH_CSV__

__DEST_FS__


def _normalise(df, source):
    out = pd.DataFrame()
    out['source_id'] = df['contact_id']
    out['source'] = source
    out['full_name'] = df['full_name'].str.strip().str.title()
    out['email'] = df['email'].str.strip().str.lower()
    out['phone'] = df['phone'].map(lambda p: re.sub(r'\\D', '', str(p))[-10:])
    out['company'] = df['company']
    out['updated_at'] = df['updated_at']
    # Email is the primary identity; phone+name backstops a missing email.
    out['match_key'] = out['email'].where(out['email'].ne(''), out['phone'] + '|' + out['full_name'])
    return out


def entrypoint(inputs=None):
    a = _normalise(_fetch_csv('crm_contacts_a.csv'), 'system_a')
    b = _normalise(_fetch_csv('crm_contacts_b.csv'), 'system_b')
    all_rows = pd.concat([a, b], ignore_index=True)

    # Survivorship: newest record wins each field; provenance is kept.
    all_rows = all_rows.sort_values('updated_at')
    golden = all_rows.groupby('match_key').agg(
        full_name=('full_name', 'last'),
        email=('email', 'last'),
        phone=('phone', 'last'),
        company=('company', 'last'),
        last_seen=('updated_at', 'max'),
        first_seen=('updated_at', 'min'),
        source_count=('source', 'nunique'),
        record_count=('source_id', 'count'),
    ).reset_index(drop=True)

    dlt, dest = _dest_loader()
    pipe = dlt.pipeline(pipeline_name='crm_golden_contacts', destination=dest, dataset_name='crm')
    resource = dlt.resource(golden.to_dict('records'), name='golden_contacts', write_disposition='replace')
    pipe.run(resource, loader_file_format='parquet')

    metrics = {
        'rows_loaded': int(len(golden)),
        'input_records': int(len(all_rows)),
        'merged_across_systems': int((golden['source_count'] > 1).sum()),
    }
    print('[etl] ' + json.dumps(metrics))
    return metrics
`;

// ── 6 · Clickstream sessionization (code) ───────────────────────────────────

const SESSION_CODE = `# Sessionization — assign session ids to raw click events.
#
# THE HARD PART: sessions do not exist in the data. They are defined by a
# rule — a gap of more than 30 minutes of inactivity starts a new session —
# which is stateful across rows and only correct after sorting each user's
# events by time (the file arrives in shuffled order, as event data does).
import io as _io
import os

import pandas as pd
import requests

__DEST_FS__

GAP_MINUTES = 30


def entrypoint(inputs=None):
    base = os.environ.get('AGENTSWARMS_ORIGIN', 'http://127.0.0.1:8080').rstrip('/')
    r = requests.get(f"{base}/etl-samples/clickstream.jsonl", timeout=30)
    r.raise_for_status()
    events = pd.read_json(_io.StringIO(r.text), lines=True)
    events['ts'] = pd.to_datetime(events['ts'])

    events = events.sort_values(['user_id', 'ts']).reset_index(drop=True)
    gap = events.groupby('user_id')['ts'].diff()
    new_session = gap.isna() | (gap > pd.Timedelta(minutes=GAP_MINUTES))
    events['session_seq'] = new_session.groupby(events['user_id']).cumsum().astype(int)
    events['session_id'] = events['user_id'] + '-s' + events['session_seq'].astype(str)

    sessions = events.groupby(['user_id', 'session_id']).agg(
        started_at=('ts', 'min'),
        ended_at=('ts', 'max'),
        events=('page', 'count'),
        unique_pages=('page', 'nunique'),
    ).reset_index()
    sessions['duration_seconds'] = (sessions['ended_at'] - sessions['started_at']).dt.total_seconds().astype(int)
    sessions['started_at'] = sessions['started_at'].astype(str)
    sessions['ended_at'] = sessions['ended_at'].astype(str)

    dlt, dest = _dest_loader()
    pipe = dlt.pipeline(pipeline_name='web_sessions', destination=dest, dataset_name='analytics')
    resource = dlt.resource(sessions.to_dict('records'), name='sessions', write_disposition='replace')
    pipe.run(resource, loader_file_format='parquet')

    metrics = {
        'rows_loaded': int(len(sessions)),
        'events_processed': int(len(events)),
        'users': int(sessions['user_id'].nunique()),
        'median_session_seconds': int(sessions['duration_seconds'].median()),
    }
    print('[etl] ' + json.dumps(metrics))
    return metrics
`;

// ── Registry ────────────────────────────────────────────────────────────────

function withHelpers(code: string): string {
  return code.replace("__FETCH_CSV__", FETCH_CSV).replace("__DEST_FS__", DEST_FS);
}

export const ETL_TEMPLATES: EtlTemplate[] = [
  {
    id: "medallion",
    name: "Medallion branch-out",
    description:
      "One messy source fans out to three targets: cleaned silver rows, aggregated gold KPIs, and a quarantine of rejects with reasons attached.",
    mode: "visual",
    graph: MEDALLION_GRAPH,
    requirements: "dlt[filesystem]>=1.3\npandas\npyarrow\nrequests",
  },
  {
    id: "reconciliation",
    name: "Orders ↔ payments reconciliation",
    description:
      "Two sources, a full outer join, and per-row classification — missing, duplicate, mismatched and orphan payments land in an exception report.",
    mode: "visual",
    graph: RECONCILIATION_GRAPH,
    requirements: "dlt[filesystem]>=1.3\npandas\npyarrow\nrequests",
  },
  {
    id: "scd2",
    name: "SCD Type 2 dimension history",
    description:
      "Dimension changes close out the old version and insert a new one, with validity ranges — the pipeline reads its own destination back to know what changed.",
    mode: "code",
    source_code: withHelpers(SCD2_CODE),
    requirements: "dlt[filesystem]>=1.3\npandas\npyarrow\nrequests\ns3fs",
  },
  {
    id: "watermark",
    name: "Incremental load with watermark",
    description:
      "Loads only rows newer than the last run, with the watermark persisted in the destination bucket — run it twice and the second load is empty.",
    mode: "code",
    source_code: withHelpers(WATERMARK_CODE),
    requirements: "dlt[filesystem]>=1.3\npandas\npyarrow\nrequests\ns3fs",
  },
  {
    id: "fuzzy-dedupe",
    name: "Fuzzy contact dedupe",
    description:
      "Two CRM exports that format names, phones and emails differently become one golden contact table via canonical match keys and survivorship rules.",
    mode: "code",
    source_code: withHelpers(DEDUPE_CODE),
    requirements: "dlt[filesystem]>=1.3\npandas\npyarrow\nrequests\ns3fs",
  },
  {
    id: "sessionization",
    name: "Clickstream sessionization",
    description:
      "Shuffled click events become per-user sessions via a 30-minute inactivity rule — stateful windowing that only works after sorting time back into order.",
    mode: "code",
    source_code: withHelpers(SESSION_CODE),
    requirements: "dlt[filesystem]>=1.3\npandas\npyarrow\nrequests\ns3fs",
  },
];
