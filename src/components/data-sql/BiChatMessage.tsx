// Renders a single BI Agent turn: narrative + chart + collapsible SQL/data.
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis, Area, AreaChart, Cell,
} from "recharts";
import {
  Loader2, ChevronDown, Code2, Database, Sparkles, AlertTriangle, Save, BarChart3, Maximize2,
} from "lucide-react";
import type { BiTurn, ChartSpec } from "@/lib/biAgent";

const PIE_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

function statusLabel(s: BiTurn["status"]): string {
  switch (s) {
    case "planning": return "Planning…";
    case "writing_sql": return "Writing SQL…";
    case "executing": return "Running query…";
    case "charting": return "Picking a chart…";
    case "summarizing": return "Summarising…";
    case "done": return "Done";
    case "error": return "Error";
  }
}

function fmtNumber(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return String(v ?? "");
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(2);
}

function ChartRender({ chart, rows, large = false }: { chart: ChartSpec; rows: Record<string, unknown>[]; large?: boolean }) {
  const heightClass = large ? "h-[60vh]" : "h-56";
  const tickSize = large ? 12 : 10;
  const labelSize = large ? 12 : 10;
  // NOTE: design tokens in this project are raw oklch() values, not HSL
  // channels — so wrap with var() directly, never hsl(var(--token)).
  const tooltipStyle = {
    fontSize: tickSize + 1,
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: 6,
  } as const;
  const labelStyle = { color: "var(--popover-foreground)" } as const;
  const gridStroke = "var(--border)";
  const axisStroke = "var(--muted-foreground)";
  const primaryStroke = "var(--primary)";

  if (chart.type === "kpi") {
    const v = rows[0]?.[chart.valueField];
    return (
      <div className={`flex flex-col items-start ${large ? "py-12 items-center w-full" : "py-3"}`}>
        <span className={`uppercase tracking-wider text-slate-500 ${large ? "text-sm" : "text-[10px]"}`}>{chart.label || chart.valueField}</span>
        <span className={`font-semibold text-indigo-600 dark:text-indigo-400 mt-1 ${large ? "text-7xl" : "text-3xl"}`}>{fmtNumber(v)}</span>
      </div>
    );
  }

  if (chart.type === "bar") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis dataKey={chart.xField} tick={{ fontSize: tickSize, fill: axisStroke }} stroke={axisStroke} />
            <YAxis tick={{ fontSize: tickSize, fill: axisStroke }} stroke={axisStroke} tickFormatter={fmtNumber} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} cursor={{ fill: "var(--accent)", opacity: 0.3 }} />
            <Bar dataKey={chart.yField} fill={primaryStroke} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "line") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis dataKey={chart.xField} tick={{ fontSize: tickSize, fill: axisStroke }} stroke={axisStroke} />
            <YAxis tick={{ fontSize: tickSize, fill: axisStroke }} stroke={axisStroke} tickFormatter={fmtNumber} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
            <Line type="monotone" dataKey={chart.yField} stroke={primaryStroke} strokeWidth={2} dot={{ r: 3, fill: primaryStroke }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "area") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis dataKey={chart.xField} tick={{ fontSize: tickSize, fill: axisStroke }} stroke={axisStroke} />
            <YAxis tick={{ fontSize: tickSize, fill: axisStroke }} stroke={axisStroke} tickFormatter={fmtNumber} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
            <Area type="monotone" dataKey={chart.yField} stroke={primaryStroke} fill={primaryStroke} fillOpacity={0.2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "pie") {
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey={chart.valueField}
              nameKey={chart.nameField}
              cx="50%" cy="50%" outerRadius={large ? "70%" : 75}
              label={(entry: any) => `${entry[chart.nameField]}`}
              labelLine={false}
            >
              {rows.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} itemStyle={labelStyle} />
            <Legend wrapperStyle={{ fontSize: labelSize, color: axisStroke }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return null;
}

export function BiChatMessage({
  turn,
  onSaveMetric,
}: {
  turn: BiTurn;
  onSaveMetric?: (sql: string, question: string) => void;
}) {
  const [showSql, setShowSql] = useState(false);
  const [showData, setShowData] = useState(false);
  const [enlarged, setEnlarged] = useState(false);

  const hasChart = turn.chart && turn.chart.type !== "table" && turn.result && turn.result.row_count > 0;

  return (
    <div className="space-y-2">
      {/* User question */}
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100 px-3 py-2 text-xs">
          {turn.question}
        </div>
      </div>

      {/* In-progress indicator */}
      {turn.status !== "done" && turn.status !== "error" && (
        <div className="flex items-center gap-2 text-[10px] text-slate-500 px-2">
          <Loader2 className="h-3 w-3 animate-spin text-indigo-500" />
          <span>{statusLabel(turn.status)}</span>
        </div>
      )}

      {/* Error */}
      {turn.status === "error" && (
        <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/30 p-2 flex items-start gap-2 text-[11px] text-red-700 dark:text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{turn.error}</span>
        </div>
      )}

      {/* Plan chip */}
      {turn.plan && (
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800/50 dark:bg-indigo-950/30 dark:text-indigo-300">
            <Sparkles className="h-2 w-2 mr-1" />
            {turn.plan.intent}
          </Badge>
          {turn.plan.tables?.map((t) => (
            <Badge key={t} variant="outline" className="text-[9px] h-4 px-1.5 border-slate-200 text-slate-600 font-mono dark:border-slate-700 dark:text-slate-400">
              {t}
            </Badge>
          ))}
        </div>
      )}

      {/* Chart card */}
      {hasChart && turn.chart && turn.result && (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
              <BarChart3 className="h-3 w-3" />
              <span className="uppercase tracking-wider">{turn.chart.type} chart</span>
            </div>
            <div className="flex items-center gap-1">
              <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-slate-200 text-slate-500">
                {turn.result.row_count} rows
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-slate-500 hover:text-indigo-600"
                onClick={() => setEnlarged(true)}
                title="Enlarge chart"
              >
                <Maximize2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <ChartRender chart={turn.chart} rows={turn.result.rows} />
        </div>
      )}

      {/* Enlarged chart dialog */}
      {hasChart && turn.chart && turn.result && (
        <Dialog open={enlarged} onOpenChange={setEnlarged}>
          <DialogContent className="max-w-[95vw] w-[95vw] sm:max-w-6xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-indigo-500" />
                <span className="truncate">{turn.question}</span>
                <Badge variant="outline" className="text-[10px] ml-auto mr-6 shrink-0">
                  {turn.chart.type} · {turn.result.row_count} rows
                </Badge>
              </DialogTitle>
            </DialogHeader>
            <div className="w-full">
              <ChartRender chart={turn.chart} rows={turn.result.rows} large />
            </div>
            {turn.narrative && (
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mt-2">
                {turn.narrative}
              </p>
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* Narrative */}
      {turn.narrative && (
        <div className="rounded-lg bg-slate-100 dark:bg-slate-800/60 px-3 py-2 text-xs text-slate-800 dark:text-slate-200 leading-relaxed">
          {turn.narrative}
        </div>
      )}

      {/* SQL + data toggles */}
      {turn.sql && (
        <div className="space-y-1">
          <Collapsible open={showSql} onOpenChange={setShowSql}>
            <CollapsibleTrigger className="w-full">
              <div className="rounded border border-teal-200 bg-teal-50 dark:border-teal-900/40 dark:bg-teal-950/30 px-2 py-1 flex items-center gap-1.5 text-[10px] text-teal-700 dark:text-teal-300">
                <Code2 className="h-2.5 w-2.5" />
                <span>View SQL</span>
                <ChevronDown className={`h-2.5 w-2.5 ml-auto transition-transform ${showSql ? "rotate-180" : ""}`} />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-1 rounded border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/60 p-2 text-[10px] font-mono text-teal-700 dark:text-teal-300 whitespace-pre-wrap break-all">
                {turn.sql}
              </pre>
              {onSaveMetric && turn.status === "done" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[10px] mt-1 text-slate-500 hover:text-indigo-600"
                  onClick={() => onSaveMetric(turn.sql!, turn.question)}
                >
                  <Save className="h-2.5 w-2.5 mr-1" /> Save as metric
                </Button>
              )}
            </CollapsibleContent>
          </Collapsible>

          {turn.result && turn.result.row_count > 0 && (
            <Collapsible open={showData} onOpenChange={setShowData}>
              <CollapsibleTrigger className="w-full">
                <div className="rounded border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40 px-2 py-1 flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-400">
                  <Database className="h-2.5 w-2.5" />
                  <span>View data ({turn.result.row_count} rows)</span>
                  <ChevronDown className={`h-2.5 w-2.5 ml-auto transition-transform ${showData ? "rotate-180" : ""}`} />
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 max-h-48 overflow-auto rounded border border-slate-200 dark:border-slate-800">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {turn.result.columns.map((c) => (
                          <TableHead key={c} className="text-[9px] uppercase tracking-wider sticky top-0 bg-slate-50 dark:bg-slate-900">
                            {c}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {turn.result.rows.slice(0, 50).map((row, i) => (
                        <TableRow key={i}>
                          {turn.result!.columns.map((c) => (
                            <TableCell key={c} className="text-[10px] font-mono py-1">
                              {row[c] === null || row[c] === undefined
                                ? <span className="text-slate-400">null</span>
                                : typeof row[c] === "number"
                                  ? fmtNumber(row[c])
                                  : String(row[c])}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      )}
    </div>
  );
}
