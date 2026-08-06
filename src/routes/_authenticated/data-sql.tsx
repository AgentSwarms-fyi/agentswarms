// Main IDE route for /data-sql.
// 3-pane layout: Database Explorer · SQL Editor (light) + Results · Agent Chat
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAuth } from "@/hooks/use-auth";
import { DeleteDatasetDialog } from "@/components/bi/DeleteDatasetDialog";
import { datasetDependents, type DatasetDependents } from "@/utils/dataPrep.functions";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Database,
  Play,
  Wand2,
  Upload,
  Download,
  RefreshCw,
  Loader2,
  ChevronRight,
  Table as TableIcon,
  Trash2,
  Send,
  Bot,
  User,
  Wrench,
  ChevronDown,
  AlertTriangle,
  Sparkles,
  BookOpen,
  BarChart3,
  Plus,
  Server,
  Table2,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import {
  WAREHOUSE_LABELS,
  type WarehouseConnectionSummary,
  type WarehouseTable,
} from "@/utils/warehouse/types";
import {
  hydrateFromSupabase,
  runQuery,
  deleteDataset,
  PLAYGROUND_ROW_CAP,
  type DatasetMeta,
  type QueryResult,
} from "@/lib/sqlEngine";
import { SqlEngineStatus } from "@/components/data/SqlEngineStatus";
import { downloadCsv, downloadXlsx } from "@/lib/exportData";
import { ensureSampleDataset, forceSeedSampleDataset, SAMPLE_TABLE_NAME } from "@/lib/sampleData";
import { CsvUploadDialog } from "@/components/data-sql/CsvUploadDialog";
import { QueryHistoryPanel } from "@/components/data-sql/QueryHistoryPanel";
import { recordQuery } from "@/lib/queryHistory";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  loadSemantics,
  loadSavedMetrics,
  runBiTurn,
  generateSuggestedQuestions,
  saveMetric,
  deleteMetric,
  type BiTurn,
  type SemanticEntry,
  type SavedMetric,
} from "@/lib/biAgent";
import { BiChatMessage } from "@/components/data-sql/BiChatMessage";
import { AddToDashboardDialog } from "@/components/bi/AddToDashboardDialog";
import { BiModelSelect, useBiModelPref } from "@/components/bi/BiModelSelect";
import type { BiWidgetSource } from "@/lib/biDashboards";
import { SuggestedQuestions } from "@/components/data-sql/SuggestedQuestions";
import { SemanticLayerEditor } from "@/components/data-sql/SemanticLayerEditor";
import { CatalogView } from "@/components/catalog/CatalogView";
import { extractTableRefs } from "@/lib/dataCatalog";

export const Route = createFileRoute("/_authenticated/data-sql")({
  head: () => ({
    meta: [
      { title: "Data Catalog — AgentSwarms" },
      {
        name: "description",
        content:
          "Catalog every data source — crawl warehouses and buckets, browse schemas, and query with SQL + AI agents.",
      },
    ],
  }),
  component: DataCatalogRoute,
});

// Seed passed from the Catalog's "Query data" into the IDE below.
type WorkbenchSeed = { sql: string; dataSource: string; autorun?: boolean; nonce: number };

/**
 * Page shell: Catalog (sources, crawled assets, governance) and the
 * original Data & SQL workbench (database explorer + SQL editor + BI
 * agent / SQL chat) as sibling views. Both stay mounted once visited so
 * chat history and editor state survive switching.
 */
function DataCatalogRoute() {
  const [view, setView] = useState<"catalog" | "workbench">("catalog");
  const [wbMounted, setWbMounted] = useState(false);
  const [seed, setSeed] = useState<WorkbenchSeed | null>(null);

  const switchBtn = (v: "catalog" | "workbench", icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => {
        if (v === "workbench") setWbMounted(true);
        setView(v);
      }}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        view === v
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border bg-background px-3 py-1.5">
        <h1 className="text-sm font-semibold">Data Catalog</h1>
        <div className="flex rounded-lg border border-border bg-muted/50 p-0.5">
          {switchBtn("catalog", <BookOpen className="h-3.5 w-3.5" />, "Catalog")}
          {switchBtn("workbench", <Wrench className="h-3.5 w-3.5" />, "Workbench")}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <div className={view === "catalog" ? "h-full" : "hidden"}>
          <CatalogView
            onQueryAsset={(s) => {
              setSeed({ ...s, nonce: Date.now() });
              setWbMounted(true);
              setView("workbench");
            }}
          />
        </div>
        {wbMounted && (
          <div className={view === "workbench" ? "h-full" : "hidden"}>
            <DataSqlPage seed={seed} />
          </div>
        )}
      </div>
    </div>
  );
}

type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: { name: string; args: any; result: any }[] };

// ────────────────────────────────────────────────────────────────────────────
// Lightweight SQL syntax highlighter — overlay rendered behind a transparent
// textarea. Pure regex, no editor dependency, ~1 KB.
// ────────────────────────────────────────────────────────────────────────────
const SQL_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "group",
  "by",
  "order",
  "having",
  "limit",
  "offset",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "on",
  "as",
  "and",
  "or",
  "not",
  "in",
  "is",
  "null",
  "distinct",
  "with",
  "case",
  "when",
  "then",
  "else",
  "end",
  "union",
  "all",
  "asc",
  "desc",
  "exists",
  "between",
  "like",
  "ilike",
  "over",
  "partition",
]);
const SQL_FUNCS = new Set([
  "sum",
  "count",
  "avg",
  "min",
  "max",
  "coalesce",
  "cast",
  "extract",
  "date",
  "date_part",
  "round",
  "abs",
  "length",
  "lower",
  "upper",
  "substr",
  "substring",
  "concat",
  "now",
]);

// The run handler accepts Ctrl and Cmd alike; the hint should name the one
// this keyboard actually has.
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform || "");

function highlightSql(src: string): string {
  // Escape HTML first
  const esc = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Tokenize: comments, strings, numbers, identifiers
  return esc.replace(
    /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, comment, str, num, ident) => {
      if (comment)
        return `<span class="text-slate-400 dark:text-muted-foreground italic">${comment}</span>`;
      if (str) return `<span class="text-emerald-600 dark:text-emerald-400">${str}</span>`;
      if (num) return `<span class="text-amber-600 dark:text-amber-400">${num}</span>`;
      if (ident) {
        const low = ident.toLowerCase();
        if (SQL_KEYWORDS.has(low))
          return `<span class="text-primary font-semibold">${ident}</span>`;
        if (SQL_FUNCS.has(low))
          return `<span class="text-fuchsia-600 dark:text-fuchsia-400">${ident}</span>`;
        return `<span class="text-slate-700 dark:text-foreground">${ident}</span>`;
      }
      return match;
    },
  );
}

