// What the Data science pages say about many models at once (R538): Model
// serving (every endpoint that answers requests) and ML operations (what is
// running, what failed, what is due). Worked out from plain rows, so every
// sentence a page shows is held by a test.

export type EndpointStatus = "starting" | "ready" | "failed" | "stopped";
export type CandidateMode = "off" | "shadow" | "canary";

/** One warm endpoint, as the serving page lists it. */
export type EndpointView = {
  model: {
    id: string;
    name: string;
    task: string;
    shared: boolean;
    production_version: number | null;
  };
  deployment_id: string;
  status: EndpointStatus;
  version: number | null;
  /** The endpoint serves something other than the production version. */
  stale: boolean;
  keep_warm: boolean;
  min_replicas: number;
  max_replicas: number;
  request_count: number;
  last_used_at: string | null;
  last_error: string | null;
  candidate: { mode: CandidateMode; version: number | null; percent: number | null };
  rollback: { at: string; reason: string | null } | null;
  copies: { ready: number; starting: number };
  /** Where its copies run: sandboxes the app scales, or a KServe InferenceService. */
  runs_on: { kind: "sandboxes" } | { kind: "kserve"; namespace: string; name: string };
};

export type Tone = "ok" | "warn" | "bad" | "idle";

/** The one word a row leads with, and the sentence behind it. */
export function endpointState(
  e: EndpointView,
  now = Date.now(),
): {
  tone: Tone;
  label: string;
  detail: string | null;
} {
  if (e.status === "failed") {
    return { tone: "bad", label: "Failed", detail: e.last_error ?? "Its copies would not start." };
  }
  if (e.status === "stopped") return { tone: "idle", label: "Stopped", detail: null };
  if (e.status === "starting") {
    return { tone: "idle", label: "Starting", detail: "Loading the model into its first copy." };
  }
  // Ready from here on.
  if (e.rollback && now - new Date(e.rollback.at).getTime() < 7 * 86_400_000) {
    return {
      tone: "warn",
      label: "Rolled back",
      detail: `A canary was rolled back${e.rollback.reason ? `: ${e.rollback.reason}` : ""}.`,
    };
  }
  if (e.stale && e.version !== null && e.model.production_version !== null) {
    return {
      tone: "warn",
      label: "Behind production",
      detail: `Serves v${e.version}; production is v${e.model.production_version}.`,
    };
  }
  if (e.copies.ready === 0 && e.runs_on.kind === "sandboxes" && !e.keep_warm) {
    return {
      tone: "idle",
      label: "Asleep",
      detail: "No copy is running; the next request starts one.",
    };
  }
  return { tone: "ok", label: "Serving", detail: null };
}

/** How requests split between versions, in words. */
export function trafficLine(e: EndpointView): string {
  const primary = e.version !== null ? `v${e.version}` : "its version";
  const cand = e.candidate.version !== null ? `v${e.candidate.version}` : "a candidate";
  if (e.candidate.mode === "shadow") {
    return `${primary} answers; ${cand} sees every request as a shadow and answers none`;
  }
  if (e.candidate.mode === "canary") {
    const pct = e.candidate.percent ?? 0;
    return `${primary} takes ${100 - pct}%; ${cand} takes ${pct}% as a canary`;
  }
  return `${primary} takes every request`;
}

/** "2 running", "1 running, 1 starting", "Scaled to zero". */
export function copiesLine(e: EndpointView): string {
  const parts: string[] = [];
  if (e.copies.ready) parts.push(`${e.copies.ready} running`);
  if (e.copies.starting) parts.push(`${e.copies.starting} starting`);
  if (parts.length === 0) return e.status === "stopped" ? "—" : "Scaled to zero";
  const range = e.runs_on.kind === "sandboxes" ? ` (${e.min_replicas} to ${e.max_replicas})` : "";
  return parts.join(", ") + range;
}

/** Order: what needs a look first, then the busiest; stopped ones last. */
export function sortEndpoints(rows: EndpointView[], now = Date.now()): EndpointView[] {
  const rank: Record<Tone, number> = { bad: 0, warn: 1, ok: 2, idle: 3 };
  return [...rows].sort((a, b) => {
    const sa = a.status === "stopped" ? 9 : rank[endpointState(a, now).tone];
    const sb = b.status === "stopped" ? 9 : rank[endpointState(b, now).tone];
    if (sa !== sb) return sa - sb;
    return b.request_count - a.request_count;
  });
}

// ── ML operations ───────────────────────────────────────────────────────────

/** A model page tab a row links to. */
export type ModelTab = "overview" | "versions" | "predictions" | "accuracy" | "jobs" | "automation";

export type AttentionItem = {
  severity: "bad" | "warn";
  model_id: string;
  model_name: string;
  what: string;
  detail: string;
  at: string | null;
  tab: ModelTab;
};

/**
 * A stored error's reason, in one line. Since R536 the reason comes first;
 * a job that failed before then stored the bare Python traceback, whose
 * reason is its last "SomethingError: …" line (found in the R538 UI test,
 * where such a row read only "Traceback (most recent call last):").
 */
