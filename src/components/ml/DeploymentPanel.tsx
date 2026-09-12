// The model's warm inference endpoint: is it up, on which version, and what
// happens when nobody calls it.
//
// A deployment is a container holding this model in memory. It is off by
// default and costs real memory while it is on, so the panel leads with the
// trade rather than a switch with no explanation.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Eye, Loader2, Play, Square, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { relTime } from "@/components/ml/mlUi";
import { cn } from "@/lib/utils";
import {
  mlDeploy,
  mlDeploymentGet,
  mlDeploymentUpdate,
  mlShadowSet,
  mlUndeploy,
  type MlDeploymentView,
} from "@/utils/mlOps.functions";
import {
  agreementRate,
  rowsUntilVerdict,
  shadowVerdict,
  type MlShadowTotals,
} from "@/lib/mlShadow";
import {
  canaryVerdict,
  errorRate,
  observedShare,
  requestsUntilVerdict,
  type MlCanaryTotals,
} from "@/lib/mlCanary";

/** The share a canary starts at when somebody picks one without saying. */
const DEFAULT_SHARE = 5;

export function DeploymentPanel({
  token,
  modelId,
  task,
  shared,
  hasReadyVersion,
  versions,
}: {
  token: string;
  modelId: string;
  task: string;
  shared: boolean;
  hasReadyVersion: boolean;
  /** Candidates a shadow can be run against. */
  versions: { id: string; version: number; status: string }[];
}) {
  const getFn = useServerFn(mlDeploymentGet);
  const shadowFn = useServerFn(mlShadowSet);
  // Local strings so a half-typed number is not sent; committed on blur, the
  // same shape the idle-timeout box already uses.
  const deployFn = useServerFn(mlDeploy);
  const undeployFn = useServerFn(mlUndeploy);
  const updateFn = useServerFn(mlDeploymentUpdate);

  const [dep, setDep] = useState<MlDeploymentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ttl, setTtl] = useState("15");
  const [minR, setMinR] = useState("1");
  const [maxR, setMaxR] = useState("1");
  const [share, setShare] = useState(String(DEFAULT_SHARE));

  const load = useCallback(async () => {
    const res = await getFn({ data: { accessToken: token, modelId } });
    if (res.ok) {
      setDep(res.deployment);
      if (res.deployment) {
        setTtl(String(res.deployment.idle_ttl_minutes));
        setMinR(String(res.deployment.min_replicas));
        setMaxR(String(res.deployment.max_replicas));
      }
    }
    setLoading(false);
  }, [getFn, token, modelId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A forecast is answered from its stored series with no model in the loop,
  // so there is nothing to hold warm and nothing to explain.
  if (task === "forecast") return null;

  const live = dep?.status === "ready" || dep?.status === "starting";
  // Which tasks a shadow can be MEASURED on. The same two the mirror compares
  // in serve.server.ts: elsewhere the two versions' labels are arbitrary
  // between fits, so an agreement rate would be a number about nothing.
  const comparable = task === "classification" || task === "regression";

  async function deploy() {
    setBusy(true);
    try {
      // Deploying loads the artifact and waits for it, so this is the one
      // slow button on the page; saying so beats a spinner with no story.
      const t = toast.loading("Starting the endpoint and loading the model…");
      const res = await deployFn({ data: { accessToken: token, modelId } });
      toast.dismiss(t);
      if (!res.ok) return toast.error(res.error);
      toast.success(`Serving v${res.version}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      const res = await undeployFn({ data: { accessToken: token, modelId } });
      if (!res.ok) return toast.error(res.error);
      toast.success("Endpoint stopped");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setShadow(versionId: string | null, mode?: "shadow" | "canary", percent?: number) {
    setBusy(true);
    try {
      const res = await shadowFn({
        data: { accessToken: token, modelId, versionId, mode, percent },
      });
      if (!res.ok) toast.error(res.error);
      else if (!versionId) toast.success("Stopped trying that version");
      else if (mode === "canary") toast.success(`Sending ${percent}% of requests to the candidate`);
      else toast.success("Shadowing started");
      // Either way, like every other control here: a refused change must not
      // sit on screen looking as though it took.
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function patch(next: {
    keep_warm?: boolean;
    idle_ttl_minutes?: number;
    min_replicas?: number;
    max_replicas?: number;
  }) {
    setBusy(true);
    try {
      const res = await updateFn({ data: { accessToken: token, modelId, ...next } });
      if (!res.ok) toast.error(res.error);
      // Reload either way. On a REFUSAL the boxes are showing what the person
      // typed and the server is holding something else — asking for a minimum
      // of 2 against a maximum of 1 leaves "2" on screen next to a "1" that
      // actually took effect, and the toast explaining why is gone in four
      // seconds. Snapping back is the only state a reader can trust.
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Warm endpoint</span>
            {loading ? null : live ? (
              <Badge className="bg-emerald-600 hover:bg-emerald-600">
                {dep?.status === "starting" ? "starting" : `serving v${dep?.version ?? "?"}`}
              </Badge>
            ) : dep?.status === "failed" ? (
              <Badge variant="destructive">failed</Badge>
            ) : (
              <Badge variant="secondary">off</Badge>
            )}
            {dep?.stale ? (
              <Badge className="bg-amber-600 hover:bg-amber-600">
                a newer version is in production
              </Badge>
            ) : null}
          </div>
          {!shared ? (
            <div className="flex items-center gap-2">
              {live ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void stop()}>
                  <Square className="mr-1 h-3.5 w-3.5" /> Stop
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={busy || !hasReadyVersion}
                onClick={() => void deploy()}
                title={hasReadyVersion ? undefined : "Train a version first"}
              >
                {busy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="mr-1 h-3.5 w-3.5" />
                )}
                {live ? "Redeploy production" : "Deploy"}
              </Button>
            </div>
          ) : null}
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Without one, every prediction starts a container, loads the model and throws it away —
          about twenty seconds before any scoring happens. A deployment pays that once and answers
          from memory afterwards. The scoring itself is identical: the same artifact, checked
          against the same digest, through the same fitted pipeline.
        </p>

        {dep?.last_error ? <p className="text-xs text-destructive">{dep.last_error}</p> : null}

        {live ? (
          <div className="flex flex-wrap items-center gap-4 border-t pt-3 text-xs">
            <span className="text-muted-foreground">
              {dep?.request_count ?? 0} request{dep?.request_count === 1 ? "" : "s"} served
              {dep?.last_used_at ? ` · last ${relTime(dep.last_used_at)}` : " · not called yet"}
            </span>
            {!shared ? (
              <>
                <label className="flex items-center gap-2">
                  <Switch
                    checked={dep?.keep_warm ?? false}
                    disabled={busy}
                    onCheckedChange={(v) => void patch({ keep_warm: v })}
                  />
                  <span>Keep warm</span>
                </label>
                {!dep?.keep_warm ? (
                  <span className="flex items-center gap-2">
                    <Label htmlFor="dep-ttl" className="text-xs">
                      Stop after
                    </Label>
                    <Input
                      id="dep-ttl"
                      type="number"
                      min={1}
                      max={1440}
                      value={ttl}
                      disabled={busy}
                      onChange={(e) => setTtl(e.target.value)}
                      onBlur={() => {
                        const n = Number(ttl);
                        if (
                          Number.isFinite(n) &&
                          n >= 1 &&
                          n <= 1440 &&
                          n !== dep?.idle_ttl_minutes
                        ) {
                          void patch({ idle_ttl_minutes: n });
                        }
                      }}
                      className="h-7 w-20"
                    />
                    <span className="text-muted-foreground">minutes idle</span>
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {live && dep ? (
          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium">
                {dep.replicas.filter((r) => r.status === "ready").length} of {dep.replicas.length}{" "}
                {dep.replicas.length === 1 ? "copy" : "copies"} answering
              </p>
              {!shared ? (
                <span className="flex items-center gap-2 text-xs">
                  <Label htmlFor="dep-min" className="text-xs text-muted-foreground">
                    Copies
                  </Label>
                  <Input
                    id="dep-min"
                    type="number"
                    min={0}
                    max={64}
                    value={minR}
                    disabled={busy}
                    onChange={(e) => setMinR(e.target.value)}
                    onBlur={() => {
                      const n = Number(minR);
                      if (Number.isFinite(n) && n >= 0 && n <= 64 && n !== dep.min_replicas) {
                        void patch({ min_replicas: n });
                      }
                    }}
                    className="h-7 w-16"
                  />
                  <span className="text-muted-foreground">to</span>
                  <Input
                    id="dep-max"
                    type="number"
                    min={1}
                    max={64}
                    value={maxR}
                    disabled={busy}
                    onChange={(e) => setMaxR(e.target.value)}
                    onBlur={() => {
                      const n = Number(maxR);
                      if (Number.isFinite(n) && n >= 1 && n <= 64 && n !== dep.max_replicas) {
                        void patch({ max_replicas: n });
                      }
                    }}
                    className="h-7 w-16"
                  />
                </span>
              ) : null}
            </div>

            {dep.replicas.length > 0 ? (
              <ul className="space-y-1">
                {dep.replicas.map((r, i) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <Badge
                      variant={r.status === "ready" ? "outline" : "secondary"}
                      className="text-[10px]"
                    >
                      {r.status}
                    </Badge>
                    {/* Numbered by position in the queue rather than by id: the
                        list is ordered quietest-first, which is the order the
                        scorer picks in and the scaler stops in. */}
                    <span className="text-muted-foreground">
                      copy {i + 1} · {r.request_count} request{r.request_count === 1 ? "" : "s"}
                      {r.last_used_at ? ` · last ${relTime(r.last_used_at)}` : " · not called yet"}
                    </span>
                    {r.last_error ? <span className="text-destructive">{r.last_error}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {dep.max_replicas > dep.min_replicas ? (
                <>
                  Copies are added when the endpoint is busier than one can carry and removed when
                  it is quiet — never below {dep.min_replicas}, never above {dep.max_replicas}.
                  Removing one waits for it to be genuinely idle, because stopping a container takes
                  any request still inside it.
                  {dep.last_scale_reason ? (
                    <>
                      {" "}
                      Last decision: {dep.last_scale_reason}
                      {dep.last_scaled_at ? ` (${relTime(dep.last_scaled_at)})` : ""}.
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  Fixed at {dep.max_replicas} {dep.max_replicas === 1 ? "copy" : "copies"}. Raise
                  the second number to let the endpoint add copies when it is busy — each one is
                  another container holding this model in memory, and each counts against the limits
                  below.
                </>
              )}
            </p>
          </div>
        ) : null}

        {live && dep ? (
          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="flex items-center gap-2 text-xs font-medium">
                <Eye className="h-3.5 w-3.5" /> Trying another version
              </h4>
              {!shared ? (
                <span className="flex items-center gap-2">
                  <Label htmlFor="canary-share" className="text-xs text-muted-foreground">
                    Share
                  </Label>
                  <Input
                    id="canary-share"
                    type="number"
                    min={1}
                    max={100}
                    value={share}
                    disabled={busy}
                    onChange={(e) => setShare(e.target.value)}
                    onBlur={() => {
                      // Applied only when a canary is already running. Before
                      // that it is just the share the next one would start at,
                      // sitting in plain sight so that choosing a version can
                      // never quietly put traffic somewhere unexpected.
                      const n = Number(share);
                      if (
                        dep.candidate?.mode === "canary" &&
                        Number.isFinite(n) &&
                        n >= 1 &&
                        n <= 100 &&
                        n !== dep.candidate.percent
                      ) {
                        void setShadow(dep.candidate.version_id, "canary", n);
                      }
                    }}
                    className="h-7 w-16"
                  />
                  <select
                    aria-label="Version to try"
                    className="h-7 rounded-md border bg-background px-2 text-xs"
                    value={dep.candidate?.version_id ?? ""}
                    disabled={busy}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      if (!id) return void setShadow(null);
                      // A comparable task starts SHADOWING, which answers
                      // nobody. Where answers cannot be compared there is
                      // nothing to shadow, so it starts as a canary at the
                      // share shown next to this control.
                      const n = Number(share);
                      return void (comparable
                        ? setShadow(id, "shadow")
                        : setShadow(id, "canary", Number.isFinite(n) ? n : DEFAULT_SHARE));
                    }}
                  >
                    <option value="">Not trying one</option>
                    {versions
                      .filter((v) => v.id !== dep.version_id && v.status === "ready")
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {comparable ? "Shadow" : "Canary"} v{v.version}
                        </option>
                      ))}
                  </select>
                </span>
              ) : null}
            </div>

            {dep.rollback && !dep.candidate ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[11px] leading-relaxed text-destructive">
                <strong>Rolled back {relTime(dep.rollback.at)}.</strong>{" "}
                {dep.rollback.reason ?? "The candidate was failing."} The endpoint is serving the
                version it was serving before.
              </p>
            ) : null}

            {!dep.candidate ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                A version is normally adopted by switching to it, which means the first evidence it
                behaves differently is production behaving differently.{" "}
                {comparable
                  ? "Shadowing asks first: every request is mirrored to the candidate, its answer is thrown away, and the two are compared. Nobody waits for it and nobody is served by it. When it looks right, hand it a share of real traffic."
                  : "Cluster and anomaly labels are arbitrary between fits, so two versions' answers cannot be compared and there is nothing to shadow. A canary can still be run: it measures whether the candidate FAILS more than the version in production, which means the same thing for every task."}
              </p>
            ) : (
              <CandidateReport
                candidate={dep.candidate}
                busy={busy}
                shared={shared}
                comparable={comparable}
                onMode={(mode) => {
                  const n = Number(share);
                  void setShadow(
                    dep.candidate!.version_id,
                    mode,
                    mode === "canary" ? (Number.isFinite(n) ? n : DEFAULT_SHARE) : undefined,
                  );
                }}
              />
            )}
          </div>
        ) : null}

        {dep?.caps ? (
          <p className="text-[11px] text-muted-foreground">
            This instance allows {dep.caps.perUser} warm container
            {dep.caps.perUser === 1 ? "" : "s"} per person and {dep.caps.total} in total — copies
            included.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

type Candidate = NonNullable<MlDeploymentView["candidate"]>;

/**
 * What has been learned about the candidate, and the one control that matters.
 *
 * The mode row is deliberately two buttons rather than a toggle: the step from
 * "answers nobody" to "answers some of your callers" is the most consequential
 * thing on this panel, and it should read as a choice between two named states
 * rather than as flipping a switch.
 */
function CandidateReport({
  candidate,
  busy,
  shared,
  comparable,
  onMode,
}: {
  candidate: Candidate;
  busy: boolean;
  shared: boolean;
  comparable: boolean;
  onMode: (mode: "shadow" | "canary") => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px]">
          v{candidate.version ?? "?"}
        </Badge>
        {!shared ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant={candidate.mode === "shadow" ? "default" : "outline"}
              className="h-6 px-2 text-[11px]"
              disabled={busy || !comparable}
              title={comparable ? undefined : "Answers cannot be compared for this task"}
              onClick={() => onMode("shadow")}
            >
              Mirror only
            </Button>
            <Button
              size="sm"
              variant={candidate.mode === "canary" ? "default" : "outline"}
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={() => onMode("canary")}
            >
              Send real traffic
            </Button>
          </div>
        ) : null}
      </div>

      {candidate.mode === "shadow" ? (
        <ShadowFigures shadow={candidate.shadow} />
      ) : (
        <CanaryFigures canary={candidate.canary} percent={candidate.percent} />
      )}
    </div>
  );
}

/**
 * Agreement, which is what a SHADOW can measure.
 *
 * Leads with the verdict rather than the percentage, because a percentage on
 * forty rows invites a decision nobody has evidence for — and the whole point
 * of shadowing is to make the decision on evidence.
 */
function ShadowFigures({ shadow }: { shadow: Candidate["shadow"] }) {
  const totals: MlShadowTotals = {
    requests: shadow.requests,
    rows: shadow.rows,
    agreed: shadow.agreed,
    errors: shadow.errors,
  };
  const verdict = shadowVerdict(totals);
  const rate = agreementRate(totals);
  const short = rowsUntilVerdict(totals);

  const tone =
    verdict === "failing"
      ? "text-destructive"
      : verdict === "differs"
        ? "text-amber-600 dark:text-amber-400"
        : verdict === "agrees"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-muted-foreground";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn("font-medium", tone)}>
          {verdict === "failing"
            ? `Failing: ${shadow.errors} of ${shadow.requests} mirrored calls did not answer`
            : verdict === "waiting"
              ? `Watching — ${short} more rows before this means anything`
              : verdict === "agrees"
                ? "Answers the same as the version in production"
                : "Answers differently often enough to look at"}
        </span>
        {rate !== null && verdict !== "waiting" ? (
          <span className="tabular-nums text-muted-foreground">
            {(rate * 100).toFixed(1)}% of {shadow.rows.toLocaleString()} rows agreed
          </span>
        ) : null}
      </div>

      {shadow.last_error ? (
        <p className="text-[11px] text-destructive">Last failure: {shadow.last_error}</p>
      ) : null}

      {shadow.disagreements.length > 0 ? (
        <div>
          <p className="text-[11px] text-muted-foreground">
            Most recent rows they answered differently:
          </p>
          <ul className="mt-1 space-y-0.5">
            {shadow.disagreements.slice(0, 5).map((d, i) => (
              <li key={i} className="flex items-center gap-2 text-[11px] tabular-nums">
                <span className="text-muted-foreground">in production</span>
                <code className="font-mono">{d.primary ?? "—"}</code>
                <span className="text-muted-foreground">candidate</span>
                <code className="font-mono">{d.candidate ?? "—"}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The candidate has never answered a caller. Hand it a share of real traffic above, or switch
        to it with <strong>Redeploy</strong> once you are satisfied.
      </p>
    </div>
  );
}

/**
 * Failure, which is what a CANARY can measure — and it measures BOTH sides.
 *
 * There is no agreement figure here and there cannot be: each row was answered
 * once, by one version. Production's rate sits next to the candidate's because
 * the question is never "is it failing" but "is it failing worse than the
 * thing it would replace".
 */
function CanaryFigures({ canary, percent }: { canary: Candidate["canary"]; percent: number }) {
  const totals: MlCanaryTotals = {
    primaryRequests: canary.primaryRequests,
    primaryErrors: canary.primaryErrors,
    candidateRequests: canary.requests,
    candidateErrors: canary.errors,
  };
  const verdict = canaryVerdict(totals);
  const observed = observedShare(totals);
  const candidateRate = errorRate(canary.requests, canary.errors);
  const primaryRate = errorRate(canary.primaryRequests, canary.primaryErrors);
  const short = requestsUntilVerdict(totals);

  const tone =
    verdict === "failing"
      ? "text-destructive"
      : verdict === "endpoint-failing"
        ? "text-amber-600 dark:text-amber-400"
        : verdict === "healthy"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-muted-foreground";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn("font-medium", tone)}>
          {verdict === "watching"
            ? `Watching — ${short} more requests through the candidate`
            : verdict === "failing"
              ? "Failing more than the version in production"
              : verdict === "endpoint-failing"
                ? "Both versions are failing — this is not about the candidate"
                : "No more failures than the version in production"}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {percent}% asked for
          {observed !== null ? `, ${(observed * 100).toFixed(1)}% served` : ""}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-md border p-2">
          <p className="text-muted-foreground">Candidate</p>
          <p className="tabular-nums">
            {canary.errors} failed of {canary.requests.toLocaleString()}
            {candidateRate !== null ? ` · ${(candidateRate * 100).toFixed(1)}%` : ""}
          </p>
        </div>
        <div className="rounded-md border p-2">
          <p className="text-muted-foreground">In production</p>
          <p className="tabular-nums">
            {canary.primaryErrors} failed of {canary.primaryRequests.toLocaleString()}
            {primaryRate !== null ? ` · ${(primaryRate * 100).toFixed(1)}%` : ""}
          </p>
        </div>
      </div>

      {canary.last_error ? (
        <p className="text-[11px] text-destructive">Last failure: {canary.last_error}</p>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        These callers are being answered by the candidate. If it starts failing more than production
        does, the platform takes it out of the traffic by itself and says so here — nobody has to be
        watching. Adopt it with <strong>Redeploy</strong>, or go back to mirroring above.
      </p>
    </div>
  );
}
