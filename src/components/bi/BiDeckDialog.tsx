// Export a dashboard as a PowerPoint deck: pick the visuals, pick the model,
// create.
//
// The list shows EVERY widget, including the ones that cannot become a slide,
// each with the reason. Hiding them would be the more obviously "clean" design
// and the wrong one: someone exporting a twelve-widget dashboard and receiving
// nine slides needs to know which three are missing and why, at the moment they
// choose, not by counting slides afterwards.
import { useEffect, useMemo, useState } from "react";
import { FileType2, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { BiPage, BiWidget } from "@/lib/biDashboards";
import { buildDeckPlan, deckCandidates, type DeckCandidate } from "@/lib/biDeck";
import { generateDeckNarrative } from "@/lib/biDeckNarrative";

type PageGroup = { page: BiPage; candidates: DeckCandidate[] };

export function BiDeckDialog({
  open,
  onOpenChange,
  dashboardName,
  dashboardDescription,
  pages,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  dashboardName: string;
  dashboardDescription?: string | null;
  /** Every page with its widgets — the deck can span the whole dashboard. */
  pages: BiPage[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [model, setModel] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const groups = useMemo<PageGroup[]>(
    () => pages.map((page) => ({ page, candidates: deckCandidates(page.widgets ?? []) })),
    [pages],
  );

  const exportable = useMemo(
    () => groups.flatMap((g) => g.candidates.filter((c) => c.ok)),
    [groups],
  );
  const blocked = useMemo(() => groups.flatMap((g) => g.candidates.filter((c) => !c.ok)), [groups]);

  // Default to everything that CAN be exported, re-evaluated whenever the
  // dialog opens — the dashboard may have been refreshed since last time, which
  // changes which widgets have data.
  useEffect(() => {
    if (open) setSelected(new Set(exportable.map((c) => c.widget.id)));
  }, [open, exportable]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function create() {
    const chosen = exportable.filter((c) => selected.has(c.widget.id));
    if (chosen.length === 0) {
      toast.error("Pick at least one visual for the deck");
      return;
    }
    try {
      // Prose first, and never fatally: generateDeckNarrative returns null on
      // any failure so a model outage costs captions, not the export.
      setBusy("Writing the narrative…");
      const narrative = await generateDeckNarrative({
        dashboardName,
        dashboardDescription,
        candidates: chosen,
        model: model ?? undefined,
        instructions,
      });

      setBusy("Building the deck…");
      const plan = buildDeckPlan({
        dashboardName,
        dashboardDescription,
        candidates: chosen,
        narrative,
      });

      // Loaded on demand — pptxgenjs is a large bundle and most dashboard
      // visits never export.
      const { buildPptx, downloadBlob } = await import("@/lib/docGen/build");
      // skipMaterialize: every figure is already in the plan, taken from the
      // widget snapshots. Letting the builder re-run its BI pipeline would
      // re-query the data and could produce a deck that disagrees with the
      // dashboard it was exported from.
      const doc = await buildPptx(plan, `${dashboardName || "dashboard"}.pptx`, {
        skipMaterialize: true,
      });
      downloadBlob(doc.blob, doc.filename);

      toast.success(
        narrative
          ? `Deck created — ${plan.slides.length} slides`
          : `Deck created — ${plan.slides.length} slides (no narrative: the model did not respond)`,
      );
      onOpenChange(false);
    } catch (e) {
      toast.error(`Deck export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileType2 className="h-4 w-4 text-primary" /> Export to PowerPoint
          </DialogTitle>
          <DialogDescription>
            Choose the visuals for the deck. Every figure comes from the saved dashboard data — the
            AI writes the titles and takeaways, never the numbers.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-4 overflow-y-auto pr-1">
          {groups.map((g) => {
            const usable = g.candidates.filter((c) => c.ok);
            if (g.candidates.length === 0) return null;
            return (
              <div key={g.page.id}>
                {groups.length > 1 && (
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {g.page.name}
                  </p>
                )}
                <div className="space-y-1.5">
                  {usable.map((c) => (
                    <label
                      key={c.widget.id}
                      className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1 hover:bg-muted/60"
                    >
                      <Checkbox
                        checked={selected.has(c.widget.id)}
                        onCheckedChange={() => toggle(c.widget.id)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs">{c.widget.title}</span>
                        {c.note && (
                          <span className="block text-[10px] text-amber-600 dark:text-amber-400">
                            {c.note}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                  {g.candidates
                    .filter((c) => !c.ok)
                    .map((c) => (
                      <div
                        key={c.widget.id}
                        className="flex items-start gap-2.5 px-1.5 py-1 opacity-60"
                      >
                        <Checkbox checked={false} disabled className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs line-through">
                            {c.widget.title}
                          </span>
                          <span className="block text-[10px] text-muted-foreground">
                            {c.reason}
                          </span>
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
          {exportable.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              None of this dashboard&apos;s widgets can become slides yet
              {blocked.length > 0 ? " — see the reasons above." : "."}
            </p>
          )}
        </div>

        <div className="space-y-1.5 border-t pt-3">
          <Label className="flex items-center gap-1.5 text-xs">
            <Sparkles className="h-3 w-3 text-primary" /> Model for the deck narrative
          </Label>
          <BiModelSelect value={model} onChange={setModel} allowUnset className="w-full" />
          <p className="text-[10px] text-muted-foreground">
            Used only for the deck title, summary and per-slide takeaways.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="deck-instructions" className="text-xs">
            Instructions <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="deck-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. Write for a board audience. Lead with the regional story and keep it to plain language."
            rows={3}
            className="resize-none text-xs"
            disabled={!!busy}
          />
          {/* Said here rather than discovered later: an instruction asking for a
              figure the dashboard does not already show is asking the model to
              calculate, and those get stripped. Better to set the expectation at
              the point of typing than to leave someone wondering where their
              percentages went. */}
          <p className="text-[10px] text-muted-foreground">
            Shapes the wording only. Figures always come from the dashboard — the model is not
            allowed to calculate new ones.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={!!busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void create()} disabled={!!busy || selected.size === 0}>
            {busy ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {busy}
              </>
            ) : (
              `Create deck (${selected.size})`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
