// The action bar under the chat composer: an optional "Visual BI" toggle plus
// AI document generators (PowerPoint / Word / Excel). Each generator gathers
// context from the user's connected KBs + data tables, has the LLM plan the
// document, then builds a real, fully-editable file client-side.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { BarChart3, Loader2 } from "lucide-react";

import { ExcelIcon, PptIcon, WordIcon } from "@/components/playground/FileTypeIcons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { buildDocx, buildPptx, buildXlsx, materializeXlsxPlan } from "@/lib/docGen/build";
import { planDocument } from "@/lib/docGen/plan";
import type { PlanConversationTurn } from "@/lib/docGen/plan";
import { DOC_FORMAT_LABEL, type DocFormat, type DocScope } from "@/lib/docGen/types";
import type { DocxPlan, PptxPlan, XlsxPlan } from "@/lib/docGen/types";
import { gatherDocContext } from "@/utils/docGen.functions";

type Phase = "idle" | "gathering" | "planning" | "building";

export function DocGenBar({
  agentId,
  defaultPrompt,
  model,
  // Recent chat turns, so generated docs build on the conversation.
  conversation,
  // Sample vs. full data scope, shared with the playground's Visual BI widget.
  scope = "sample",
  onScopeChange,
  // Optional "Visual BI" toggle (wired by the playground when an agent is selected).
  biControl,
}: {
  agentId?: string;
  defaultPrompt: string;
  model?: string;
  conversation?: PlanConversationTurn[];
  scope?: DocScope;
  onScopeChange?: (next: DocScope) => void;
  biControl?: { enabled: boolean; onToggle: (next: boolean) => void; disabled?: boolean };
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const gatherContext = useServerFn(gatherDocContext);

  const [format, setFormat] = useState<DocFormat | null>(null);
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");

  function open(f: DocFormat) {
    setFormat(f);
    setPrompt(defaultPrompt.trim());
    setPhase("idle");
  }

  async function generate() {
    if (!format || !token) return;
    const task = prompt.trim();
    if (!task) {
      toast.error("Describe what the document should contain");
      return;
    }
    try {
      setPhase("gathering");
      const ctx = await gatherContext({
        data: { access_token: token, prompt: task, agent_id: agentId },
      });
      if (!ctx.ok) throw new Error(ctx.error);

      setPhase("planning");
      const plan = await planDocument(format, {
        prompt: task,
        context: ctx.context,
        model,
        scope,
        conversation,
      });

      setPhase("building");
      const fileBase =
        task
          .slice(0, 40)
          .replace(/[^\w.-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "document";
      if (format === "pptx") await buildPptx(plan as PptxPlan, fileBase, { model });
      else if (format === "docx") await buildDocx(plan as DocxPlan, fileBase);
      else {
        // Resolve any data-bound sheets against the user's real rows (all rows
        // in full scope) before writing the workbook.
        const materialized = await materializeXlsxPlan(plan as XlsxPlan, scope);
        await buildXlsx(materialized, fileBase);
      }

      toast.success(`${DOC_FORMAT_LABEL[format]} generated`);
      setFormat(null);
    } catch (e) {
      toast.error((e as Error).message || "Generation failed");
    } finally {
      setPhase("idle");
    }
  }

  const busy = phase !== "idle";
  const phaseLabel =
    phase === "gathering"
      ? "Analyzing connected data…"
      : phase === "planning"
        ? "Planning the document…"
        : phase === "building"
          ? "Building the file…"
          : "";

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {biControl && (
          <Button
            type="button"
            size="sm"
            variant={biControl.enabled ? "default" : "outline"}
            className="h-7 gap-1.5 text-xs"
            disabled={biControl.disabled}
            onClick={() => biControl.onToggle(!biControl.enabled)}
            title="Show a data visualization alongside answers"
          >
            <BarChart3 className="h-3.5 w-3.5" /> Visual BI
          </Button>
        )}
        {onScopeChange && (
          <div
            className="flex h-7 items-center rounded-md border border-border bg-background p-0.5"
            title="How much data to pull into Excel workbooks and the BI widget"
          >
            {(["sample", "full"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onScopeChange(s)}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                  scope === s
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s === "sample" ? "Sample" : "Full data"}
              </button>
            ))}
          </div>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => open("pptx")}
          title="Generate a PowerPoint from your data"
        >
          <PptIcon className="h-4 w-4" /> PPT
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => open("docx")}
          title="Generate a Word document from your data"
        >
          <WordIcon className="h-4 w-4" /> Word
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => open("xlsx")}
          title="Generate an Excel workbook from your data"
        >
          <ExcelIcon className="h-4 w-4" /> Excel
        </Button>
      </div>

      <Dialog open={format !== null} onOpenChange={(o) => !o && !busy && setFormat(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate {format ? DOC_FORMAT_LABEL[format] : ""}</DialogTitle>
            <DialogDescription>
              Describe the document. It&apos;s planned from your connected knowledge bases and data
              tables{conversation && conversation.length > 0 ? " and the current conversation" : ""}
              , then built as a fully-editable file.
              {format === "xlsx" && (
                <>
                  {" "}
                  Using{" "}
                  <span className="font-medium text-foreground">
                    {scope === "full" ? "full data" : "a data sample"}
                  </span>{" "}
                  — change this with the toggle next to the generate buttons.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">What should it contain?</Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder={
                format === "xlsx"
                  ? "e.g. A budget vs. actuals workbook by department with variance formulas and a totals row"
                  : format === "pptx"
                    ? "e.g. A quarterly business review deck: revenue trend, top products, regional breakdown"
                    : "e.g. A one-page summary of Q3 performance with key metrics and recommendations"
              }
              disabled={busy}
            />
          </div>
          <DialogFooter className="items-center">
            {busy && (
              <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {phaseLabel}
              </span>
            )}
            <Button variant="ghost" onClick={() => setFormat(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void generate()} disabled={busy || !prompt.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Generate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
