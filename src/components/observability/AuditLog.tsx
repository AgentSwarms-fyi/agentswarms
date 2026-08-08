// Audit trail viewer: who did what, when. Merges activity events
// (dashboard views, dataset/warehouse queries, catalog crawls) with
// every model call from execution_traces. Regular users see their own
// trail; superadmins see all users with emails and can configure the
// retention window (events are purged hourly past it).
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Bot,
  Clock,
  Database,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Network,
  Radar,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import {
  auditChainVerify,
  auditListEvents,
  auditSetRetention,
  type AuditRow,
} from "@/utils/audit.functions";

const ACTION_META: Record<string, { label: string; className: string }> = {
  "model.call": { label: "model call", className: "bg-primary/10 text-primary" },
  "agent.chat": {
    label: "agent chat",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  "swarm.run": {
    label: "swarm run",
    className: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  },
  "dataset.query": {
    label: "dataset query",
    className: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  },
  "warehouse.query": {
    label: "warehouse query",
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  "dashboard.view": {
    label: "dashboard view",
    className: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  "catalog.crawl": {
    label: "catalog crawl",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  // Authorization denials on the internet-facing surfaces (embeds, swarm API
  // keys). Styled as destructive because these are security signals, not
  // routine activity.
  "embed.access.denied": {
    label: "embed denied",
    className: "bg-destructive/10 text-destructive",
  },
  "swarm.api_key.denied": {
    label: "API key denied",
    className: "bg-destructive/10 text-destructive",
  },
};

function actionIcon(action: string) {
  switch (action) {
    case "model.call":
      return <Bot className="h-3.5 w-3.5" />;
    case "agent.chat":
      return <MessageSquare className="h-3.5 w-3.5" />;
    case "swarm.run":
      return <Network className="h-3.5 w-3.5" />;
    case "dashboard.view":
      return <LayoutDashboard className="h-3.5 w-3.5" />;
    case "warehouse.query":
      return <Server className="h-3.5 w-3.5" />;
    case "catalog.crawl":
      return <Radar className="h-3.5 w-3.5" />;
    default:
      return <Database className="h-3.5 w-3.5" />;
  }
}

function describeDetail(r: AuditRow): string {
  const d = (r.detail ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof d.surface === "string") bits.push(String(d.surface));
  if (typeof d.tokens === "number" && d.tokens > 0) bits.push(`${d.tokens.toLocaleString()} tok`);
  if (typeof d.cost_usd === "number" && d.cost_usd > 0)
    bits.push(`$${Number(d.cost_usd).toFixed(4)}`);
  if (typeof d.model === "string") bits.push(String(d.model));
  if (Array.isArray(d.tables) && d.tables.length > 0) bits.push(`tables: ${d.tables.join(", ")}`);
  if (typeof d.steps === "number") bits.push(`${d.steps} steps`);
  if (typeof d.rows === "number") bits.push(`${d.rows} rows`);
  if (typeof d.assets === "number") bits.push(`${d.assets} assets`);
  if (typeof d.sql === "string") bits.push(String(d.sql));
  if (d.status === "error") bits.push("ERROR");
  return bits.join(" · ");
}

export function AuditLog() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listFn = useServerFn(auditListEvents);
  const retentionFn = useServerFn(auditSetRetention);
  const verifyFn = useServerFn(auditChainVerify);

  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [retention, setRetention] = useState(14);
  const [retentionInput, setRetentionInput] = useState("14");
  const [savingRetention, setSavingRetention] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [action, setAction] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (actionFilter: string) => {
      if (!token) return;
      setLoading(true);
      try {
        const res = await listFn({
          data: {
            access_token: token,
            action: actionFilter === "all" ? undefined : actionFilter,
          },
        });
        if (!res.ok) throw new Error(res.error);
        setRows(res.rows);
        setIsAdmin(res.is_admin);
        setRetention(res.retention_days);
        setRetentionInput(String(res.retention_days));
      } catch (e) {
        toast.error((e as Error).message);
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [token, listFn],
  );

  useEffect(() => {
    void load(action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, action]);

  async function saveRetention() {
    const days = Number(retentionInput);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return toast.error("Retention must be 1–365 days");
    }
    setSavingRetention(true);
    try {
      const res = await retentionFn({ data: { access_token: token, days } });
      if (!res.ok) throw new Error(res.error);
      setRetention(days);
      toast.success(`Audit events now kept for ${days} days`);
      await load(action);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingRetention(false);
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = (rows ?? []).filter((r) => {
    if (!q) return true;
    return `${r.user_email ?? ""} ${r.action} ${r.resource_name ?? ""} ${describeDetail(r)}`
      .toLowerCase()
      .includes(q);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAdmin ? "Search user, resource, detail…" : "Search resource, detail…"}
            className="h-8 w-72 pl-8 text-xs"
          />
        </div>
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              All activity
            </SelectItem>
            {Object.entries(ACTION_META).map(([value, meta]) => (
              <SelectItem key={value} value={value} className="text-xs">
                {meta.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2.5 text-xs"
          onClick={() => void load(action)}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" /> Events kept for {retention} days
        </span>
        {isAdmin && (
          <span className="flex items-center gap-1.5">
            <Input
              value={retentionInput}
              onChange={(e) => setRetentionInput(e.target.value)}
              className="h-7 w-16 text-xs"
              inputMode="numeric"
              title="Retention window in days (1–365)"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={savingRetention || Number(retentionInput) === retention}
              onClick={() => void saveRetention()}
            >
              {savingRetention ? <Loader2 className="h-3 w-3 animate-spin" /> : "Set"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={verifying}
              title="Recompute the audit hash chain — detects any event edited or deleted in place"
              onClick={async () => {
                if (!token) return;
                setVerifying(true);
                try {
                  const res = await verifyFn({ data: { access_token: token } });
                  if (!res.ok) toast.error(res.error);
                  else if (res.firstBrokenSeq === null)
                    toast.success(`Chain intact — ${res.checked} events verified`);
                  else
                    toast.error(
                      `Chain BROKEN at sequence ${res.firstBrokenSeq} — an event was altered or removed`,
                      { duration: Infinity },
                    );
                } finally {
                  setVerifying(false);
                }
              }}
            >
              {verifying ? <Loader2 className="h-3 w-3 animate-spin" /> : "Verify integrity"}
            </Button>
          </span>
        )}
      </div>

      {rows === null ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-xs text-muted-foreground">
          No audit events in the retention window{q ? " match the search" : ""}.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36 text-xs">When</TableHead>
                {isAdmin && <TableHead className="text-xs">User</TableHead>}
                <TableHead className="w-40 text-xs">Action</TableHead>
                <TableHead className="text-xs">Resource</TableHead>
                <TableHead className="text-xs">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => {
                const meta = ACTION_META[r.action] ?? {
                  label: r.action,
                  className: "bg-muted text-muted-foreground",
                };
                return (
                  <TableRow key={r.id}>
                    <TableCell
                      className="whitespace-nowrap text-[11px] text-muted-foreground"
                      title={new Date(r.created_at).toLocaleString()}
                    >
                      {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="max-w-48 truncate text-xs">
                        {r.user_email ?? (r.user_id ? r.user_id.slice(0, 8) : "deleted account")}
                      </TableCell>
                    )}
                    <TableCell>
                      <Badge
                        className={`gap-1 border-0 text-[10px] font-medium hover:bg-transparent ${meta.className}`}
                      >
                        {actionIcon(r.action)}
                        {meta.label}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="max-w-64 truncate font-mono text-[11px]"
                      title={r.resource_name ?? undefined}
                    >
                      {r.resource_name ?? "—"}
                    </TableCell>
                    <TableCell
                      className="max-w-80 truncate text-[11px] text-muted-foreground"
                      title={describeDetail(r)}
                    >
                      {describeDetail(r)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <ShieldCheck className="h-3 w-3" />
        {isAdmin
          ? "You see all users' activity as a superadmin. Events past the retention window are purged automatically."
          : "You see your own activity. Administrators can see instance-wide activity."}
      </p>
    </div>
  );
}
