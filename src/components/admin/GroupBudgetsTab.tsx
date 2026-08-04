// IAM → Budgets: monthly AI spend ceilings for IAM groups.
//
// The per-USER cap lives on the /budgets page (budget_settings) and the
// per-CREDENTIAL cap sits next to each embed / API key. This tab covers the
// team ceiling: spend by every member of a group, against one shared limit.
// All three are evaluated together at call time — the most restrictive wins.
//
// Rows are written directly under RLS (budget_limits allows superadmins to
// manage scope_type='group'), so no server function is needed.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Wallet } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type GroupOption = { id: string; name: string };

type BudgetLimitRow = {
  id: string;
  scope_type: string;
  alerts_enabled?: boolean;
  alert_thresholds?: number[] | null;
  scope_id: string;
  monthly_cap_usd: number;
  is_active: boolean;
};

export function GroupBudgetsTab({ groups }: { groups: GroupOption[] }) {
  const [limits, setLimits] = useState<BudgetLimitRow[] | null>(null);
  const [spend, setSpend] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const byGroup = useMemo(() => {
    const m = new Map<string, BudgetLimitRow>();
    for (const l of limits ?? []) if (l.scope_type === "group") m.set(l.scope_id, l);
    return m;
  }, [limits]);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("budget_limits")
      .select(
        "id, scope_type, scope_id, monthly_cap_usd, is_active, alerts_enabled, alert_thresholds",
      )
      .eq("scope_type", "group");
    // Via unknown: types.ts is generated from the DEPLOYED schema and the
    // alert columns ship in migration 20260782000000, so the generated row
    // type does not know them yet. Regenerating types after applying it
    // removes this.
    setLimits((data ?? []) as unknown as BudgetLimitRow[]);

    // Month-to-date spend per group = sum over its members' traces. Done
    // client-side over the admin's readable rows; the enforcement path
    // recomputes this server-side, this is only for display.
    const monthStart = new Date();
    const iso = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1),
    ).toISOString();
    const [{ data: members }, { data: traces }] = await Promise.all([
      supabase.from("iam_group_members").select("group_id, user_id"),
      supabase.from("execution_traces").select("user_id, cost_usd").gte("created_at", iso),
    ]);
    const costByUser = new Map<string, number>();
    for (const t of traces ?? []) {
      costByUser.set(t.user_id, (costByUser.get(t.user_id) ?? 0) + Number(t.cost_usd ?? 0));
    }
    const totals: Record<string, number> = {};
    for (const m of members ?? []) {
      totals[m.group_id] = (totals[m.group_id] ?? 0) + (costByUser.get(m.user_id) ?? 0);
    }
    setSpend(totals);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveCap(groupId: string) {
    const raw = drafts[groupId]?.trim() ?? "";
    setSavingId(groupId);
    try {
      const existing = byGroup.get(groupId);
      // Empty input clears the ceiling entirely rather than storing 0 — a cap
      // of zero would block the group outright, which is never what "no limit"
      // should mean.
      if (raw === "") {
        if (existing) {
          const { error } = await supabase.from("budget_limits").delete().eq("id", existing.id);
          if (error) throw error;
        }
        toast.success("Budget removed");
      } else {
        const cap = Number(raw);
        if (!Number.isFinite(cap) || cap <= 0) throw new Error("Enter an amount above 0");
        const { error } = await supabase.from("budget_limits").upsert(
          {
            scope_type: "group",
            scope_id: groupId,
            monthly_cap_usd: cap,
            is_active: existing?.is_active ?? true,
          },
          { onConflict: "scope_type,scope_id" },
        );
        if (error) throw error;
        toast.success("Budget saved");
      }
      setDrafts((d) => {
        const next = { ...d };
        delete next[groupId];
        return next;
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the budget");
    } finally {
      setSavingId(null);
    }
  }

  async function toggleActive(row: BudgetLimitRow) {
    const { error } = await supabase
      .from("budget_limits")
      .update({ is_active: !row.is_active })
      .eq("id", row.id);
    if (error) return toast.error("Could not update the budget");
    await load();
  }

  /**
   * Warning emails for this group cap, sent to superadmins at each threshold.
   *
   * Separate from "Enforced": a team can be warned without being blocked, and
   * blocked without being warned. Collapsing them into one switch would remove
   * the only safe way to introduce a cap — watch first, enforce later.
   */
  async function toggleAlerts(row: BudgetLimitRow) {
    const { error } = await supabase
      .from("budget_limits")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ alerts_enabled: !row.alerts_enabled } as any)
      .eq("id", row.id);
    if (error) return toast.error("Could not update alerts");
    await load();
  }

  return (
    <Card className="border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-4 w-4 text-primary" /> Group budgets
        </CardTitle>
        <CardDescription>
          A shared monthly ceiling for everything the group's members spend on AI. Enforcement is
          opt-in per instance (<code className="text-xs">ENFORCE_BUDGET_CAP=1</code>); when on, a
          call is refused if the user's own cap, any of their groups' caps, or the credential's cap
          is exhausted — whichever binds first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {limits === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : groups.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No groups yet — create one on the Groups tab first.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead className="w-40">Monthly cap (USD)</TableHead>
                <TableHead className="w-40">Spent this month</TableHead>
                <TableHead className="w-24">Enforced</TableHead>
                <TableHead className="w-28">Alerts</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => {
                const row = byGroup.get(g.id);
                const used = spend[g.id] ?? 0;
                const cap = row ? Number(row.monthly_cap_usd) : 0;
                const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
                const draft = drafts[g.id];
                const dirty = draft !== undefined && draft !== (cap > 0 ? String(cap) : "");
                return (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">{g.name}</TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        step="1"
                        className="h-8 text-xs"
                        placeholder="No limit"
                        value={draft ?? (cap > 0 ? String(cap) : "")}
                        onChange={(e) => setDrafts((d) => ({ ...d, [g.id]: e.target.value }))}
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          cap > 0 && used >= cap
                            ? "text-destructive"
                            : pct >= 80
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground"
                        }
                      >
                        ${used.toFixed(2)}
                        {cap > 0 && <span className="ml-1 text-[11px]">({pct}%)</span>}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row ? (
                        <Switch
                          checked={row.is_active}
                          onCheckedChange={() => void toggleActive(row)}
                        />
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          none
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {row ? (
                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={Boolean(row.alerts_enabled)}
                            onCheckedChange={() => void toggleAlerts(row)}
                          />
                          {row.alerts_enabled && (
                            <span className="text-[10px] text-muted-foreground">
                              {(row.alert_thresholds ?? [50, 75, 90]).join("/")}%
                            </span>
                          )}
                        </div>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          none
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={!dirty || savingId === g.id}
                        onClick={() => void saveCap(g.id)}
                      >
                        {savingId === g.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
