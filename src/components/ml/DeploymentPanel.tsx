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
  const deployFn = useServerFn(mlDeploy);
  const undeployFn = useServerFn(mlUndeploy);
  const updateFn = useServerFn(mlDeploymentUpdate);

  const [dep, setDep] = useState<MlDeploymentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ttl, setTtl] = useState("15");

  const load = useCallback(async () => {
    const res = await getFn({ data: { accessToken: token, modelId } });
    if (res.ok) {
      setDep(res.deployment);
      if (res.deployment) setTtl(String(res.deployment.idle_ttl_minutes));
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

  async function patch(next: { keep_warm?: boolean; idle_ttl_minutes?: number }) {
    setBusy(true);
    try {
      const res = await updateFn({ data: { accessToken: token, modelId, ...next } });
      if (!res.ok) return toast.error(res.error);
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

        {!live && dep?.caps ? (
          <p className="text-[11px] text-muted-foreground">
            This instance allows {dep.caps.perUser} warm endpoint
            {dep.caps.perUser === 1 ? "" : "s"} per person and {dep.caps.total} in total.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
