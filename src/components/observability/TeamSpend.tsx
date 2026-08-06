// Admin-only "Team spend" section for /analytics: AI model spend broken
// down by user and by IAM group so operators can see who is spending
// what. Aggregation runs server-side over execution_traces (superadmin
// gate); renders nothing for regular users.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, ShieldCheck, Users as UsersIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useAuth } from "@/hooks/use-auth";
import { useIsSuperadmin } from "@/hooks/use-iam";
import {
  adminSpendBreakdown,
  type GroupSpendRow,
  type UserSpendRow,
} from "@/utils/audit.functions";

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function TeamSpend() {
  const isAdmin = useIsSuperadmin();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const spendFn = useServerFn(adminSpendBreakdown);

  const [days, setDays] = useState(30);
  const [users, setUsers] = useState<UserSpendRow[] | null>(null);
  const [groups, setGroups] = useState<GroupSpendRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isAdmin || !token) return;
    setLoading(true);
    spendFn({ data: { access_token: token, days } })
      .then((res) => {
        if (!res.ok) throw new Error(res.error);
        setUsers(res.users);
        setGroups(res.groups);
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [isAdmin, token, days, spendFn]);

  if (!isAdmin) return null;

  const totalCost = (users ?? []).reduce((s, u) => s + u.cost, 0);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" /> Team spend
            <Badge variant="secondary" className="text-[10px]">
              admin
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            AI model spend per user and per IAM group across the whole instance —{" "}
            {loading ? "…" : `$${totalCost.toFixed(2)} total in the selected range`}.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r.days} value={String(r.days)} className="text-xs">
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            By user
          </p>
          {users === null ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
          ) : users.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No model calls in this range.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">User</TableHead>
                  <TableHead className="text-right text-xs">Calls</TableHead>
                  <TableHead className="text-right text-xs">Tokens</TableHead>
                  <TableHead className="text-right text-xs">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.slice(0, 12).map((u) => (
                  <TableRow key={u.user_id}>
                    <TableCell className="max-w-52 truncate text-xs">
                      {/* No email means the account is gone; its traces are
                          kept for accounting. A bare UUID prefix reads like a
                          rendering bug, so say what it is. */}
                      {u.email ?? (
                        <span
                          className="text-muted-foreground"
                          title={`Deleted account · id ${u.user_id}`}
                        >
                          {u.user_id.slice(0, 8)} · deleted user
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {u.calls.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {fmtTokens(u.tokens)}
                    </TableCell>
                    <TableCell className="text-right text-xs font-medium tabular-nums">
                      ${u.cost.toFixed(4)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        <div>
          <p className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <UsersIcon className="h-3 w-3" /> By group
          </p>
          {groups.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No IAM groups yet — create them under /admin/iam to roll spend up by team.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Group</TableHead>
                  <TableHead className="text-right text-xs">Members</TableHead>
                  <TableHead className="text-right text-xs">Calls</TableHead>
                  <TableHead className="text-right text-xs">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.group_id}>
                    <TableCell className="text-xs font-medium">{g.name}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{g.members}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {g.calls.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right text-xs font-medium tabular-nums">
                      ${g.cost.toFixed(4)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground lg:col-span-2">
          A user belonging to several groups counts toward each of them. Spend comes from execution
          traces (every model call across chat, agents, swarms, BI and background jobs).
        </p>
      </CardContent>
    </Card>
  );
}
