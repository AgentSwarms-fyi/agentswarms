// The paginated report designer.
//
// Three columns: the blocks in order, the pages as they will print, and the
// page setup. The middle one is the point — it paginates with the same
// function the PDF renderer uses, so a break you see is a break you get.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Download,
  FileText,
  LayoutDashboard,
  Loader2,
  Minus,
  Plus,
  Save,
  Sparkles,
  Table2,
  Trash2,
  Type,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { AddFromDashboardDialog } from "@/components/bi/AddFromDashboardDialog";
import { GenerateReportDialog } from "@/components/bi/GenerateReportDialog";
import { ReportPagePreview } from "@/components/bi/ReportPagePreview";
import type { BiDataContext } from "@/components/bi/biDataContext";
import { useAuth } from "@/hooks/use-auth";
import {
  loadSavedMetrics,
  loadSemantics,
  type SavedMetric,
  type SemanticEntry,
} from "@/lib/biAgent";
import { hydrateFromSupabase, type DatasetMeta } from "@/lib/sqlEngine";
import {
  BLOCK_LABEL,
  PAGE_SIZES,
  newBlockId,
  validateReport,
  type BiReport,
  type ReportBand,
  type ReportBlock,
} from "@/lib/biReports";
import { biReportGet, biReportSave } from "@/utils/biReports.functions";

export const Route = createFileRoute("/_authenticated/bi_/report/$reportId")({
  component: ReportDesigner,
});

