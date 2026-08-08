// /monitoring — service health and hardware utilisation.
//
// Superadmin-only, and deliberately honest about what it does and does not
// know: an optional service that was never started reads "Not running", not a
// red "Down", and memory says whether the total is the container's limit or
// the host's RAM. A monitoring page that cries wolf is a page people stop
// opening.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useIsSuperadmin } from "@/hooks/use-iam";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Activity,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  ShieldAlert,
  Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  formatUptime,
  pct,
  statusTone,
  utilisationTone,
  type ServiceProbe,
  type SystemMetrics,
} from "@/lib/serviceHealth";
import { serviceHealth, systemMetrics } from "@/utils/monitoring.functions";

export const Route = createFileRoute("/_authenticated/monitoring")({
  component: MonitoringPage,
  head: () => ({ meta: [{ title: "Monitoring — AgentSwarms" }] }),
});

const REFRESH_MS = 15_000;

const TONE_CLASSES: Record<string, string> = {
  ok: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  critical: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  muted: "bg-muted text-muted-foreground",
};
const BAR_CLASSES: Record<string, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-rose-500",
};

function Gauge({
  icon: Icon,
  label,
  percent,
  primary,
  secondary,
}: {
  icon: typeof Cpu;
  label: string;
  percent: number | null;
  primary: string;
  secondary?: string;
}) {
  const tone = percent === null ? "ok" : utilisationTone(percent);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{primary}</p>
        {percent !== null && (
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="meter"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${label} utilisation`}
          >
            <div
              className={cn("h-full rounded-full transition-all", BAR_CLASSES[tone])}
              style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
            />
          </div>
        )}
        {secondary && <p className="mt-1.5 text-[11px] text-muted-foreground">{secondary}</p>}
      </CardContent>
    </Card>
  );
}

function ServiceRow({ s }: { s: ServiceProbe }) {
  const { tone, label } = statusTone(s);
  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
      <span
        className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", {
          "bg-emerald-500": tone === "ok",
          "bg-amber-500": tone === "warn",
          "bg-rose-500": tone === "critical",
          "bg-muted-foreground/40": tone === "muted",
        })}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{s.label}</p>
          <Badge className={cn("border-0 text-[10px] font-medium", TONE_CLASSES[tone])}>
            {label}
          </Badge>
          {s.optional && s.profile && (
            <span className="font-mono text-[10px] text-muted-foreground">
              --profile {s.profile}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{s.purpose}</p>
        {s.message && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{s.message}</p>
        )}
        {s.detail && Object.keys(s.detail).length > 0 && (
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
            {Object.entries(s.detail)
              .map(([k, v]) => `${k}=${v}`)
              .join(" · ")}
          </p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <p className="font-mono text-xs tabular-nums">
          {s.latencyMs === null ? "—" : `${s.latencyMs} ms`}
        </p>
        {s.endpoint && (
          <p className="max-w-[16rem] truncate font-mono text-[10px] text-muted-foreground">
            {s.endpoint}
          </p>
        )}
      </div>
    </div>
  );
}

function MonitoringPage() {
  const { user, session } = useAuth();
  const isSuperadmin = useIsSuperadmin();
  const token = session?.access_token;

  const [services, setServices] = useState<ServiceProbe[]>([]);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [h, m] = await Promise.all([
        serviceHealth({ data: { access_token: token } }),
        systemMetrics({ data: { access_token: token } }),
      ]);
      setServices(h.services);
      setCheckedAt(h.checkedAt);
      setMetrics(m);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (isSuperadmin && token) void refresh();
  }, [isSuperadmin, token, refresh]);

  useEffect(() => {
    if (!auto || !isSuperadmin) return;
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [auto, isSuperadmin, refresh]);

  if (!user) return null;

  if (!isSuperadmin) {
    return (
      <div className="p-6">
        <Card className="mx-auto mt-12 max-w-lg border-destructive/40">
          <CardContent className="p-8 text-center">
            <ShieldAlert className="mx-auto mb-3 h-10 w-10 text-destructive" />
            <h2 className="mb-1 text-lg font-semibold">Restricted area</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Service monitoring is only available to superadmins.
            </p>
            <Link to="/dashboard" className="text-sm text-primary hover:underline">
              Go back to dashboard
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const memPct = metrics ? pct(metrics.memory.usedBytes, metrics.memory.totalBytes) : null;
  const diskPct = metrics?.disk ? pct(metrics.disk.usedBytes, metrics.disk.totalBytes) : null;
  const cpuPct = metrics?.cpu.usage === null || !metrics ? null : metrics.cpu.usage * 100;
  const unhealthy = services.filter(
    (s) => s.status === "degraded" || (s.status === "down" && !s.optional),
  );

  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            Observability
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Activity className="h-6 w-6 text-primary" /> Monitoring
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Live health of every service in this deployment, and what the machine running it is
            doing right now. Optional services that were never started are listed as such rather
            than reported as failures.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch id="auto-refresh" checked={auto} onCheckedChange={setAuto} />
            <Label htmlFor="auto-refresh" className="text-xs text-muted-foreground">
              Auto-refresh
            </Label>
          </div>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {error}
        </div>
      )}

      {/* Hardware */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Gauge
          icon={Cpu}
          label="CPU"
          percent={cpuPct}
          primary={cpuPct === null ? "—" : `${cpuPct.toFixed(0)}%`}
          secondary={
            metrics
              ? `${metrics.cpu.cores} core${metrics.cpu.cores === 1 ? "" : "s"}${
                  metrics.cpu.limitCores ? ` · limit ${metrics.cpu.limitCores.toFixed(2)}` : ""
                } · load ${metrics.cpu.load.map((l) => l.toFixed(2)).join(" ")}`
              : undefined
          }
        />
        <Gauge
          icon={MemoryStick}
          label="Memory"
          percent={memPct}
          primary={
            metrics
              ? `${formatBytes(metrics.memory.usedBytes)} / ${formatBytes(metrics.memory.totalBytes)}`
              : "—"
          }
          secondary={
            metrics
              ? metrics.memory.source === "cgroup"
                ? "container limit"
                : "host memory (no container limit set)"
              : undefined
          }
        />
        <Gauge
          icon={HardDrive}
          label="Disk"
          percent={diskPct}
          primary={
            metrics?.disk
              ? `${formatBytes(metrics.disk.usedBytes)} / ${formatBytes(metrics.disk.totalBytes)}`
              : "—"
          }
          secondary={metrics?.disk ? metrics.disk.path : "not reported on this platform"}
        />
        <Gauge
          icon={Server}
          label="App process"
          percent={null}
          primary={metrics ? formatBytes(metrics.process.rssBytes) : "—"}
          secondary={
            metrics
              ? `heap ${formatBytes(metrics.process.heapUsedBytes)} / ${formatBytes(
                  metrics.process.heapTotalBytes,
                )} · up ${formatUptime(metrics.uptimeSeconds)}`
              : undefined
          }
        />
      </div>

      {/* Services */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
          <p className="text-sm font-semibold">Services</p>
          <p className="text-[11px] text-muted-foreground">
            {unhealthy.length === 0
              ? "No problems detected"
              : `${unhealthy.length} needing attention`}
            {checkedAt ? ` · checked ${new Date(checkedAt).toLocaleTimeString()}` : ""}
          </p>
        </div>
        <div className="divide-y">
          {services.length === 0 && !loading && (
            <p className="p-4 text-sm text-muted-foreground">No probe results yet.</p>
          )}
          {services.map((s) => (
            <ServiceRow key={s.id} s={s} />
          ))}
        </div>
      </Card>

      {metrics && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          {metrics.hostname} · {metrics.platform} · Node {metrics.nodeVersion} · sampled{" "}
          {new Date(metrics.sampledAt).toLocaleTimeString()}
        </p>
      )}
    </main>
  );
}
