// The BI Workspace's ONTOLOGY editor — the "map my whole data estate" chart
// type, which has nothing in common with the field pickers every other chart
// uses.
//
// Split out of BiBuilderPane. 325 lines that touch two dozen of the parent's
// values, and a chart type nobody configures the same way as a bar chart, so
// it earns a file. The standard chart editor next to it needs eighty parent
// values and is deliberately left in place — see the note there.
//
// EVERY HOOK STAYS IN THE PARENT. This owns no state.
import type React from "react";
import { ChevronDown, ChevronRight, Loader2, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { OntologyGraph } from "@/components/bi/OntologyGraph";
import { WAREHOUSE_LABELS } from "@/utils/warehouse/types";
import type { BiDataContext } from "@/components/bi/biDataContext";
// Imported, NOT passed as props: these are pure and tested in lib/biBuilder,
// so threading them through the parent would add three props that can only
// ever hold one value.
import { groupCheckState, selHas, toggleName, type SelOrAll } from "@/lib/biBuilder";
import type { OntologyBuildStage, OntologySpec } from "@/lib/biOntology";
import { cn } from "@/lib/utils";

export type OntoKb = { id: string; name: string; docCount: number; docs: string[] };

/** What the progress line says at each stage of a build. */
const ONTO_STAGE_LABEL: Record<OntologyBuildStage, string> = {
  scanning: "Scanning sources…",
  detecting: "Detecting relationships…",
  enriching: "AI is building the ontology…",
};

export type BiOntologyTabProps = {
  ctx: BiDataContext;
  title: string;
  setTitle: React.Dispatch<React.SetStateAction<string>>;
  localTableNames: string[];
  /**
   * `SelOrAll`, not a list. "all" is distinct from "every current item
   * selected": a source added later is included by the first and not the
   * second, which is the whole reason the type exists.
   */
  ontoLocalSel: SelOrAll;
  setOntoLocalSel: React.Dispatch<React.SetStateAction<SelOrAll>>;
  ontoWhSel: Record<string, SelOrAll>;
  setOntoWhSel: React.Dispatch<React.SetStateAction<Record<string, SelOrAll>>>;
  ontoKbSel: SelOrAll;
  setOntoKbSel: React.Dispatch<React.SetStateAction<SelOrAll>>;
  ontoKbList: OntoKb[] | "loading" | "error" | null;
  /**
   * Async, and resolves to the list — the caller `.catch()`es it, so the
   * promise must survive the prop boundary. Typed as the parent returns it
   * rather than narrowed to void, which would silently discard the value if a
   * future caller wanted it.
   */
  ensureOntoKbList: () => Promise<OntoKb[]>;
  /** The loaded list, or null while it is a sentinel. */
  kbListArr: OntoKb[] | null;
  kbIds: string[] | null;
  ontoExpanded: Set<string>;
  toggleOntoExpanded: (key: string) => void;
  ontoHasSelection: boolean;
  /** The current build stage, or null when idle — not a boolean. */
  ontoBuilding: OntologyBuildStage | null;
  buildOntologyNow: () => void;
  ontoSpec: OntologySpec | null;
  ontoSampleSql: string;
  setOntoSampleSql: React.Dispatch<React.SetStateAction<string>>;
  ontoSampleRows: string;
  setOntoSampleRows: React.Dispatch<React.SetStateAction<string>>;
};

export function BiOntologyTab({
  ctx,
  title,
  setTitle,
  localTableNames,
  ontoLocalSel,
  setOntoLocalSel,
  ontoWhSel,
  setOntoWhSel,
  ontoKbSel,
  setOntoKbSel,
  ontoKbList,
  ensureOntoKbList,
  kbListArr,
  kbIds,
  ontoExpanded,
  toggleOntoExpanded,
  ontoHasSelection,
  ontoBuilding,
  buildOntologyNow,
  ontoSpec,
  ontoSampleSql,
  setOntoSampleSql,
  ontoSampleRows,
  setOntoSampleRows,
}: BiOntologyTabProps) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[11px] leading-snug text-muted-foreground">
        A high-level map of your whole data estate and how it relates. Expand a source to pick
        individual tables or knowledge bases; the AI classifies entities into business domains,
        labels each relationship and writes a summary.
      </div>

      <div className="space-y-1.5">
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Sources to include
        </Label>
        <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border border-border/60 p-1.5">
          {/* Local & prepared datasets */}
          <div>
            <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
              <button
                type="button"
                className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
                onClick={() => toggleOntoExpanded("local")}
                title="Choose tables"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 transition-transform",
                    ontoExpanded.has("local") && "rotate-90",
                  )}
                />
              </button>
              <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[11px] font-normal">
                <Checkbox
                  checked={groupCheckState(ontoLocalSel, localTableNames)}
                  onCheckedChange={() =>
                    setOntoLocalSel(
                      groupCheckState(ontoLocalSel, localTableNames) === true ? new Set() : "all",
                    )
                  }
                />
                <span className="truncate">Local &amp; prepared datasets</span>
                <span className="ml-auto shrink-0 text-[9px] tabular-nums text-muted-foreground">
                  {ctx.datasets.filter((d) => selHas(ontoLocalSel, d.name)).length}/
                  {ctx.datasets.length} tables
                </span>
              </Label>
            </div>
            {ontoExpanded.has("local") && (
              <div className="ml-4 space-y-0.5 border-l border-border/40 pl-2">
                {ctx.datasets.length === 0 && (
                  <p className="px-1 py-1 text-[10px] text-muted-foreground">
                    No local datasets — upload data on the Data &amp; SQL page.
                  </p>
                )}
                {ctx.datasets.map((d) => (
                  <Label
                    key={d.name}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 font-mono text-[10px] font-normal hover:bg-muted/60"
                  >
                    <Checkbox
                      checked={selHas(ontoLocalSel, d.name)}
                      onCheckedChange={() =>
                        setOntoLocalSel((s) => toggleName(s, localTableNames, d.name))
                      }
                    />
                    <span className="truncate">{d.name}</span>
                    {ctx.preparedTables?.has(d.name) && (
                      <Badge variant="secondary" className="shrink-0 px-1 text-[9px]">
                        prep
                      </Badge>
                    )}
                  </Label>
                ))}
              </div>
            )}
          </div>

          {/* Warehouses — schemas load on expand/select */}
          {ctx.warehouses.map((w) => {
            const t = ctx.whTables[w.id];
            const names = Array.isArray(t) ? t.map((x) => `${x.schema}.${x.name}`) : null;
            const sel = ontoWhSel[w.id];
            const st = groupCheckState(sel, names);
            return (
              <div key={w.id}>
                <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
                  <button
                    type="button"
                    className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
                    onClick={() => {
                      ctx.ensureSchema(w.id);
                      toggleOntoExpanded(w.id);
                    }}
                    title="Choose tables"
                  >
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 transition-transform",
                        ontoExpanded.has(w.id) && "rotate-90",
                      )}
                    />
                  </button>
                  <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[11px] font-normal">
                    <Checkbox
                      checked={st}
                      onCheckedChange={() => {
                        if (st === true) {
                          setOntoWhSel((prev) => {
                            const next = { ...prev };
                            delete next[w.id];
                            return next;
                          });
                        } else {
                          ctx.ensureSchema(w.id);
                          setOntoWhSel((prev) => ({ ...prev, [w.id]: "all" }));
                        }
                      }}
                    />
                    <span className="truncate">
                      {w.name} — {WAREHOUSE_LABELS[w.provider]}
                    </span>
                    {names && (
                      <span className="ml-auto shrink-0 text-[9px] tabular-nums text-muted-foreground">
                        {names.filter((n) => (sel ? selHas(sel, n) : false)).length}/{names.length}{" "}
                        tables
                      </span>
                    )}
                    {sel && (t === undefined || t === "loading") && (
                      <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                    )}
                  </Label>
                </div>
                {ontoExpanded.has(w.id) && (
                  <div className="ml-4 space-y-0.5 border-l border-border/40 pl-2">
                    {t === "error" && (
                      <p className="px-1 py-1 text-[10px] text-destructive">
                        Couldn't load this warehouse's schema.
                      </p>
                    )}
                    {(t === undefined || t === "loading") && (
                      <p className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Loading schema…
                      </p>
                    )}
                    {names?.map((n) => (
                      <Label
                        key={n}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 font-mono text-[10px] font-normal hover:bg-muted/60"
                      >
                        <Checkbox
                          checked={sel ? selHas(sel, n) : false}
                          onCheckedChange={() =>
                            setOntoWhSel((prev) => ({
                              ...prev,
                              [w.id]: toggleName(prev[w.id], names, n),
                            }))
                          }
                        />
                        <span className="truncate">{n}</span>
                      </Label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Knowledge bases */}
          <div>
            <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
              <button
                type="button"
                className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
                onClick={() => {
                  void ensureOntoKbList().catch(() => {});
                  toggleOntoExpanded("kb");
                }}
                title="Choose knowledge bases"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 transition-transform",
                    ontoExpanded.has("kb") && "rotate-90",
                  )}
                />
              </button>
              <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[11px] font-normal">
                <Checkbox
                  checked={groupCheckState(ontoKbSel, kbIds)}
                  onCheckedChange={() =>
                    setOntoKbSel(groupCheckState(ontoKbSel, kbIds) === true ? new Set() : "all")
                  }
                />
                <span className="truncate">Knowledge bases</span>
                {kbListArr && (
                  <span className="ml-auto shrink-0 text-[9px] tabular-nums text-muted-foreground">
                    {kbListArr.filter((k) => selHas(ontoKbSel, k.id)).length}/{kbListArr.length}
                  </span>
                )}
              </Label>
            </div>
            {ontoExpanded.has("kb") && (
              <div className="ml-4 space-y-0.5 border-l border-border/40 pl-2">
                {ontoKbList === "loading" && (
                  <p className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading knowledge bases…
                  </p>
                )}
                {ontoKbList === "error" && (
                  <p className="px-1 py-1 text-[10px] text-destructive">
                    Couldn't load your knowledge bases — collapse and expand to retry.
                  </p>
                )}
                {kbListArr && kbListArr.length === 0 && (
                  <p className="px-1 py-1 text-[10px] text-muted-foreground">
                    No knowledge bases yet — create one on the Knowledge page.
                  </p>
                )}
                {kbListArr?.map((k) => (
                  <Label
                    key={k.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[10px] font-normal hover:bg-muted/60"
                  >
                    <Checkbox
                      checked={selHas(ontoKbSel, k.id)}
                      onCheckedChange={() => setOntoKbSel((s) => toggleName(s, kbIds ?? [], k.id))}
                    />
                    <span className="truncate">{k.name}</span>
                    <span className="ml-auto shrink-0 text-[9px] tabular-nums text-muted-foreground">
                      {k.docCount} docs
                    </span>
                  </Label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Data sample for the AI
        </Label>
        <div className="flex items-center gap-2">
          <Select value={ontoSampleRows} onValueChange={setOntoSampleRows}>
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0" className="text-xs">
                Schema only — no rows
              </SelectItem>
              {["5", "10", "25", "50", "100", "200"].map((n) => (
                <SelectItem key={n} value={n} className="text-xs">
                  {n} rows per table
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[10px] leading-tight text-muted-foreground">
            Real values sent to the AI to find relationships
          </span>
        </div>
        <Textarea
          value={ontoSampleSql}
          onChange={(e) => setOntoSampleSql(e.target.value)}
          rows={2}
          className="font-mono text-xs"
          placeholder="Optional custom SQL — its result is given to the AI as extra signal (runs on local & prepared datasets)"
        />
      </div>

      {ctx.onModelChange && (
        <div className="space-y-1.5">
          <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            AI model
          </Label>
          <BiModelSelect
            value={ctx.model ?? null}
            onChange={ctx.onModelChange}
            className="w-full"
          />
        </div>
      )}

      <Button
        className="w-full gap-1.5"
        onClick={() => void buildOntologyNow()}
        disabled={Boolean(ontoBuilding) || !ontoHasSelection}
      >
        {ontoBuilding ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
        {ontoBuilding
          ? ONTO_STAGE_LABEL[ontoBuilding]
          : ontoSpec
            ? "Rebuild ontology"
            : "Build ontology with AI"}
      </Button>

      {ontoSpec && (
        <>
          <div className="rounded-lg border border-border/60 bg-card p-2">
            <OntologyGraph spec={ontoSpec} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Widget title
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Data ontology"
              className="h-8 text-xs"
            />
          </div>
        </>
      )}
    </div>
  );
}
