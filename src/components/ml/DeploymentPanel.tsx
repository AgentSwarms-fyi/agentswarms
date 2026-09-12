// The model's warm inference endpoint: is it up, on which version, and what
// happens when nobody calls it.
//
// A deployment is a container holding this model in memory. It is off by
// default and costs real memory while it is on, so the panel leads with the
// trade rather than a switch with no explanation.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, Play, Square, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { relTime } from "@/components/ml/mlUi";
import {
  mlDeploy,
  mlDeploymentGet,
  mlDeploymentUpdate,
  mlUndeploy,
  type MlDeploymentView,
} from "@/utils/mlOps.functions";

export function DeploymentPanel({
  token,
  modelId,
  task,
  shared,
  hasReadyVersion,
}: {
  token: string;
  modelId: string;
  task: string;
  shared: boolean;
  hasReadyVersion: boolean;
}) {
  const getFn = useServerFn(mlDeploymentGet);
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
