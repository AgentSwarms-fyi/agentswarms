import { useState } from "react";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SHORTCUT_CATEGORIES, SHORTCUTS } from "@/lib/shortcuts";

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border/70 bg-muted px-1.5 font-mono text-[11px] font-medium text-foreground shadow-[0_1px_0_0] shadow-border/70">
      {children}
    </kbd>
  );
}

function KeyCombo({ keys, sequential }: { keys: string[]; sequential?: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {keys.map((k, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && (
            <span className="text-[10px] text-muted-foreground">{sequential ? "then" : "+"}</span>
          )}
          <KeyCap>{k}</KeyCap>
        </span>
      ))}
    </div>
  );
}

/**
 * Auto-shown once per login (unless dismissed) and reachable anytime via
 * "?" or the header's help button (see useGlobalShortcuts). Content is
 * entirely driven by src/lib/shortcuts.ts — add a shortcut there and it
 * appears here with no further changes.
 */
export function ShortcutsHelpDialog({
  open,
  onOpenChange,
  onNeverShowAgain,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNeverShowAgain: () => void;
}) {
  const [neverShowChecked, setNeverShowChecked] = useState(false);

  const handleClose = () => {
    if (neverShowChecked) onNeverShowAgain();
    else onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Keyboard className="h-4.5 w-4.5" />
            </span>
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Move around AgentSwarms without reaching for the mouse. Press <KeyCap>?</KeyCap> anytime
            to bring this back up.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-6 py-5">
          {SHORTCUT_CATEGORIES.map((category) => {
            const items = SHORTCUTS.filter((s) => s.category === category);
            if (items.length === 0) return null;
            return (
              <div key={category} className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {category}
                </h3>
                <div className="space-y-1">
                  {items.map((s) => (
                    <div
                      key={s.description}
                      className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-muted/50"
                    >
                      <span className="text-sm text-foreground">{s.description}</span>
                      <KeyCombo keys={s.keys} sequential={s.sequential} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-3 border-t border-border bg-muted/30 px-6 py-4 sm:justify-between">
          <div className="flex items-center gap-2">
            <Checkbox
              id="shortcuts-never-show"
              checked={neverShowChecked}
              onCheckedChange={(v) => setNeverShowChecked(v === true)}
            />
            <Label
              htmlFor="shortcuts-never-show"
              className="text-xs font-normal text-muted-foreground"
            >
              Don't show this again
            </Label>
          </div>
          <Button type="button" size="sm" onClick={handleClose}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
