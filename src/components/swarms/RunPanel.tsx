// Runtime panel: input prompt + live event log + final output.
// Supports two layouts:
//   - "side"   → tall right-rail panel (legacy)
//   - "bottom" → wide horizontal dock at the bottom of the canvas (default in-canvas)
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Play,
  Square,
  Sparkles,
  ChevronDown,
  ChevronUp,
  ImageIcon,
  Maximize2,
  Paperclip,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { SwarmRunEvent } from "@/lib/swarmRuntime";
import { safeUrl } from "@/components/playground/MarkdownMessage";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { FILE_INPUT_ACCEPT, FILE_INPUT_MAX_CHARS } from "@/lib/swarmFileInput";

// Extract image URLs from arbitrary text. Catches:
//   - Markdown:  ![alt](https://x/y.png)
//   - Bare URLs: https://x/y.jpg, /local/path.webp
//   - data URIs: data:image/png;base64,...
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?[^\s)"']*)?/i;
const URL_RE =
  /(https?:\/\/[^\s)"'<>]+|\/[\w\-./]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s)"'<>]*)?|data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+)/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

type FoundImage = { url: string; alt?: string; source: string };

export function extractImages(text: string, source: string): FoundImage[] {
  if (!text) return [];
  const found: FoundImage[] = [];
  const seen = new Set<string>();
  // EVERY candidate goes through safeUrl, whichever pattern found it.
  //
  // The two branches below disagreed. The bare-URL branch checked its match
  // (`data:image/` or an image extension); the MARKDOWN branch pushed its
  // capture untouched, and MD_IMAGE_RE captures `([^)\s]+)` — any scheme at
  // all. These URLs are rendered as
  //
  //     <a href={img.url} target="_blank"><img src={img.url} /></a>
  //
  // so `![chart](javascript:alert(document.domain))` in a node's output became
  // a clickable thumbnail that ran script in the signed-in owner's session.
  // Node output is model-generated, so it is reachable by prompt injection —
  // through a web_browse result, a knowledge-base document, or an embed
  // visitor's message.
  //
  // safeUrl is the one already used by MarkdownMessage rather than a second
  // copy of the rule: it permits http(s), relative paths and image data URIs
  // (base64 only for SVG, which can otherwise carry script), and strips the
  // control characters that make "java\nscript:" resolve.
  const push = (url: string, alt?: string) => {
    const safe = safeUrl(url);
    if (!safe || seen.has(safe)) return;
    seen.add(safe);
    found.push({ url: safe, alt, source });
  };
  let m: RegExpExecArray | null;
  const md = new RegExp(MD_IMAGE_RE);
  while ((m = md.exec(text)) !== null) push(m[2], m[1]);
  const url = new RegExp(URL_RE);
  while ((m = url.exec(text)) !== null) {
    const candidate = m[1];
    if (candidate.startsWith("data:image/") || IMAGE_EXT_RE.test(candidate)) {
      push(candidate);
    }
  }
  return found;
}

type Props = {
  input: string;
  setInput: (v: string) => void;
  isRunning: boolean;
  events: SwarmRunEvent[];
  finalOutput: string | null;
  onRun: () => void;
  onStop: () => void;
  exampleInput?: string;
  layout?: "side" | "bottom";
  traceRunId?: string | null;
  traceEnabled?: boolean;
  onTraceEnabledChange?: (v: boolean) => void;
  /** Live shared flow-state snapshot for the variable inspector. */
  state?: Record<string, string>;
  /** Typed input form declared on the input node (empty = single textarea). */
  inputFields?: {
    name: string;
    label?: string;
    type: "text" | "textarea" | "number" | "select" | "file";
    options?: string[];
    placeholder?: string;
    required?: boolean;
  }[];
  fieldValues?: Record<string, string>;
  onFieldChange?: (name: string, value: string) => void;
};

export function RunPanel({
  input,
  setInput,
  isRunning,
  events,
  finalOutput,
  onRun,
  onStop,
  exampleInput,
  layout = "side",
  traceRunId,
  traceEnabled,
  onTraceEnabledChange,
  state,
  inputFields,
  fieldValues,
  onFieldChange,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fields = inputFields ?? [];
  const useForm = fields.length > 0;
  const canRun = useForm
    ? fields.every((f) => !f.required || (fieldValues?.[f.name] ?? "").trim().length > 0)
    : input.trim().length > 0;

  // Auto-detect any image URLs/markdown across node outputs and the final output.
  // Works for any media-producing swarm — pre-baked assets, image-gen tools, KB images, etc.
  const images = useMemo<FoundImage[]>(() => {
    const all: FoundImage[] = [];
    for (const ev of events) {
      if (ev.type === "node_done") all.push(...extractImages(ev.output, ev.nodeId));
    }
    if (finalOutput) all.push(...extractImages(finalOutput, "final"));
    const seen = new Set<string>();
    return all.filter((img) => (seen.has(img.url) ? false : (seen.add(img.url), true)));
  }, [events, finalOutput]);

  // Live cost/token meter — accumulate per-node usage emitted by the runtime.
  const usage = useMemo(() => {
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let nodes = 0;
    for (const ev of events) {
      if (ev.type === "node_usage") {
        tokensIn += ev.tokensIn;
        tokensOut += ev.tokensOut;
        costUsd += ev.costUsd;
        nodes += 1;
      }
    }
    return { tokensIn, tokensOut, costUsd, total: tokensIn + tokensOut, nodes };
  }, [events]);

  if (layout === "bottom") {
    return (
      <div className="border-t border-border bg-card/60 backdrop-blur flex flex-col max-h-[55vh]">
        {/* Header bar */}
        <div className="px-4 py-2 border-b border-border flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <p className="text-sm font-semibold">Run swarm</p>
          {isRunning && (
            <Badge
              variant="outline"
              className="text-[10px] gap-1 border-amber-500/40 text-amber-400"
            >
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> Running
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            <UsageMeter usage={usage} />
            {onTraceEnabledChange && (
              <label
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none"
                title="Record observability trace for this run"
              >
                <input
                  type="checkbox"
                  checked={!!traceEnabled}
                  onChange={(e) => onTraceEnabledChange(e.target.checked)}
                  className="h-3 w-3"
                  disabled={isRunning}
                />
                Trace
              </label>
            )}
            {traceRunId && !isRunning && (
              <a
                href={`/analytics/observability/${traceRunId}`}
                className="text-[11px] text-primary hover:underline px-2 py-1 rounded border border-primary/40"
                title="Open trace canvas"
              >
                Open trace →
              </a>
            )}
            {!isRunning ? (
              <Button onClick={onRun} size="sm" disabled={!canRun} className="h-7">
                <Play className="h-3.5 w-3.5 mr-1.5" /> Run
              </Button>
            ) : (
              <Button onClick={onStop} size="sm" variant="destructive" className="h-7">
                <Square className="h-3.5 w-3.5 mr-1.5" /> Stop
              </Button>
            )}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="grid h-7 w-7 place-items-center rounded-md border border-border/50 text-muted-foreground hover:border-primary/50 hover:text-primary"
              title="Expand run details"
              aria-label="Expand run details"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="grid h-7 w-7 place-items-center rounded-md border border-border/50 text-muted-foreground hover:border-primary/50 hover:text-primary"
              title={collapsed ? "Expand run dock" : "Collapse run dock"}
              aria-label={collapsed ? "Expand run dock" : "Collapse run dock"}
            >
              {collapsed ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {!collapsed && (
          <div className="grid grid-cols-12 gap-0 max-h-64">
            {/* Input column */}
            <div className="col-span-12 md:col-span-4 border-r border-border p-3 flex flex-col gap-2 overflow-y-auto max-h-64">
              {useForm ? (
                <StartInputForm
                  fields={fields}
                  values={fieldValues ?? {}}
                  onChange={onFieldChange ?? (() => {})}
                  disabled={isRunning}
                />
              ) : (
                <>
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={exampleInput || "Type the swarm's initial input..."}
                    rows={3}
                    disabled={isRunning}
                    className="text-sm resize-none flex-1"
                  />
                  {exampleInput && !input && (
                    <button
                      type="button"
                      onClick={() => setInput(exampleInput)}
                      className="text-[10px] text-primary hover:underline self-start"
                    >
                      Use example input
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Events column */}
            <div className="col-span-12 md:col-span-5 border-r border-border overflow-y-auto p-3 space-y-1 text-xs font-mono max-h-64">
              {events.length === 0 && !isRunning && (
                <p className="text-muted-foreground text-center py-6">
                  Run the swarm to see live events here.
                </p>
              )}
              {events.map((e, i) => (
                <EventLine key={i} ev={e} />
              ))}
            </div>

            {/* Final output column */}
            <div className="col-span-12 md:col-span-3 overflow-y-auto p-3 max-h-64">
              {finalOutput !== null ? (
                <>
                  <p className="text-[10px] uppercase tracking-wider text-emerald-400 mb-1">
                    Final output
                  </p>
                  <div className="text-xs whitespace-pre-wrap leading-relaxed">{finalOutput}</div>
                </>
              ) : (
                <p className="text-[10px] text-muted-foreground italic">
                  Final output will appear here once the run completes.
                </p>
              )}
            </div>
          </div>
        )}

        {!collapsed && <StateInspector state={state} />}

        {!collapsed && images.length > 0 && (
          <div className="border-t border-border p-3 overflow-y-auto">
            <MediaGallery images={images} compact />
          </div>
        )}
        <ExpandedRunDialog
          open={expanded}
          onOpenChange={setExpanded}
          input={input}
          events={events}
          finalOutput={finalOutput}
          images={images}
          isRunning={isRunning}
        />
      </div>
    );
  }

  // ── Legacy side layout ──
  return (
    <div className={cn("w-96 border-l border-border bg-card/40 flex flex-col h-full")}>
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <p className="text-sm font-semibold">Run swarm</p>
        {isRunning && (
          <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-400">
            <Loader2 className="h-2.5 w-2.5 animate-spin" /> Running
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <UsageMeter usage={usage} />
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="grid h-7 w-7 place-items-center rounded-md border border-border/50 text-muted-foreground hover:border-primary/50 hover:text-primary"
          title="Expand run details"
          aria-label="Expand run details"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="p-3 space-y-2 border-b border-border">
        {useForm ? (
          <StartInputForm
            fields={fields}
            values={fieldValues ?? {}}
            onChange={onFieldChange ?? (() => {})}
            disabled={isRunning}
          />
        ) : (
          <>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={exampleInput || "Type the swarm's initial input..."}
              rows={4}
              disabled={isRunning}
              className="text-sm"
            />
            {exampleInput && !input && (
              <button
                type="button"
                onClick={() => setInput(exampleInput)}
                className="text-[10px] text-primary hover:underline"
              >
                Use example input
              </button>
            )}
          </>
        )}
        <div className="flex gap-2">
          {!isRunning ? (
            <Button onClick={onRun} size="sm" className="flex-1" disabled={!canRun}>
              <Play className="h-3.5 w-3.5 mr-1.5" /> Run
            </Button>
          ) : (
            <Button onClick={onStop} size="sm" variant="destructive" className="flex-1">
              <Square className="h-3.5 w-3.5 mr-1.5" /> Stop
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1 text-xs font-mono">
        {events.length === 0 && !isRunning && (
          <p className="text-muted-foreground text-center py-8">
            Run the swarm to see live events here.
          </p>
        )}
        {events.map((e, i) => (
          <EventLine key={i} ev={e} />
        ))}
      </div>

      <StateInspector state={state} />

      {images.length > 0 && (
        <div className="border-t border-border p-3 max-h-72 overflow-y-auto">
          <MediaGallery images={images} compact />
        </div>
      )}

      {finalOutput !== null && (
        <div className="border-t border-border p-3 max-h-64 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-emerald-400 mb-1">Final output</p>
          <div className="text-xs whitespace-pre-wrap leading-relaxed">{finalOutput}</div>
        </div>
      )}
      <ExpandedRunDialog
        open={expanded}
        onOpenChange={setExpanded}
        input={input}
        events={events}
        finalOutput={finalOutput}
        images={images}
        isRunning={isRunning}
      />
    </div>
  );
}

type UsageSummary = {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  total: number;
  nodes: number;
};

// Compact live token/cost readout. Cost is an estimate (only models in the
// runtime's NODE_COST_TABLE contribute a dollar figure; others count tokens
// but add $0), so we label it "~$".
function UsageMeter({ usage }: { usage: UsageSummary }) {
  if (usage.total === 0) return null;
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border/50 bg-background/60 px-2 py-1 text-[10px] tabular-nums"
      title={`Live usage across ${usage.nodes} node${usage.nodes === 1 ? "" : "s"}\nInput: ${usage.tokensIn.toLocaleString()} tokens\nOutput: ${usage.tokensOut.toLocaleString()} tokens\nEstimated cost: $${usage.costUsd.toFixed(4)} (models without a known price contribute $0)`}
    >
      <span className="text-muted-foreground">{usage.total.toLocaleString()} tok</span>
      <span className="text-muted-foreground/70">
        ↑{usage.tokensIn.toLocaleString()} ↓{usage.tokensOut.toLocaleString()}
      </span>
      <span className="text-emerald-400">~${usage.costUsd.toFixed(4)}</span>
    </div>
  );
}

// Typed start-input form — one control per field the input node declares.
// Each value is seeded into flow state under its field name at run time.
/**
 * A file field: pick a document, extract its text, seed the text as the field's
 * value. Extraction happens HERE (client-side) so the swarm graph only ever
 * carries strings — see lib/swarmFileInput for why, and for the caps.
 */
function FileField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ name: string; chars: number; truncated: boolean } | null>(
    null,
  );

  const pick = async (file: File) => {
    setBusy(true);
    try {
      const { parseFileToText } = await import("@/lib/fileParsers");
      const { readFileField } = await import("@/lib/swarmFileInput");
      const res = await readFileField(file, () => parseFileToText(file));
      onChange(res.text);
      setMeta({ name: res.fileName, chars: res.text.length, truncated: res.truncated });
      if (res.truncated) {
        toast.warning(
          `"${res.fileName}" was truncated to ${FILE_INPUT_MAX_CHARS.toLocaleString()} characters — the swarm will not see the rest.`,
        );
      }
    } catch (e) {
      toast.error((e as Error).message);
      onChange("");
      setMeta(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <input
        ref={ref}
        type="file"
        accept={FILE_INPUT_ACCEPT}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
          e.currentTarget.value = "";
        }}
      />
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={disabled || busy}
          onClick={() => ref.current?.click()}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Paperclip className="h-3.5 w-3.5 mr-1" />
          )}
          {meta ? "Replace file" : "Attach file"}
        </Button>
        {meta && (
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-destructive"
            onClick={() => {
              onChange("");
              setMeta(null);
            }}
          >
            clear
          </button>
        )}
      </div>
      {meta ? (
        <p className="text-[10px] text-muted-foreground">
          <span className="font-medium text-foreground">{meta.name}</span> ·{" "}
          {meta.chars.toLocaleString()} chars extracted
          {meta.truncated && <span className="text-amber-500"> · truncated</span>}
        </p>
      ) : value ? (
        <p className="text-[10px] text-muted-foreground">
          {value.length.toLocaleString()} chars of text
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground">PDF, DOCX or text — extracted to text</p>
      )}
    </div>
  );
}

function StartInputForm({
  fields,
  values,
  onChange,
  disabled,
}: {
  fields: NonNullable<Props["inputFields"]>;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
}) {
  const inputCls =
    "w-full h-8 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50";
  return (
    <div className="space-y-2">
      {fields.map((f) => (
        <div key={f.name}>
          <label className="text-[10px] text-muted-foreground mb-0.5 block">
            {f.label || f.name}
            {f.required && <span className="text-destructive"> *</span>}
          </label>
          {f.type === "file" ? (
            <FileField
              value={values[f.name] ?? ""}
              onChange={(v) => onChange(f.name, v)}
              disabled={disabled}
            />
          ) : f.type === "textarea" ? (
            <Textarea
              value={values[f.name] ?? ""}
              onChange={(e) => onChange(f.name, e.target.value)}
              rows={2}
              placeholder={f.placeholder}
              disabled={disabled}
              className="text-sm resize-none"
            />
          ) : f.type === "select" ? (
            <select
              value={values[f.name] ?? ""}
              onChange={(e) => onChange(f.name, e.target.value)}
              disabled={disabled}
              className={inputCls}
            >
              <option value="">Select…</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={f.type === "number" ? "number" : "text"}
              value={values[f.name] ?? ""}
              onChange={(e) => onChange(f.name, e.target.value)}
              placeholder={f.placeholder}
              disabled={disabled}
              className={inputCls}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// Live variable inspector — shows the shared flow-state map produced during a
// run (outputs keyed by each node's outputVar, plus anything a Set Variable
// node wrote). Collapsed by default so it doesn't crowd the dock.
function StateInspector({ state }: { state?: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const entries = useMemo(() => Object.entries(state ?? {}), [state]);
  if (entries.length === 0) return null;
  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
        <span className="font-semibold uppercase tracking-wider">Flow variables</span>
        <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
          {entries.length}
        </Badge>
      </button>
      {open && (
        <div className="max-h-40 overflow-y-auto px-3 pb-2 space-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-2 text-[11px]">
              <span className="truncate font-mono text-primary" title={k}>
                {k}
              </span>
              <span className="truncate font-mono text-muted-foreground" title={v}>
                {v}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EventLine({ ev }: { ev: SwarmRunEvent }) {
  switch (ev.type) {
    case "node_start":
      return (
        <p>
          <span className="text-primary">▶</span>{" "}
          <span className="text-muted-foreground">start</span> {ev.nodeId}
        </p>
      );
    case "node_done":
      return (
        <div>
          <p>
            <span className="text-emerald-400">✓</span>{" "}
            <span className="text-muted-foreground">done</span> {ev.nodeId}
          </p>
          <p className="text-[10px] text-muted-foreground/70 pl-4 line-clamp-2">
            {ev.output.slice(0, 200)}
          </p>
        </div>
      );
    case "node_error":
      return (
        <p className="text-destructive">
          ✗ error {ev.nodeId}: {ev.error}
        </p>
      );
    case "loop_iteration_start":
      return (
        <p>
          <span className="text-orange-400">↻</span>{" "}
          <span className="text-muted-foreground">loop</span> {ev.nodeId} iteration {ev.iteration}/
          {ev.maxIterations}
        </p>
      );
    case "loop_iteration_done":
      return (
        <div>
          <p>
            <span className={ev.done ? "text-emerald-400" : "text-orange-400"}>
              {ev.done ? "✓" : "↺"}
            </span>{" "}
            <span className="text-muted-foreground">
              {ev.done ? "loop stopped" : "loop pass done"}
            </span>{" "}
            {ev.nodeId} #{ev.iteration}
          </p>
          <p className="text-[10px] text-muted-foreground/70 pl-4 line-clamp-2">
            {ev.output.slice(0, 200)}
          </p>
        </div>
      );
    case "approval_pending":
      return (
        <p className="text-amber-400">
          ⏸ awaiting approval ({ev.approvalId.slice(0, 8)}…) — open the inbox to decide
        </p>
      );
    case "run_done":
      return <p className="text-emerald-400 mt-2">━━ run complete ━━</p>;
    case "run_error":
      return <p className="text-destructive mt-2">━━ run failed: {ev.error} ━━</p>;
    case "node_token":
      return null;
    default:
      return null;
  }
}

function MediaGallery({ images, compact }: { images: FoundImage[]; compact?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-primary mb-2 flex items-center gap-1">
        <ImageIcon className="h-3 w-3" /> Media · {images.length}
      </p>
      <div className={cn("grid gap-2", compact ? "grid-cols-4" : "grid-cols-2")}>
        {images.map((img, i) => (
          <a
            key={`${img.url}-${i}`}
            href={img.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative block overflow-hidden rounded-md border border-border/60 bg-muted hover:border-primary/60 transition-colors"
            title={`${img.source}${img.alt ? " — " + img.alt : ""}`}
          >
            <img
              src={img.url}
              alt={img.alt || img.source}
              loading="lazy"
              className="aspect-square w-full object-cover"
              onError={(e) => {
                (e.currentTarget.parentElement as HTMLElement).style.display = "none";
              }}
            />
            <span className="absolute bottom-0 left-0 right-0 truncate bg-background/80 px-1.5 py-0.5 text-[9px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
              {img.source}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

function ExpandedRunDialog({
  open,
  onOpenChange,
  input,
  events,
  finalOutput,
  images,
  isRunning,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  input: string;
  events: SwarmRunEvent[];
  finalOutput: string | null;
  images: FoundImage[];
  isRunning: boolean;
}) {
  const nodeEvents = events.filter((e) => e.type === "node_done" || e.type === "node_error");
  const usage = events.reduce<UsageSummary>(
    (acc, ev) => {
      if (ev.type === "node_usage") {
        acc.tokensIn += ev.tokensIn;
        acc.tokensOut += ev.tokensOut;
        acc.costUsd += ev.costUsd;
        acc.total += ev.tokensIn + ev.tokensOut;
        acc.nodes += 1;
      }
      return acc;
    },
    { tokensIn: 0, tokensOut: 0, costUsd: 0, total: 0, nodes: 0 },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Swarm Run Details
            {isRunning && (
              <Badge
                variant="outline"
                className="text-[10px] gap-1 border-amber-500/40 text-amber-400"
              >
                <Loader2 className="h-2.5 w-2.5 animate-spin" /> Running
              </Badge>
            )}
            <div className="ml-auto">
              <UsageMeter usage={usage} />
            </div>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 overflow-auto">
          <div className="p-6 space-y-6">
            {/* Input */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Input
              </h3>
              <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm whitespace-pre-wrap leading-relaxed">
                {input || <span className="italic text-muted-foreground">No input provided</span>}
              </div>
            </section>

            {/* Agent Outputs */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Agent Outputs ({nodeEvents.length})
              </h3>
              {nodeEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No agent outputs yet.</p>
              ) : (
                <div className="space-y-3">
                  {nodeEvents.map((ev, i) => (
                    <div key={i} className="rounded-lg border border-border bg-card p-4">
                      <div className="flex items-center gap-2 mb-2">
                        {ev.type === "node_done" ? (
                          <span className="text-emerald-400 text-sm">✓</span>
                        ) : (
                          <span className="text-destructive text-sm">✗</span>
                        )}
                        <span className="font-mono text-sm font-medium">{ev.nodeId}</span>
                      </div>
                      <div className="text-sm whitespace-pre-wrap leading-relaxed text-foreground/80">
                        {ev.type === "node_done" ? ev.output : ev.error}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Images */}
            {images.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Media
                </h3>
                <MediaGallery images={images} />
              </section>
            )}

            {/* Final Output */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400 mb-2">
                Final Output
              </h3>
              {finalOutput !== null ? (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm whitespace-pre-wrap leading-relaxed">
                  {finalOutput}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  {isRunning ? "Waiting for run to complete…" : "No final output yet."}
                </p>
              )}
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