function DataSqlPage({ seed }: { seed?: WorkbenchSeed | null }) {
  const { user, session } = useAuth();
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [loadingTables, setLoadingTables] = useState(true);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const editorScrollRef = useRef<HTMLDivElement>(null);

  // BI Agent state
  const [rightTab, setRightTab] = useState<"sql" | "bi">("bi");
  const [biTurns, setBiTurns] = useState<BiTurn[]>([]);
  const [biInput, setBiInput] = useState("");
  const [biBusy, setBiBusy] = useState(false);
  const [semantics, setSemantics] = useState<Map<string, SemanticEntry>>(new Map());
  const [savedMetrics, setSavedMetrics] = useState<SavedMetric[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [semEditorOpen, setSemEditorOpen] = useState(false);
  const [semEditorTable, setSemEditorTable] = useState<DatasetMeta | null>(null);
  const [saveMetricOpen, setSaveMetricOpen] = useState(false);
  const [pendingMetric, setPendingMetric] = useState<{ sql: string; question: string } | null>(
    null,
  );
  const [metricName, setMetricName] = useState("");
  const [metricDescription, setMetricDescription] = useState("");
  const biScrollRef = useRef<HTMLDivElement>(null);
  // Which source each BI turn ran against (index-aligned with biTurns), so
  // "Add to dashboard" records the right one even if the user switches later.
  const biTurnSourcesRef = useRef<BiWidgetSource[]>([]);
  const [addToDash, setAddToDash] = useState<{ turn: BiTurn; source: BiWidgetSource } | null>(null);
  // Text model used by the BI agent (NL → SQL, chart, narrative).
  const [biModel, setBiModel] = useBiModelPref();

  // External data warehouses (connected under /integrations → Data Warehouses).
  // dataSource: "local" (in-browser AlaSQL) or a warehouse connection id.
  const listWarehousesFn = useServerFn(listWarehouseConnections);
  const dependentsFn = useServerFn(datasetDependents);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseConnectionSummary[]>([]);
  const [whTables, setWhTables] = useState<Record<string, WarehouseTable[] | "loading" | "error">>(
    {},
  );
  const [dataSource, setDataSource] = useState<string>("local");
  // Bumped after each run so the history panel refetches.
  const [historyNonce, setHistoryNonce] = useState(0);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    listWarehousesFn({ data: { access_token: token } }).then((res) => {
      if (res.ok) setWarehouses(res.connections.filter((c) => c.is_active));
    });
  }, [session?.access_token, listWarehousesFn]);

  // Session hydration can lag the first render — arriving straight from the
  // Catalog's "Query data" link mounts this page (and fires the seeded query
  // effect) while useAuth() is still restoring the session, so reading
  // `session?.access_token` at that instant yields "" and the API 401s
  // ("Sign in to browse warehouses" → "Failed to load — retry" until a manual
  // retry). getSession() awaits supabase-js' own storage hydration, so this
  // always resolves the real token.
  async function authToken(): Promise<string> {
    if (session?.access_token) return session.access_token;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }

  async function loadWarehouseSchema(connId: string) {
    const existing = whTables[connId];
    if (existing && existing !== "error") return;
    setWhTables((s) => ({ ...s, [connId]: "loading" }));
    try {
      const resp = await fetch("/api/warehouse/schema", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await authToken()}`,
        },
        body: JSON.stringify({ connection_id: connId }),
      });
      const j = (await resp.json()) as {
        tables?: WarehouseTable[];
        message?: string;
        error?: string;
      };
      if (!resp.ok) throw new Error(j.message || j.error || "Failed to load schema");
      setWhTables((s) => ({ ...s, [connId]: j.tables ?? [] }));
    } catch (e) {
      setWhTables((s) => ({ ...s, [connId]: "error" }));
      toast.error((e as Error).message);
    }
  }

  async function runWarehouseSql(connId: string, sqlText: string): Promise<QueryResult> {
    const resp = await fetch("/api/warehouse/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await authToken()}`,
      },
      body: JSON.stringify({ connection_id: connId, sql: sqlText }),
    });
    const j = (await resp.json()) as {
      columns?: { name: string }[];
      rows?: Record<string, unknown>[];
      row_count?: number;
      truncated?: boolean;
      duration_ms?: number;
      message?: string;
      error?: string;
    };
    if (!resp.ok) throw new Error(j.message || j.error || "Warehouse query failed");
    return {
      columns: (j.columns ?? []).map((c) => c.name),
      rows: j.rows ?? [],
      row_count: j.row_count ?? 0,
      total_matched: j.row_count ?? 0,
      capped: Boolean(j.truncated),
      duration_ms: j.duration_ms ?? 0,
    };
  }

  // Apply a query seeded from the Catalog tab (source + SQL), optionally
  // executing it right away so results show without another click.
  useEffect(() => {
    if (!seed) return;
    setDataSource(seed.dataSource);
    setSql(seed.sql);
    if (seed.dataSource !== "local") void loadWarehouseSchema(seed.dataSource);
    if (!seed.autorun) return;
    (async () => {
      setRunning(true);
      setQueryError(null);
      setResult(null);
      try {
        let r: QueryResult;
        if (seed.dataSource === "local") {
          // The workbench may mount straight into a seeded query, before
          // its own load effect has hydrated the in-browser engine.
          await hydrateFromSupabase();
          r = await runQuery(seed.sql);
          auditLocalQuery(seed.sql);
        } else {
          r = await runWarehouseSql(seed.dataSource, seed.sql);
        }
        setResult(r);
      } catch (e) {
        setQueryError((e as Error).message);
      } finally {
        setRunning(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  const activeWarehouse =
    dataSource !== "local" ? (warehouses.find((w) => w.id === dataSource) ?? null) : null;

  // Warehouse tables presented in DatasetMeta shape so the BI agent can plan
  // and write SQL against them exactly like local tables.
  const warehouseDatasets: DatasetMeta[] = useMemo(() => {
    if (!activeWarehouse) return [];
    const tables = whTables[activeWarehouse.id];
    if (!tables || tables === "loading" || tables === "error") return [];
    return tables.map((t) => ({
      id: `${activeWarehouse.id}:${t.schema}.${t.name}`,
      name: `${t.schema}.${t.name}`,
      source_filename: null,
      is_sample: false,
      user_id: user?.id ?? null,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: /INT|NUM|DEC|FLOAT|DOUBLE|REAL|LONG|BIGNUMERIC/i.test(c.type)
          ? ("number" as const)
          : /DATE|TIME/i.test(c.type)
            ? ("date" as const)
            : ("string" as const),
      })),
      row_count: 0,
    }));
  }, [activeWarehouse, whTables, user?.id]);

  // Initial load: hydrate engine, then auto-seed sample if user has nothing.
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      setLoadingTables(true);
      try {
        // Load existing tables first so the UI is interactive ASAP.
        let tables = await hydrateFromSupabase();
        setDatasets(tables);
        if (tables.length > 0) {
          setActiveTable(tables.find((t) => t.name === SAMPLE_TABLE_NAME)?.name ?? tables[0].name);
        }
        setLoadingTables(false);

        // If the user has nothing, seed the samples in the background and refresh.
        if (tables.length === 0) {
          const seeded = await ensureSampleDataset(user.id);
          if (seeded) {
            toast.success("Loaded sample datasets");
            tables = await hydrateFromSupabase();
            setDatasets(tables);
            setActiveTable(SAMPLE_TABLE_NAME);
          }
        } else {
          // User already has tables — make sure both samples exist for shared use.
          // Runs in background; never blocks UI.
          ensureSampleDataset(user.id).catch(() => {});
        }
      } catch (e) {
        toast.error(`Could not load datasets: ${(e as Error).message}`);
      } finally {
        setLoadingTables(false);
      }
    })();
  }, [user?.id]);

  async function refreshTables() {
    setLoadingTables(true);
    const tables = await hydrateFromSupabase();
    setDatasets(tables);
    setLoadingTables(false);
  }

  async function handleResetSample() {
    if (!user?.id) return;
    try {
      // Shared sample is read-only for users — just re-hydrate from server.
      // If the global sample was wiped (admin only), this re-seeds it.
      await forceSeedSampleDataset(user.id);
      await refreshTables();
      toast.success("Sample dataset reloaded");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // Audit trail: local queries never touch the server, so the browser
  // records them itself (RLS only allows inserting your own events).
  function auditLocalQuery(sqlText: string) {
    if (!user?.id) return;
    void supabase
      .from("audit_events")
      .insert({
        user_id: user.id,
        action: "dataset.query",
        resource_type: "dataset",
        resource_name: extractTableRefs(sqlText).join(", ").slice(0, 200) || null,
        detail: { sql: sqlText.slice(0, 200) },
      })
      .then(() => {});
  }

  /** Save the run to the user's history — successes and failures alike, since
   *  re-running the query that broke is exactly what history is for. */
  function remember(
    sqlText: string,
    outcome: { rowCount?: number | null; durationMs?: number | null; error?: string | null },
  ) {
    if (!user?.id) return;
    void recordQuery(user.id, {
      source: dataSource === "local" ? "local" : "warehouse",
      connectionId: dataSource === "local" ? null : dataSource,
      connectionName: activeWarehouse?.name ?? null,
      sql: sqlText,
      ...outcome,
    })
      .then(() => setHistoryNonce((n) => n + 1))
      .catch(() => {});
  }

  async function handleRun() {
    if (!sql.trim()) return;
    setRunning(true);
    setQueryError(null);
    const started = Date.now();
    try {
      const r =
        dataSource === "local" ? await runQuery(sql) : await runWarehouseSql(dataSource, sql);
      if (dataSource === "local") auditLocalQuery(sql);
      setResult(r);
      remember(sql, {
        rowCount: r.row_count,
        durationMs: r.duration_ms ?? Date.now() - started,
      });
    } catch (e) {
      setQueryError((e as Error).message);
      setResult(null);
      remember(sql, { durationMs: Date.now() - started, error: (e as Error).message });
    } finally {
      setRunning(false);
    }
  }

  function handleFormat() {
    const keywords = [
      "SELECT",
      "FROM",
      "WHERE",
      "GROUP BY",
      "ORDER BY",
      "HAVING",
      "LIMIT",
      "JOIN",
      "LEFT JOIN",
      "RIGHT JOIN",
      "INNER JOIN",
      "ON",
      "AS",
      "AND",
      "OR",
      "WITH",
    ];
    let out = sql.replace(/\s+/g, " ").trim();
    keywords.forEach((kw) => {
      const re = new RegExp(`\\b${kw}\\b`, "gi");
      out = out.replace(re, kw);
    });
    ["FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT"].forEach((kw) => {
      out = out.replace(new RegExp(` ${kw} `, "g"), `\n${kw} `);
    });
    setSql(out);
  }

  function handleExport() {
    if (!result) return;
    downloadCsv(result.columns, result.rows, "query-result");
  }

  function handleExportXlsx() {
    if (!result) return;
    void downloadXlsx(result.columns, result.rows, "query-result", { sheet: "Query result" });
  }

  /** Impact list for the delete dialog (server-resolved under the user's JWT). */
  const loadDependents = useCallback(
    async (tableId: string): Promise<DatasetDependents> => {
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in");
      return (await dependentsFn({ data: { accessToken: token, tableId } })) as DatasetDependents;
    },
    [session?.access_token, dependentsFn],
  );

  async function confirmDeleteDataset(target: { id: string; name: string }) {
    await deleteDataset(target.id, target.name);
    await refreshTables();
    toast.success(`Deleted ${target.name}`);
  }

  // Chat — sends to /api/chat with sql_query enabled.
  async function handleSend() {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setChatInput("");
    const userMsg: ChatMessage = { role: "user", content: text };
    const nextChat = [...chat, userMsg];
    setChat([...nextChat, { role: "assistant", content: "" }]);
    setChatBusy(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const tableSummary = datasets
        .map((d) => `${d.name}(${d.columns.map((c) => `${c.name}:${c.type}`).join(", ")})`)
        .join("; ");
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionData.session?.access_token
            ? { Authorization: `Bearer ${sessionData.session.access_token}` }
            : {}),
        },
        body: JSON.stringify({
          provider: "openrouter",
          model: "google/gemini-3-flash-preview",
          systemPrompt:
            "You are a data analyst with access to the user's local CSV-derived tables via the sql_query tool. " +
            "Always run SQL via the tool when answering quantitative questions. Then explain the result in plain English. " +
            `Available tables: ${tableSummary || "(none)"}.`,
          temperature: 0.2,
          messages: nextChat
            .filter((m) => m.content)
            .map((m) => ({ role: m.role, content: m.content })),
          enabledTools: ["sql_query"],
        }),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`Chat failed (${resp.status})`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      const toolCalls: { name: string; args: any; result: any }[] = [];
      const toolBuf = new Map<string, { name: string; args: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              assistantText += delta.content;
              setChat((prev) => {
                const copy = [...prev];
                copy[copy.length - 1] = {
                  role: "assistant",
                  content: assistantText,
                  toolCalls: [...toolCalls],
                };
                return copy;
              });
            }
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const id = tc.id || String(tc.index ?? 0);
                const cur = toolBuf.get(id) || { name: "", args: "" };
                if (tc.function?.name) cur.name = tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                toolBuf.set(id, cur);
              }
            }
            if (parsed.tool_result) {
              try {
                const r = JSON.parse(parsed.tool_result.content || "{}");
                toolCalls.push({
                  name: parsed.tool_result.name,
                  args: parsed.tool_result.args || {},
                  result: r,
                });
                setChat((prev) => {
                  const copy = [...prev];
                  copy[copy.length - 1] = {
                    role: "assistant",
                    content: assistantText,
                    toolCalls: [...toolCalls],
                  };
                  return copy;
                });
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
      for (const [, v] of toolBuf) {
        if (v.name && !toolCalls.find((t) => t.name === v.name)) {
          try {
            toolCalls.push({ name: v.name, args: JSON.parse(v.args || "{}"), result: null });
          } catch {
            /* ignore */
          }
        }
      }
      setChat((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          role: "assistant",
          content: assistantText || "(no response)",
          toolCalls,
        };
        return copy;
      });
    } catch (e) {
      toast.error((e as Error).message);
      setChat((prev) => prev.slice(0, -1));
    } finally {
      setChatBusy(false);
    }
  }

  useEffect(() => {
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [chat]);

  useEffect(() => {
    biScrollRef.current?.scrollTo({ top: biScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [biTurns]);

  const activeDataset = useMemo(
    () => datasets.find((d) => d.name === activeTable) ?? null,
    [datasets, activeTable],
  );

  // ── BI Agent: load semantics + saved metrics + suggestions ──────────
  useEffect(() => {
    if (datasets.length === 0) return;
    (async () => {
      const [sem, mets] = await Promise.all([
        loadSemantics(datasets.map((d) => d.id)),
        loadSavedMetrics(),
      ]);
      setSemantics(sem);
      setSavedMetrics(mets);
    })();
  }, [datasets]);

  async function refreshSuggestions() {
    if (datasets.length === 0) return;
    setSuggestionsLoading(true);
    try {
      const qs = await generateSuggestedQuestions({
        datasets,
        semantics,
        metrics: savedMetrics,
        model: biModel ?? undefined,
      });
      setSuggestions(qs);
    } catch {
      /* ignore */
    } finally {
      setSuggestionsLoading(false);
    }
  }

  useEffect(() => {
    if (datasets.length > 0 && suggestions.length === 0 && !suggestionsLoading) {
      refreshSuggestions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasets.length]);

  async function handleBiSend(question?: string) {
    const q = (question ?? biInput).trim();
    if (!q || biBusy) return;
    setBiInput("");
    setBiBusy(true);
    biTurnSourcesRef.current.push(
      activeWarehouse
        ? {
            kind: "warehouse",
            connection_id: activeWarehouse.id,
            connection_name: activeWarehouse.name,
            provider: activeWarehouse.provider,
          }
        : { kind: "local" },
    );
    setBiTurns((prev) => [...prev, { question: q, status: "planning" }]);
    try {
      await runBiTurn({
        question: q,
        datasets: activeWarehouse ? warehouseDatasets : datasets,
        semantics,
        metrics: savedMetrics,
        execute: activeWarehouse
          ? (generated) => runWarehouseSql(activeWarehouse.id, generated)
          : undefined,
        dialect: activeWarehouse ? WAREHOUSE_LABELS[activeWarehouse.provider] : undefined,
        model: biModel ?? undefined,
        onUpdate: (turn) => {
          setBiTurns((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = turn;
            return copy;
          });
        },
      });
    } finally {
      setBiBusy(false);
    }
  }

  function handleOpenSemantics(d: DatasetMeta) {
    setSemEditorTable(d);
    setSemEditorOpen(true);
  }

  function handleAskSaveMetric(sql: string, question: string) {
    setPendingMetric({ sql, question });
    setMetricName("");
    setMetricDescription("");
    setSaveMetricOpen(true);
  }

  async function handleConfirmSaveMetric() {
    if (!pendingMetric || !user?.id || !metricName.trim()) return;
    try {
      await saveMetric({
        userId: user.id,
        tableId: activeDataset?.id ?? null,
        name: metricName.trim(),
        description: metricDescription.trim() || null,
        sql_expression: pendingMetric.sql,
        example_question: pendingMetric.question,
      });
      const mets = await loadSavedMetrics();
      setSavedMetrics(mets);
      toast.success(`Saved metric "${metricName}"`);
      setSaveMetricOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleDeleteMetric(id: string) {
    try {
      await deleteMetric(id);
      setSavedMetrics((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // Sync scroll between textarea and highlight overlay
  function handleEditorScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    const target = e.currentTarget;
    if (editorScrollRef.current) {
      editorScrollRef.current.scrollTop = target.scrollTop;
      editorScrollRef.current.scrollLeft = target.scrollLeft;
    }
  }

  const lineCount = Math.max(sql.split("\n").length, 1);

  return (
    <div className="flex h-full w-full max-w-full overflow-hidden bg-slate-50 text-slate-900 dark:bg-background dark:text-foreground">
      {/* ── Left: Database Explorer ─────────────────────────────── */}
      <aside className="w-64 shrink-0 border-r border-slate-200 bg-white dark:border-border dark:bg-card flex flex-col">
        <div className="px-3 py-3 border-b border-slate-200 dark:border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-teal-600 dark:text-teal-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-foreground">
              Database Explorer
            </span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground"
            onClick={refreshTables}
            title="Refresh"
          >
            <RefreshCw className={`h-3 w-3 ${loadingTables ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-muted-foreground px-2 py-1">
              Local Tables
            </p>
            {loadingTables && datasets.length === 0 ? (
              <div className="px-2 py-3 text-xs text-slate-500 flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            ) : datasets.length === 0 ? (
              <div className="px-2 py-3 text-xs text-slate-500">
                No tables yet. Upload a file to get started.
              </div>
            ) : (
              datasets.map((d) => (
                <Collapsible key={d.id} defaultOpen={d.name === activeTable}>
                  <div
                    className={`flex items-center gap-1 rounded-md px-1 py-0.5 group ${
                      d.name === activeTable
                        ? "bg-teal-100/60 dark:bg-teal-500/10"
                        : "hover:bg-slate-100 dark:hover:bg-muted"
                    }`}
                  >
                    <CollapsibleTrigger asChild>
                      <button className="flex items-center gap-1 flex-1 min-w-0 px-1 py-1 text-left">
                        <ChevronRight className="h-3 w-3 text-slate-400 dark:text-muted-foreground transition-transform data-[state=open]:rotate-90 group-data-[state=open]:rotate-90" />
                        <TableIcon
                          className={`h-3 w-3 ${d.name === activeTable ? "text-teal-600 dark:text-teal-400" : "text-slate-500 dark:text-muted-foreground"}`}
                        />
                        <span
                          className={`text-xs truncate font-mono ${
                            d.name === activeTable
                              ? "text-teal-700 dark:text-teal-300"
                              : "text-slate-700 dark:text-foreground"
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveTable(d.name);
                          }}
                        >
                          {d.name}
                        </span>
                        {d.is_sample && (
                          <Badge
                            variant="outline"
                            className="text-[8px] h-4 px-1 border-teal-300 text-teal-600 dark:border-teal-500/30 dark:text-teal-400"
                          >
                            sample
                          </Badge>
                        )}
                        {/* Lineage: a materialised prep output says so, and
                            names the flow that produces it — otherwise the
                            table looks hand-uploaded and gets edited/deleted
                            as if nothing rebuilds it. */}
                        {d.source_filename?.startsWith("prep:") && (
                          <Badge
                            variant="outline"
                            className="text-[8px] h-4 px-1 border-violet-300 text-violet-600 dark:border-violet-500/30 dark:text-violet-400"
                            title={`Rebuilt by the "${d.source_filename.slice(5)}" data-prep flow — edits here are overwritten on refresh`}
                          >
                            prep: {d.source_filename.slice(5)}
                          </Badge>
                        )}
                        {!d.is_sample && d.user_id !== user?.id && (
                          <Badge
                            variant="outline"
                            className="text-[8px] h-4 px-1 border-sky-300 text-sky-600 dark:border-sky-500/30 dark:text-sky-400"
                          >
                            shared
                          </Badge>
                        )}
                      </button>
                    </CollapsibleTrigger>
                    <button
                      onClick={() => handleOpenSemantics(d)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-primary dark:text-muted-foreground"
                      title="Edit semantic layer"
                    >
                      <BookOpen className="h-3 w-3" />
                    </button>
                    {!d.is_sample && d.user_id === user?.id && (
                      <button
                        onClick={() => setDeleteTarget({ id: d.id, name: d.name })}
                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-600 dark:text-muted-foreground dark:hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <CollapsibleContent>
                    <div className="ml-7 mr-1 mb-1 border-l border-slate-200 dark:border-border pl-2 py-0.5">
                      {d.columns.map((c) => (
                        <div
                          key={c.name}
                          className="flex items-center justify-between text-[10px] py-0.5"
                        >
                          <span className="font-mono text-slate-500 dark:text-muted-foreground truncate">
                            {c.name}
                          </span>
                          <span className="text-slate-400 dark:text-muted-foreground ml-2">
                            {c.type}
                          </span>
                        </div>
                      ))}
                      <p className="text-[9px] text-slate-400 dark:text-muted-foreground mt-1">
                        {d.row_count.toLocaleString()} rows
                      </p>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))
            )}

            {/* External warehouses — connected under /integrations */}
            {warehouses.length > 0 && (
              <div className="mt-3 border-t border-slate-200 dark:border-border pt-2">
                <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-muted-foreground">
                  External warehouses
                </p>
                {warehouses.map((w) => {
                  const tables = whTables[w.id];
                  const selected = dataSource === w.id;
                  return (
                    <div key={w.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setDataSource(selected ? "local" : w.id);
                          if (!selected) void loadWarehouseSchema(w.id);
                        }}
                        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors ${
                          selected
                            ? "bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300"
                            : "text-slate-600 hover:bg-slate-100 dark:text-foreground dark:hover:bg-accent"
                        }`}
                        title={WAREHOUSE_LABELS[w.provider]}
                      >
                        <Server className="h-3 w-3 shrink-0" />
                        <span className="flex-1 truncate font-medium">{w.name}</span>
                        <span className="text-[9px] text-slate-400 dark:text-muted-foreground">
                          {WAREHOUSE_LABELS[w.provider].split(" ")[0]}
                        </span>
                      </button>
                      {selected && (
                        <div className="ml-4 mr-1 mb-1 border-l border-slate-200 dark:border-border pl-2 py-0.5">
                          {tables === "loading" ? (
                            <p className="flex items-center gap-1 py-1 text-[10px] text-slate-400 dark:text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" /> Loading tables…
                            </p>
                          ) : tables === "error" ? (
                            <button
                              type="button"
                              className="py-1 text-[10px] text-red-500 underline-offset-2 hover:underline"
                              onClick={() => void loadWarehouseSchema(w.id)}
                            >
                              Failed to load — retry
                            </button>
                          ) : (
                            (tables ?? []).slice(0, 100).map((t) => (
                              <button
                                key={`${t.schema}.${t.name}`}
                                type="button"
                                className="flex w-full items-center gap-1 py-0.5 text-left"
                                title={t.columns.map((c) => `${c.name} ${c.type}`).join(", ")}
                                onClick={() =>
                                  setSql(`SELECT * FROM ${t.schema}.${t.name} LIMIT 50;`)
                                }
                              >
                                <TableIcon className="h-2.5 w-2.5 shrink-0 text-slate-400 dark:text-muted-foreground" />
                                <span className="truncate font-mono text-[10px] text-slate-600 dark:text-foreground">
                                  {t.schema}.{t.name}
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="max-h-56 shrink-0 border-t border-slate-200 p-2 dark:border-border">
          <QueryHistoryPanel
            userId={user?.id}
            nonce={historyNonce}
            onPick={(e) => {
              setSql(e.sql);
              // Put the source back too — replaying a warehouse query against
              // the local engine would just fail confusingly.
              if (e.source === "warehouse" && e.connection_id) {
                setDataSource(e.connection_id);
                void loadWarehouseSchema(e.connection_id);
              } else if (e.source === "local") {
                setDataSource("local");
              }
            }}
          />
        </div>

        <div className="border-t border-slate-200 dark:border-border p-2 space-y-1">
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-start h-8 text-xs bg-white border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-teal-700 dark:bg-muted dark:border-border dark:text-foreground dark:hover:bg-accent dark:hover:text-teal-300"
            onClick={() => setUploadOpen(true)}
          >
            <Upload className="h-3 w-3 mr-1.5" /> Upload data
          </Button>
          <p className="text-[9px] text-slate-400 dark:text-muted-foreground px-1 pt-1 leading-snug">
            In-memory tables · read-only SELECT · capped at {PLAYGROUND_ROW_CAP} rows
          </p>
        </div>
      </aside>

      {/* ── Center: SQL Editor + Results ─────────────────── */}
      <main className="flex-1 flex flex-col min-w-0 bg-white dark:bg-background">
        {/* SQL editor */}
        <div
          className="border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40 flex flex-col"
          style={{ height: "45%" }}
        >
          {/*
            WRAPS RATHER THAN OVERFLOWING. A flex item defaults to
            `min-width: auto`, so neither group below would shrink and this row
            spilled past the editor column — 413px of toolbar in a 310px column
            at a 1238px viewport. `overflow: visible` let it paint underneath
            the AI panel, which sits later in the DOM and so painted on top:
            RUN QUERY, the primary action of the workbench, was unclickable at
            any viewport under about 1340px. That includes 1366x768.
            `flex-wrap` lets the controls drop to a second line, `min-w-0` lets
            the dataset badge truncate, and `shrink-0` keeps the buttons intact.
          */}
          <div className="px-4 py-2.5 border-b border-slate-200 bg-white dark:border-border dark:bg-card flex flex-wrap items-center justify-between gap-y-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-6 w-6 shrink-0 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Wand2 className="h-3 w-3 text-primary" />
              </div>
              <span className="text-sm font-semibold text-slate-800 dark:text-foreground shrink-0">
                SQL Editor
              </span>
              {activeDataset && (
                <Badge
                  variant="outline"
                  className="text-[10px] h-5 max-w-[12rem] truncate border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-foreground font-mono"
                >
                  {activeDataset.name}
                </Badge>
              )}
            </div>
            {/*
              This group wraps INTERNALLY. `shrink-0` here was what kept it at
              its full 413px inside a 310px column: wrapping the toolbar alone
              was not enough, because a single flex item cannot be split, so the
              group still overflowed as one piece. The source select was 192px
              of that 413 — over half the column on its own — so it is now
              width-capped and allowed to shrink.
            */}
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              {warehouses.length > 0 && (
                <Select
                  value={dataSource}
                  onValueChange={(v) => {
                    setDataSource(v);
                    if (v !== "local") void loadWarehouseSchema(v);
                  }}
                >
                  <SelectTrigger className="h-8 w-48 min-w-0 max-w-full shrink text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local (in-browser)</SelectItem>
                    {warehouses.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name} · {WAREHOUSE_LABELS[w.provider].split(" ")[0]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={handleFormat}
                disabled={!sql.trim()}
                className="h-8 text-xs text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-foreground dark:hover:text-foreground dark:hover:bg-accent"
              >
                <Wand2 className="h-3.5 w-3.5 mr-1.5" /> Format
              </Button>
              <Button
                size="sm"
                onClick={handleRun}
                disabled={running || !sql.trim()}
                className="h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-medium shadow-sm"
              >
                {running ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                )}
                Run Query
              </Button>
            </div>
          </div>

          <div className="flex-1 relative overflow-hidden bg-white dark:bg-background">
            <div className="absolute inset-0 flex">
              {/* Line numbers gutter */}
              <div className="select-none w-12 shrink-0 bg-slate-50 border-r border-slate-200 dark:bg-muted/40 dark:border-border text-right pr-2 py-3 font-mono text-xs text-slate-400 dark:text-muted-foreground leading-6 overflow-hidden">
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>

              {/* Editor area: highlight overlay + transparent textarea */}
              <div className="flex-1 relative">
                <div
                  ref={editorScrollRef}
                  aria-hidden
                  className="absolute inset-0 overflow-auto pointer-events-none px-4 py-3 font-mono text-sm leading-6 whitespace-pre text-slate-700 dark:text-foreground"
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                  dangerouslySetInnerHTML={{
                    __html: sql ? highlightSql(sql) + "\n" : "",
                  }}
                />
                {!sql && (
                  <div className="absolute inset-0 px-4 py-3 font-mono text-sm leading-6 text-slate-400 dark:text-muted-foreground pointer-events-none">
                    -- Write a SELECT query, e.g.
                    {"\n"}-- SELECT * FROM {activeDataset?.name ?? "your_table"} LIMIT 10;
                  </div>
                )}
                <textarea
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  onScroll={handleEditorScroll}
                  spellCheck={false}
                  className="absolute inset-0 w-full h-full resize-none bg-transparent text-transparent caret-primary selection:bg-primary/30 selection:text-transparent p-0 px-4 py-3 outline-none border-0 leading-6 font-mono text-sm"
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      handleRun();
                    }
                  }}
                />
              </div>
            </div>
            <div className="absolute bottom-2 right-3 text-[10px] text-slate-400 dark:text-muted-foreground font-mono pointer-events-none bg-white/80 dark:bg-card/80 px-1.5 py-0.5 rounded">
              {IS_MAC ? "⌘" : "Ctrl"} + ↵ to run
            </div>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 flex flex-col bg-white dark:bg-background min-h-0">
          <div className="px-4 py-2.5 border-b border-slate-200 dark:border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-800 dark:text-foreground">
                Results
              </span>
              {result && (
                <>
                  <Badge
                    variant="outline"
                    className="text-[10px] h-5 border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-foreground"
                  >
                    {result.row_count} rows{" "}
                    {result.capped && `· truncated from ${result.total_matched}`}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="text-[10px] h-5 border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-foreground"
                  >
                    {result.duration_ms}ms
                  </Badge>
                </>
              )}
            </div>
            {result && result.row_count > 0 && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleExport}
                  className="h-7 text-xs text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-foreground dark:hover:text-foreground dark:hover:bg-accent"
                >
                  <Download className="h-3.5 w-3.5 mr-1.5" /> CSV
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleExportXlsx}
                  className="h-7 text-xs text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-foreground dark:hover:text-foreground dark:hover:bg-accent"
                >
                  <Download className="h-3.5 w-3.5 mr-1.5" /> Excel
                </Button>
              </>
            )}
          </div>
          {/* Renders nothing once the engine is ready — it exists to explain
              the one-off WebAssembly download, and to say so plainly if a CSP
              or proxy blocked it rather than leaving Run looking broken. */}
          <SqlEngineStatus className="mx-3 mb-2" />
          <div className="flex-1 min-w-0 w-full overflow-auto bg-slate-50/30 dark:bg-muted/30">
            {queryError ? (
              <div className="p-4">
                <Card className="bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900/40 p-3 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span className="font-mono">{queryError}</span>
                </Card>
              </div>
            ) : !result ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Table2 className="h-5 w-5" />
                </div>
                <div>
                  Press{" "}
                  <kbd className="mx-1 rounded border border-border bg-accent px-1.5 py-0.5 text-foreground shadow-sm">
                    Run Query
                  </kbd>{" "}
                  or ask the BI agent →
                </div>
              </div>
            ) : result.row_count === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500 dark:text-muted-foreground">
                No rows returned
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-200 dark:border-border hover:bg-transparent">
                    {result.columns.map((c) => (
                      <TableHead
                        key={c}
                        className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-muted-foreground font-semibold sticky top-0 bg-white dark:bg-background border-b border-slate-200 dark:border-border"
                      >
                        {c}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row, i) => (
                    <TableRow
                      key={i}
                      className="border-slate-100 dark:border-border hover:bg-primary/5"
                    >
                      {result.columns.map((c) => (
                        <TableCell
                          key={c}
                          className="text-xs text-slate-700 dark:text-foreground font-mono"
                        >
                          {row[c] === null || row[c] === undefined ? (
                            <span className="text-slate-400 dark:text-muted-foreground">null</span>
                          ) : (
                            String(row[c])
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </main>

      {/* ── Right: Agent panel (BI + SQL chat tabs) ─────────────── */}
      <aside className="w-[26rem] shrink-0 border-l border-slate-200 bg-white dark:border-border dark:bg-card flex flex-col">
        <Tabs
          value={rightTab}
          onValueChange={(v) => setRightTab(v as "sql" | "bi")}
          className="flex-1 flex flex-col min-h-0"
        >
          <div className="px-3 py-2 border-b border-slate-200 dark:border-border">
            <TabsList className="grid w-full grid-cols-2 h-8">
              <TabsTrigger value="bi" className="text-xs gap-1.5">
                <Sparkles className="h-3 w-3" /> BI Agent
              </TabsTrigger>
              <TabsTrigger value="sql" className="text-xs gap-1.5">
                <Bot className="h-3 w-3" /> SQL Chat
              </TabsTrigger>
            </TabsList>
            <p className="text-[9px] text-slate-400 dark:text-muted-foreground mt-1.5 px-1 leading-snug">
              {rightTab === "bi"
                ? "Plan → SQL → Chart → Narrative · GenBI patterns inspired by Wren AI"
                : "Free-form chat with sql_query tool"}
            </p>
          </div>

          {/* BI Agent tab */}
          <TabsContent
            value="bi"
            className="flex-1 flex flex-col min-h-0 m-0 data-[state=inactive]:hidden"
          >
            <SuggestedQuestions
              questions={suggestions}
              loading={suggestionsLoading}
              onPick={(q) => handleBiSend(q)}
              onRefresh={refreshSuggestions}
            />

            {savedMetrics.length > 0 && (
              <div className="px-3 py-1.5 border-b border-slate-200 dark:border-border bg-slate-50/40 dark:bg-muted/30">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500 mb-1">
                  <BarChart3 className="h-2.5 w-2.5 text-emerald-500" /> Saved metrics
                </div>
                <div className="flex flex-wrap gap-1">
                  {savedMetrics.map((m) => (
                    <Badge
                      key={m.id}
                      variant="outline"
                      className="text-[10px] h-5 px-1.5 border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300 group cursor-pointer"
                      onClick={() => m.example_question && handleBiSend(m.example_question)}
                      title={m.description ?? m.sql_expression}
                    >
                      {m.name}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteMetric(m.id);
                        }}
                        className="ml-1 opacity-0 group-hover:opacity-100 hover:text-red-600"
                      >
                        <Trash2 className="h-2 w-2" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div ref={biScrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
              {biTurns.length === 0 && !biBusy && (
                <div className="h-full flex flex-col items-center justify-center text-center px-4 py-10 text-slate-500">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                    <Sparkles className="h-5 w-5 text-primary" />
                  </div>
                  <p className="text-xs text-slate-700 dark:text-foreground font-medium mb-1">
                    Ask a business question
                  </p>
                  <p className="text-[10px] text-slate-500 leading-relaxed max-w-[16rem]">
                    Get a chart, narrative, and SQL — all from natural language.
                  </p>
                </div>
              )}
              {biTurns.map((t, i) => (
                <BiChatMessage
                  key={i}
                  turn={t}
                  onSaveMetric={handleAskSaveMetric}
                  onAddToDashboard={() =>
                    setAddToDash({
                      turn: t,
                      source: biTurnSourcesRef.current[i] ?? { kind: "local" },
                    })
                  }
                />
              ))}
            </div>

            <div className="border-t border-slate-200 dark:border-border p-2">
              <div className="mb-1.5">
                <BiModelSelect value={biModel} onChange={setBiModel} className="w-full" />
              </div>
              <div className="flex gap-1">
                <input
                  value={biInput}
                  onChange={(e) => setBiInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleBiSend();
                    }
                  }}
                  placeholder="e.g. Top 5 customers by revenue this quarter…"
                  className="flex-1 bg-white border border-slate-200 rounded px-2 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-primary dark:bg-background dark:border-border dark:text-foreground dark:placeholder:text-muted-foreground dark:focus:border-primary/60"
                  disabled={biBusy}
                />
                <Button
                  size="icon"
                  className="h-7 w-7 bg-primary hover:bg-primary/90 text-primary-foreground"
                  onClick={() => handleBiSend()}
                  disabled={biBusy || !biInput.trim()}
                >
                  {biBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="h-3 w-3" />
                  )}
                </Button>
              </div>
            </div>
          </TabsContent>

          {/* SQL Chat tab (existing free-form agent) */}
          <TabsContent
            value="sql"
            className="flex-1 flex flex-col min-h-0 m-0 data-[state=inactive]:hidden"
          >
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
              {chat.length === 0 && !chatBusy && (
                <div className="h-full flex flex-col items-center justify-center text-center px-4 py-10 text-slate-500">
                  <div className="h-10 w-10 rounded-full bg-violet-100 dark:bg-violet-500/10 flex items-center justify-center mb-3">
                    <Bot className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                  </div>
                  <p className="text-xs text-slate-700 dark:text-foreground font-medium mb-1">
                    Ask anything about your data
                  </p>
                  <p className="text-[10px] text-slate-500 leading-relaxed max-w-[14rem]">
                    The agent can write and run SQL against your tables. Try:{" "}
                    <span className="text-slate-700 dark:text-foreground">
                      "Top 5 products by profit"
                    </span>
                  </p>
                </div>
              )}
              {chat.map((m, i) => (
                <div
                  key={i}
                  className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : ""}`}
                >
                  <div
                    className={`h-6 w-6 rounded-full flex items-center justify-center shrink-0 ${
                      m.role === "user"
                        ? "bg-slate-200 dark:bg-accent"
                        : "bg-violet-100 dark:bg-violet-500/20"
                    }`}
                  >
                    {m.role === "user" ? (
                      <User className="h-3 w-3 text-slate-700 dark:text-foreground" />
                    ) : (
                      <Bot className="h-3 w-3 text-violet-600 dark:text-violet-400" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    {m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0 && (
                      <div className="space-y-1">
                        {m.toolCalls.map((tc, j) => (
                          <Collapsible key={j}>
                            <CollapsibleTrigger className="w-full">
                              <div className="rounded border border-teal-200 bg-teal-50 dark:border-teal-900/40 dark:bg-teal-950/30 px-2 py-1 flex items-center gap-1.5 text-[10px] text-teal-700 dark:text-teal-300">
                                <Wrench className="h-2.5 w-2.5" />
                                <span className="font-mono">{tc.name}</span>
                                <Badge
                                  variant="outline"
                                  className="text-[8px] h-3.5 px-1 border-teal-300 text-teal-700 dark:border-teal-700/50 dark:text-teal-400 ml-auto"
                                >
                                  {tc.result ? "Success" : "Pending"}
                                </Badge>
                                <ChevronDown className="h-2.5 w-2.5" />
                              </div>
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <div className="mt-1 rounded border border-slate-200 bg-slate-50 dark:border-border dark:bg-background/60 p-2 text-[10px] font-mono text-slate-600 dark:text-muted-foreground max-h-32 overflow-auto">
                                {tc.args?.sql && (
                                  <div className="text-teal-700 dark:text-teal-400 mb-1 whitespace-pre-wrap break-all">
                                    {tc.args.sql}
                                  </div>
                                )}
                                <div className="whitespace-pre-wrap break-all">
                                  {typeof tc.result === "string"
                                    ? tc.result
                                    : JSON.stringify(tc.result, null, 2).slice(0, 500)}
                                </div>
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        ))}
                      </div>
                    )}
                    {m.content && (
                      <div
                        className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${
                          m.role === "user"
                            ? "bg-slate-200 text-slate-900 dark:bg-accent dark:text-foreground ml-auto inline-block"
                            : "bg-slate-100 text-slate-800 dark:bg-muted dark:text-foreground"
                        }`}
                      >
                        {m.content}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {chatBusy && (
                <div className="flex items-center gap-2 text-[10px] text-slate-500 px-2">
                  <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 dark:border-border p-2">
              <div className="flex gap-1">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Ask about your data…"
                  className="flex-1 bg-white border border-slate-200 rounded px-2 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-violet-500 dark:bg-background dark:border-border dark:text-foreground dark:placeholder:text-muted-foreground dark:focus:border-violet-500/50"
                  disabled={chatBusy}
                />
                <Button
                  size="icon"
                  className="h-7 w-7 bg-violet-600 hover:bg-violet-500 dark:bg-violet-500 dark:hover:bg-violet-400"
                  onClick={handleSend}
                  disabled={chatBusy || !chatInput.trim()}
                >
                  <Send className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </aside>

      <CsvUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        userId={user?.id || ""}
        onUploaded={refreshTables}
      />

      {/* Insert a generated visual into a BI project */}
      <AddToDashboardDialog
        open={addToDash !== null}
        onOpenChange={(o) => !o && setAddToDash(null)}
        turn={addToDash?.turn ?? null}
        source={addToDash?.source ?? { kind: "local" }}
        userId={user?.id ?? null}
      />

      {/* Semantic layer editor */}
      <SemanticLayerEditor
        open={semEditorOpen}
        onOpenChange={setSemEditorOpen}
        dataset={semEditorTable}
        semantic={semEditorTable ? (semantics.get(semEditorTable.id) ?? null) : null}
        userId={user?.id || ""}
        onSaved={async () => {
          if (datasets.length > 0) {
            const sem = await loadSemantics(datasets.map((d) => d.id));
            setSemantics(sem);
          }
        }}
      />

      {/* Save-as-metric dialog */}
      <Dialog open={saveMetricOpen} onOpenChange={setSaveMetricOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Plus className="h-4 w-4 text-emerald-600" /> Save as metric
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={metricName}
                onChange={(e) => setMetricName(e.target.value)}
                placeholder="e.g. Top 5 customers by revenue"
                className="mt-1 text-xs"
                autoFocus
              />
            </div>
            <div>
              <Label className="text-xs">Description (optional)</Label>
              <Textarea
                value={metricDescription}
                onChange={(e) => setMetricDescription(e.target.value)}
                placeholder="What this metric represents…"
                className="mt-1 text-xs min-h-[60px]"
              />
            </div>
            {pendingMetric && (
              <div>
                <Label className="text-xs">SQL</Label>
                <pre className="mt-1 rounded border border-slate-200 bg-slate-50 dark:border-border dark:bg-background/60 p-2 text-[10px] font-mono text-teal-700 dark:text-teal-300 whitespace-pre-wrap break-all max-h-32 overflow-auto">
                  {pendingMetric.sql}
                </pre>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setSaveMetricOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleConfirmSaveMetric} disabled={!metricName.trim()}>
              Save metric
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteDatasetDialog
        target={deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        loadDependents={loadDependents}
        onConfirm={confirmDeleteDataset}
      />
    </div>
  );
}