export function errorLead(error: string | null | undefined, max = 240): string {
  const text = (error ?? "").trim();
  const clip = (t: string) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
  if (text.startsWith("Traceback (most recent call last):")) {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i > 0; i--) {
      const m = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt)):\s?(.*)$/.exec(
        lines[i].trim(),
      );
      if (!m) continue;
      if (!m[2]) return clip(m[1]);
      return clip(m[1] === "RuntimeError" ? m[2] : `${m[1]}: ${m[2]}`);
    }
  }
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim() ? clip(line.trim()) : "It ended without saying why.";
}

/** When a schedule runs next: "in 5 min", "in 3 h", "in 2 days", or "due now". */
export function nextRunLine(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s <= 30) return "due now";
  if (s < 90 * 60) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 36 * 3600) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}

/** What a schedule's last run did, in words (schedule.server.ts writes these). */
export function lastRunOutcome(status: string | null | undefined): string {
  switch (status) {
    case "promoted":
      return "promoted a better version";
    case "kept":
      return "kept the production version";
    case null:
    case undefined:
    case "":
      return "ran";
    default:
      return status;
  }
}

/**
 * Why a live job has not started, when its log says (R537): the last
 * "waiting to start" line refreshMlJob wrote. Null once it is running.
 */
export function waitingReason(logs: string | null | undefined): string | null {
  if (!logs) return null;
  const all = [...logs.matchAll(/── waiting to start: (.+?) ──/g)];
  if (all.length === 0) return null;
  // Anything after the last waiting line means it started since.
  const last = all[all.length - 1];
  const after = logs.slice((last.index ?? 0) + last[0].length).trim();
  return after ? null : last[1];
}

export type JobLite = {
  id: string;
  model_id: string;
  version: number | null;
  status: string;
  trigger: string | null;
  error: string | null;
  logs?: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  import?: boolean;
};

export type PredictionLite = {
  id: string;
  model_id: string;
  status: string;
  error: string | null;
  drift_score: number | null;
  row_count: number | null;
  created_at: string;
  finished_at: string | null;
};

export type ScheduleLite = {
  id: string;
  model_id: string;
  name: string;
  kind: "retrain" | "batch_predict";
  is_active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
};

/** Everything across a person's models that wants a look, worst and newest first. */
export function attentionItems(input: {
  names: Map<string, string>;
  failedJobs: JobLite[];
  failedPredictions: PredictionLite[];
  endpoints: EndpointView[];
  schedules: ScheduleLite[];
  /** model id → the health sentences modelHealthFor wrote (drift, decay). */
  health: Map<string, string[]>;
  now?: number;
}): AttentionItem[] {
  const name = (id: string) => input.names.get(id) ?? "A model";
  const out: AttentionItem[] = [];
  for (const j of input.failedJobs) {
    out.push({
      severity: "bad",
      model_id: j.model_id,
      model_name: name(j.model_id),
      what: `${j.import ? "Import" : "Training"}${j.version !== null ? ` of v${j.version}` : ""} failed`,
      detail: errorLead(j.error),
      at: j.finished_at ?? j.created_at,
      tab: "jobs",
    });
  }
  for (const p of input.failedPredictions) {
    out.push({
      severity: "bad",
      model_id: p.model_id,
      model_name: name(p.model_id),
      what: "Batch prediction failed",
      detail: errorLead(p.error),
      at: p.finished_at ?? p.created_at,
      tab: "predictions",
    });
  }
  for (const e of input.endpoints) {
    const s = endpointState(e, input.now);
    if (e.status === "stopped" || (s.tone !== "bad" && s.tone !== "warn")) continue;
    out.push({
      severity: s.tone === "bad" ? "bad" : "warn",
      model_id: e.model.id,
      model_name: e.model.name,
      what: `Endpoint ${s.label.toLowerCase()}`,
      detail: s.detail ?? "",
      at: e.rollback?.at ?? e.last_used_at,
      tab: "automation",
    });
  }
  for (const s of input.schedules) {
    if (!s.is_active || !s.last_status || !/fail|error/i.test(s.last_status)) continue;
    out.push({
      severity: "warn",
      model_id: s.model_id,
      model_name: name(s.model_id),
      what: `Schedule "${s.name}" failed its last run`,
      detail: errorLead(s.last_error),
      at: s.last_run_at,
      tab: "automation",
    });
  }
  for (const [id, alerts] of input.health) {
    for (const a of alerts) {
      out.push({
        severity: "warn",
        model_id: id,
        model_name: name(id),
        what: "Production version needs a look",
        detail: a,
        at: null,
        tab: "accuracy",
      });
    }
  }
  return out.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "bad" ? -1 : 1;
    return new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime();
  });
}

/** "Retrain" or "Batch prediction". */
export function scheduleKind(kind: ScheduleLite["kind"]): string {
  return kind === "retrain" ? "Retrain" : "Batch prediction";
}

/** Seconds between two stamps as "42 s", "3 min", "1 h 5 min"; null when unknown. */
export function duration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
