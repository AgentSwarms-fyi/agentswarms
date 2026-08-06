import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Bell, AlertTriangle, DollarSign } from "lucide-react";
import { monthStartIso, mySpendSince } from "@/lib/budgetSpendClient";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/budgets")({
  component: BudgetsPage,
});

type Budget = {
  id: string;
  monthly_cap_usd: number;
  alerts_enabled: boolean;
  alert_thresholds: number[];
};

type Agent = {
  id: string;
  name: string;
  is_active: boolean;
};

type AgentLimit = {
  id: string;
  agent_id: string;
  max_spend_per_day_usd: number;
  auto_disable_on_limit: boolean;
};

const THRESHOLD_PRESETS = [
  { label: "90% only", value: "90" },
  { label: "75% and 90%", value: "75,90" },
  { label: "50%, 75%, 90%", value: "50,75,90" },
  { label: "25%, 50%, 75%, 90%", value: "25,50,75,90" },
];

function BudgetsPage() {
  const { user } = useAuth();
  const [budget, setBudget] = useState<Budget | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [limits, setLimits] = useState<Record<string, AgentLimit>>({});
  // null = the figure could not be computed. Deliberately distinct from 0,
  // which would otherwise render "spent nothing" when the query failed.
  const [mtdSpend, setMtdSpend] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      // Load or create budget
      const { data: budgetRow } = await supabase.from("budget_settings").select("*").maybeSingle();

      if (budgetRow) {
        setBudget(budgetRow as Budget);
      } else {
        const { data: created } = await supabase
          .from("budget_settings")
          .insert({ user_id: user.id })
          .select()
          .single();
        if (created) setBudget(created as Budget);
      }

      // Load agents
      const { data: agentsRows } = await supabase.from("agents").select("id, name, is_active");
      setAgents((agentsRows ?? []) as Agent[]);

      // Load limits
      const { data: limitRows } = await supabase.from("agent_limits").select("*");
      const map: Record<string, AgentLimit> = {};
      (limitRows ?? []).forEach((l: any) => {
        map[l.agent_id] = l;
      });
      setLimits(map);

      // MTD spend, aggregated in the database. This used to select every trace
      // row for the month and add cost_usd up here, which silently rendered a
      // truncated prefix — or a failed query's empty array — as the month's
      // total. See src/lib/budgetSpendClient.ts.
      const spend = await mySpendSince(user.id, monthStartIso());
      setMtdSpend(spend.ok ? spend.spend : null);

      setLoading(false);
    })();
  }, [user]);

  const updateBudget = async (patch: Partial<Budget>) => {
    if (!budget) return;
    setBudget({ ...budget, ...patch });
    await supabase.from("budget_settings").update(patch).eq("id", budget.id);
  };

  const upsertLimit = async (agent_id: string, patch: Partial<AgentLimit>) => {
    if (!user) return;
    const existing = limits[agent_id];
    if (existing) {
      const updated = { ...existing, ...patch };
      setLimits({ ...limits, [agent_id]: updated });
      await supabase.from("agent_limits").update(patch).eq("id", existing.id);
    } else {
      const newRow = {
        user_id: user.id,
        agent_id,
        max_spend_per_day_usd: patch.max_spend_per_day_usd ?? 10,
        auto_disable_on_limit: patch.auto_disable_on_limit ?? false,
      };
      const { data } = await supabase.from("agent_limits").insert(newRow).select().single();
      if (data) setLimits({ ...limits, [agent_id]: data as AgentLimit });
    }
  };

  if (loading || !budget) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  const cap = Number(budget.monthly_cap_usd);
  const pct = cap > 0 && mtdSpend != null ? Math.min(100, (mtdSpend / cap) * 100) : 0;
  const isOver = pct >= 100;
  const isWarn = pct >= 75;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Observability
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Budgets & Guardrails</h1>
        <p className="text-muted-foreground mt-1">
          Set spend caps and automated guardrails for your agent fleet.
        </p>
      </div>

      {/* Global Budget */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-primary" />
            Monthly Hard Cap
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Agents will refuse new requests once this cap is reached.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[1fr_180px] items-end">
            <div className="space-y-2">
              <Label className="text-xs">Cap amount</Label>
              <Slider
                value={[cap]}
                min={10}
                max={5000}
                step={10}
                onValueChange={(v) => updateBudget({ monthly_cap_usd: v[0] })}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">USD / month</Label>
              <Input
                type="number"
                min={10}
                step={10}
                value={cap}
                onChange={(e) => updateBudget({ monthly_cap_usd: Number(e.target.value) })}
                className="font-mono"
              />
            </div>
          </div>

          <div className="space-y-1.5 pt-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                Month-to-date spend:{" "}
                <span className="font-mono font-semibold text-foreground">
                  {mtdSpend == null ? "unavailable" : `$${mtdSpend.toFixed(2)}`}
                </span>{" "}
                / ${cap.toFixed(2)}
              </span>
              <Badge
                variant="outline"
                className={
                  isOver
                    ? "text-red-400 border-red-500/30"
                    : isWarn
                      ? "text-amber-400 border-amber-500/30"
                      : "text-emerald-400 border-emerald-500/30"
                }
              >
                {pct.toFixed(1)}% used
              </Badge>
            </div>
            <Progress
              value={pct}
              className={`h-2 ${isOver ? "[&>*]:bg-red-500" : isWarn ? "[&>*]:bg-amber-500" : ""}`}
            />
          </div>
        </CardContent>
      </Card>

      {/* Alerts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            Spend Alerts
          </CardTitle>
          <p className="text-xs text-muted-foreground">Get notified before you hit your cap.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Enable Spend Alerts</Label>
              <p className="text-xs text-muted-foreground">
                Email notifications at the selected thresholds.
              </p>
            </div>
            <Switch
              checked={budget.alerts_enabled}
              onCheckedChange={(v) => updateBudget({ alerts_enabled: v })}
            />
          </div>

          {budget.alerts_enabled && (
            <div className="space-y-2">
              <Label className="text-xs">Alert thresholds</Label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {THRESHOLD_PRESETS.map((p) => {
                  const current = budget.alert_thresholds.join(",");
                  const isSelected = current === p.value;
                  return (
                    <Button
                      key={p.value}
                      variant={isSelected ? "default" : "outline"}
                      size="sm"
                      className="h-9 text-xs"
                      onClick={() =>
                        updateBudget({ alert_thresholds: p.value.split(",").map(Number) })
                      }
                    >
                      {p.label}
                    </Button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground pt-1">
                You'll be alerted when spend crosses each threshold.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-agent limits */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-primary" />
            Agent-Specific Limits
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Cap daily spend per agent and optionally auto-disable on limit reached.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {agents.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No agents yet. Create one in the Agent Builder first.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="w-[180px]">Max Spend / Day</TableHead>
                  <TableHead className="w-[200px] text-center">Auto-Disable on Limit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((a) => {
                  const lim = limits[a.id];
                  return (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{a.name}</span>
                          {a.is_active ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] text-emerald-400 border-emerald-500/30"
                            >
                              Active
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              Inactive
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">$</span>
                          <Input
                            type="number"
                            min={0}
                            step={0.5}
                            value={lim?.max_spend_per_day_usd ?? 10}
                            onChange={(e) =>
                              upsertLimit(a.id, { max_spend_per_day_usd: Number(e.target.value) })
                            }
                            className="h-8 font-mono"
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={lim?.auto_disable_on_limit ?? false}
                          onCheckedChange={(v) => upsertLimit(a.id, { auto_disable_on_limit: v })}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={() => toast.success("All settings auto-saved")}
          variant="outline"
          size="sm"
        >
          Settings auto-save on change
        </Button>
      </div>
    </div>
  );
}