function ReportDesigner() {
  const { reportId } = Route.useParams();
  const { session, user } = useAuth();
  const token = session?.access_token ?? "";
  const getFn = useServerFn(biReportGet);
  const saveFn = useServerFn(biReportSave);

  const [report, setReport] = useState<BiReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Only what the generator needs: it plans and answers against local
  // datasets, the same path the dashboard's "table" source takes.
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [semantics, setSemantics] = useState<Map<string, SemanticEntry>>(new Map());
  const [metrics, setMetrics] = useState<SavedMetric[]>([]);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      const res = await getFn({ data: { accessToken: token, id: reportId } });
      if (!res.ok) toast.error(res.error);
      else {
        setReport({
          id: res.report.id,
          name: res.report.name,
          description: res.report.description,
          page: res.report.page,
          header: res.report.header,
          footer: res.report.footer,
          blocks: (res.report.blocks ?? []) as unknown as ReportBlock[],
        });
      }
      setLoading(false);
    })();
  }, [getFn, token, reportId]);

  useEffect(() => {
    if (!user?.id) return;
    void (async () => {
      try {
        const tables = await hydrateFromSupabase();
        setDatasets(tables);
        const [sem, mets] = await Promise.all([
          loadSemantics(tables.map((d) => d.id)),
          loadSavedMetrics(),
        ]);
        setSemantics(sem);
        setMetrics(mets);
      } catch {
        // The designer still works without them; only generation needs them.
      }
    })();
  }, [user?.id]);

  const ctx = useMemo<BiDataContext>(
    () => ({
      userId: user?.id ?? null,
      datasets,
      semantics,
      metrics,
      warehouses: [],
      whTables: {},
      ensureSchema: () => {},
      runSql: async () => {
        throw new Error("A report generates from local datasets");
      },
    }),
    [user?.id, datasets, semantics, metrics],
  );

  const patch = useCallback((next: Partial<BiReport>) => {
    setReport((r) => (r ? { ...r, ...next } : r));
  }, []);

  const setBlocks = useCallback((fn: (b: ReportBlock[]) => ReportBlock[]) => {
    setReport((r) => (r ? { ...r, blocks: fn(r.blocks) } : r));
  }, []);

  async function save() {
    if (!report) return;
    const invalid = validateReport(report);
    if (invalid) return toast.error(invalid);
    setSaving(true);
    try {
      const res = await saveFn({
        data: {
          accessToken: token,
          id: report.id,
          name: report.name,
          description: report.description,
          page: report.page,
          header: report.header,
          footer: report.footer,
          blocks: report.blocks as unknown as Record<string, unknown>[],
        },
      });
      if (!res.ok) toast.error(res.error);
      else toast.success("Saved");
    } finally {
      setSaving(false);
    }
  }

  async function exportPdf() {
    if (!report) return;
    setExporting(true);
    try {
      const [{ buildReportPdfBytes }, html2canvas] = await Promise.all([
        import("@/lib/biReportPdf"),
        import("html2canvas-pro").then((m) => m.default),
      ]);
      // Charts are the only bitmap: rasterise each from the live preview so
      // what prints is what the designer showed.
      const charts = new Map<string, { dataUrl: string; wPx: number; hPx: number }>();
      for (const block of report.blocks) {
        if (block.kind !== "chart") continue;
        const el = document.querySelector<HTMLElement>(`[data-chart-block="${block.id}"]`);
        if (!el) continue;
        const canvas = await html2canvas(el, {
          scale: 3,
          backgroundColor: "#ffffff",
          logging: false,
          onclone: (doc) => doc.documentElement.classList.remove("dark"),
        });
        const rect = el.getBoundingClientRect();
        charts.set(block.id, {
          dataUrl: canvas.toDataURL("image/png"),
          wPx: rect.width,
          hPx: rect.height,
        });
      }
      const bytes = await buildReportPdfBytes({ report, charts });
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${report.name.replace(/[^\w.-]+/g, "_") || "report"}.pdf`;
      // In the document, then removed — a detached anchor's click is ignored
      // by some browsers, which is a download that silently never happens.
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Exported");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  if (loading) return <Skeleton className="m-4 h-96" />;
  if (!report) return <p className="p-6 text-sm text-muted-foreground">Report not found.</p>;

  const add = (block: ReportBlock) => {
    setBlocks((b) => [...b, block]);
    setSelected(block.id);
  };

  // h-canvas, not h-full: the app shell is min-h-screen, so a percentage height
  // resolves to nothing and the three columns grow the window rather than
  // scrolling inside themselves. FOUND FROM THE UI — the page scrolled away.
  return (
    <div className="flex h-canvas w-full min-h-0 flex-col gap-3 overflow-hidden p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/bi">
            <ArrowLeft className="mr-1 h-3.5 w-3.5" /> BI
          </Link>
        </Button>
        <Input
          className="h-8 w-64 font-medium"
          value={report.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <Badge variant="outline" className="text-[10px]">
          {PAGE_SIZES[report.page.size].label} · {report.page.orientation}
        </Badge>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setGenerateOpen(true)}>
            <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate with AI
          </Button>
          <Button size="sm" variant="outline" disabled={exporting} onClick={() => void exportPdf()}>
            {exporting ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1 h-3.5 w-3.5" />
            )}
            Export PDF
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1 h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[260px_1fr_240px]">
        {/* Blocks, in the order they print. */}
        <Card className="min-h-0 overflow-y-auto">
          <CardContent className="space-y-2 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Blocks
            </p>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() =>
                  add({ id: newBlockId(), kind: "heading", text: "New heading", level: 2 })
                }
              >
                <Type className="mr-1 h-3 w-3" /> Heading
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => add({ id: newBlockId(), kind: "text", text: "Text…" })}
              >
                <FileText className="mr-1 h-3 w-3" /> Text
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => add({ id: newBlockId(), kind: "spacer", height: 24 })}
              >
                <Minus className="mr-1 h-3 w-3" /> Spacer
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => add({ id: newBlockId(), kind: "pagebreak" })}
              >
                <Plus className="mr-1 h-3 w-3" /> Page break
              </Button>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-full text-[11px]"
              onClick={() => setImportOpen(true)}
            >
              <LayoutDashboard className="mr-1 h-3 w-3" /> Add from a dashboard
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              A chart or table block carries a dashboard widget, so it arrives either from a
              dashboard you already built or from <strong>Generate with AI</strong>.
            </p>

            <div className="space-y-1 border-t pt-2">
              {report.blocks.length === 0 ? (
                <p className="text-xs text-muted-foreground">No blocks yet.</p>
              ) : null}
              {report.blocks.map((b, i) => (
                <div
                  key={b.id}
                  className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                    selected === b.id ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <button
                    className="min-w-0 flex-1 truncate text-left"
                    onClick={() => setSelected(b.id)}
                  >
                    {b.kind === "table" ? <Table2 className="mr-1 inline h-3 w-3" /> : null}
                    {BLOCK_LABEL[b.kind]}
                    {"text" in b && b.text ? ` · ${b.text.slice(0, 22)}` : ""}
                    {"widget" in b && b.widget.title ? ` · ${b.widget.title.slice(0, 22)}` : ""}
                  </button>
                  <button
                    title="Move up"
                    disabled={i === 0}
                    className="disabled:opacity-30"
                    onClick={() =>
                      setBlocks((bl) => {
                        const next = [...bl];
                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                        return next;
                      })
                    }
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button
                    title="Move down"
                    disabled={i === report.blocks.length - 1}
                    className="disabled:opacity-30"
                    onClick={() =>
                      setBlocks((bl) => {
                        const next = [...bl];
                        [next[i + 1], next[i]] = [next[i], next[i + 1]];
                        return next;
                      })
                    }
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                  <button
                    title="Delete block"
                    className="text-destructive"
                    onClick={() => setBlocks((bl) => bl.filter((x) => x.id !== b.id))}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>

            {selected ? (
              <BlockEditor blocks={report.blocks} id={selected} onChange={setBlocks} />
            ) : null}
          </CardContent>
        </Card>

        {/* The pages, as they will print. */}
        <div className="min-h-0 overflow-y-auto rounded-lg border bg-muted/40 p-4">
          <ReportPagePreview
            report={report}
            selectedBlockId={selected}
            onSelectBlock={setSelected}
          />
        </div>

        {/* Page setup and the running bands. */}
        <Card className="min-h-0 overflow-y-auto">
          <CardContent className="space-y-3 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Page
            </p>
            <div className="space-y-1">
              <Label className="text-[11px]">Size</Label>
              <Select
                value={report.page.size}
                onValueChange={(v) =>
                  patch({ page: { ...report.page, size: v as BiReport["page"]["size"] } })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PAGE_SIZES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Orientation</Label>
              <Select
                value={report.page.orientation}
                onValueChange={(v) =>
                  patch({
                    page: { ...report.page, orientation: v as "portrait" | "landscape" },
                  })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="portrait">Portrait</SelectItem>
                  <SelectItem value="landscape">Landscape</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Margin (pt)</Label>
              <Input
                className="h-8 text-xs"
                type="number"
                value={report.page.margin}
                onChange={(e) =>
                  patch({ page: { ...report.page, margin: Number(e.target.value) || 0 } })
                }
              />
            </div>

            <BandEditor
              label="Header"
              band={report.header}
              onChange={(header) => patch({ header })}
            />
            <BandEditor
              label="Footer"
              band={report.footer}
              onChange={(footer) => patch({ footer })}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Tokens: <code>{"{{page}}"}</code> <code>{"{{pages}}"}</code>{" "}
              <code>{"{{title}}"}</code> <code>{"{{date}}"}</code> <code>{"{{time}}"}</code>
            </p>
          </CardContent>
        </Card>
      </div>

      <AddFromDashboardDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onAdd={(blocks) => {
          setBlocks((b) => [...b, ...blocks]);
          setSelected(blocks[blocks.length - 1]?.id ?? null);
        }}
      />

      <GenerateReportDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        ctx={ctx}
        onDone={async (blocks, title) => {
          const replace =
            report.blocks.length === 0 ||
            (await confirmAsk({
              title: "Replace the current blocks?",
              body: "The generated report replaces what is here. Cancel to keep both — the new blocks are appended instead.",
              actionLabel: "Replace",
            }));
          setReport((r) =>
            r
              ? {
                  ...r,
                  name: r.name && r.name !== "Untitled report" ? r.name : title,
                  blocks: replace ? blocks : [...r.blocks, ...blocks],
                }
              : r,
          );
          toast.success(`${blocks.length} block(s) added`);
        }}
      />
    </div>
  );
}

function BandEditor({
  label,
  band,
  onChange,
}: {
  label: string;
  band: ReportBand;
  onChange: (b: ReportBand) => void;
}) {
  return (
    <div className="space-y-1 border-t pt-2">
      <Label className="text-[11px]">{label}</Label>
      {(["left", "center", "right"] as const).map((slot) => (
        <Input
          key={slot}
          className="h-7 text-[11px]"
          placeholder={slot}
          value={band[slot] ?? ""}
          onChange={(e) => onChange({ ...band, [slot]: e.target.value })}
        />
      ))}
    </div>
  );
}

/** Edit whichever block is selected, in place. */
function BlockEditor({
  blocks,
  id,
  onChange,
}: {
  blocks: ReportBlock[];
  id: string;
  onChange: (fn: (b: ReportBlock[]) => ReportBlock[]) => void;
}) {
  const block = blocks.find((b) => b.id === id);
  if (!block) return null;
  const update = (next: Partial<ReportBlock>) =>
    onChange((bl) => bl.map((b) => (b.id === id ? ({ ...b, ...next } as ReportBlock) : b)));

  return (
    <div className="space-y-2 border-t pt-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {BLOCK_LABEL[block.kind]}
      </p>
      {block.kind === "heading" ? (
        <>
          <Input
            className="h-7 text-xs"
            value={block.text}
            onChange={(e) => update({ text: e.target.value } as Partial<ReportBlock>)}
          />
          <Select
            value={String(block.level ?? 2)}
            onValueChange={(v) => update({ level: Number(v) as 1 | 2 | 3 } as Partial<ReportBlock>)}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Title</SelectItem>
              <SelectItem value="2">Section</SelectItem>
              <SelectItem value="3">Sub-section</SelectItem>
            </SelectContent>
          </Select>
        </>
      ) : null}
      {block.kind === "text" ? (
        <Textarea
          rows={4}
          className="text-xs"
          value={block.text}
          onChange={(e) => update({ text: e.target.value } as Partial<ReportBlock>)}
        />
      ) : null}
      {block.kind === "spacer" ? (
        <Input
          className="h-7 text-xs"
          type="number"
          value={block.height}
          onChange={(e) => update({ height: Number(e.target.value) || 0 } as Partial<ReportBlock>)}
        />
      ) : null}
      {block.kind === "chart" ? (
        <div className="space-y-1">
          <Label className="text-[11px]">Height (pt)</Label>
          <Input
            className="h-7 text-xs"
            type="number"
            value={block.height ?? 200}
            onChange={(e) =>
              update({ height: Number(e.target.value) || 200 } as Partial<ReportBlock>)
            }
          />
        </div>
      ) : null}
      {block.kind === "table" ? (
        <div className="space-y-1">
          <Label className="text-[11px]">Max rows (blank = every row)</Label>
          <Input
            className="h-7 text-xs"
            type="number"
            value={block.maxRows ?? ""}
            onChange={(e) =>
              update({
                maxRows: e.target.value ? Number(e.target.value) : undefined,
              } as Partial<ReportBlock>)
            }
          />
          <p className="text-[11px] text-muted-foreground">
            {(block.widget.rows ?? []).length.toLocaleString()} row(s) available. The table
            continues across pages, with its header on each.
          </p>
        </div>
      ) : null}
    </div>
  );
}
