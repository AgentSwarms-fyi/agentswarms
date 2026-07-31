// Business glossary for the Data Catalog. A term defines a tag —
// tagging an asset with the term's name links it, so each term shows how
// many assets carry it and can filter the inventory down to them.
import { useState } from "react";
import { toast } from "sonner";
import { BookMarked, Loader2, Plus, Search, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/hooks/use-auth";
import { deleteGlossaryTerm, upsertGlossaryTerm, type GlossaryTerm } from "@/lib/dataCatalog";

export function GlossaryDialog({
  open,
  onOpenChange,
  terms,
  assetCountFor,
  onChanged,
  onFilterByTerm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  terms: GlossaryTerm[];
  /** How many assets carry this term as a tag. */
  assetCountFor: (term: string) => number;
  /** Reload terms after a mutation. */
  onChanged: () => void;
  /** Filter the inventory to assets tagged with the term (closes the dialog). */
  onFilterByTerm: (term: string) => void;
}) {
  const { user } = useAuth();
  const [newTerm, setNewTerm] = useState("");
  const [newDef, setNewDef] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!user?.id || !newTerm.trim()) return;
    setBusy(true);
    try {
      await upsertGlossaryTerm(user.id, newTerm, newDef);
      setNewTerm("");
      setNewDef("");
      onChanged();
      toast.success("Term saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: GlossaryTerm) {
    try {
      await deleteGlossaryTerm(t.id);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookMarked className="h-4 w-4 text-primary" /> Business glossary
          </DialogTitle>
          <DialogDescription className="text-xs">
            Define the business terms your data uses. Tag an asset with a term's name to link them —
            tags matching a glossary term show its definition on hover.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            placeholder="Term, e.g. ARR"
            className="h-8 w-36 text-xs"
          />
          <Input
            value={newDef}
            onChange={(e) => setNewDef(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void add()}
            placeholder="Definition — what it means, how it's measured"
            className="h-8 flex-1 text-xs"
          />
          <Button
            size="sm"
            className="h-8 gap-1 px-2.5 text-xs"
            disabled={busy || !newTerm.trim()}
            onClick={add}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Add
          </Button>
        </div>

        <ScrollArea className="max-h-80">
          <div className="space-y-1.5 pr-2">
            {terms.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                No terms yet — define the vocabulary your team shares.
              </p>
            ) : (
              terms.map((t) => {
                const count = assetCountFor(t.term);
                return (
                  <div
                    key={t.id}
                    className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold">{t.term}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {t.definition || "No definition yet."}
                      </p>
                    </div>
                    <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
                      {count} asset{count === 1 ? "" : "s"}
                    </Badge>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0"
                      title="Show tagged assets"
                      disabled={count === 0}
                      onClick={() => onFilterByTerm(t.term)}
                    >
                      <Search className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                      title="Delete term"
                      onClick={() => void remove(t)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
