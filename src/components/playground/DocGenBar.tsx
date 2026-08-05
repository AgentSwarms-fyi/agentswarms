// The action bar under the chat composer: an optional "Visual BI" toggle, a
// Sample/Full data scope selector, and the AI document generators (PowerPoint /
// Word / Excel). Clicking a generator ARMS it — the user then types the document
// description in the main chat box and presses send (no popup dialog). The
// playground owns the actual generation + the "Preparing…" state.
import { BarChart3 } from "lucide-react";

import { ExcelIcon, PptIcon, WordIcon } from "@/components/playground/FileTypeIcons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type DocFormat, type DocGenMode, type DocScope } from "@/lib/docGen/types";

export function DocGenBar({
  // The currently-armed doc format (drives the chat box into "describe the doc"
  // mode) or null. Clicking a format toggles it.
  armed,
  onPick,
  // True while a document is being generated — disables the buttons.
  busy = false,
  // Sample vs. full data scope, shared with the playground's Visual BI widget.
  scope = "sample",
  onScopeChange,
  // Browser (fast) vs Deep (slow, server renderer + AI review) build mode.
  mode = "fast",
  onModeChange,
  // Whether the server-side renderer is actually reachable. Deep mode silently
  // falls back to the browser build when it isn't, producing a file identical
  // to Fast — so the option is disabled with the reason instead.
  deepAvailable = true,
  deepReason = null,
  // Optional "Visual BI" toggle (wired by the playground when an agent is selected).
  biControl,
}: {
  armed: DocFormat | null;
  onPick: (f: DocFormat) => void;
  busy?: boolean;
  scope?: DocScope;
  onScopeChange?: (next: DocScope) => void;
  mode?: DocGenMode;
  onModeChange?: (next: DocGenMode) => void;
  deepAvailable?: boolean;
  deepReason?: string | null;
  biControl?: { enabled: boolean; onToggle: (next: boolean) => void; disabled?: boolean };
}) {
  const formatBtn = (f: DocFormat, Icon: typeof PptIcon, label: string, title: string) => (
    <Button
      type="button"
      size="sm"
      variant={armed === f ? "default" : "outline"}
      className="h-7 gap-1.5 text-xs"
      onClick={() => onPick(f)}
      disabled={busy}
      title={title}
      aria-pressed={armed === f}
    >
      <Icon className="h-4 w-4" /> {label}
    </Button>
  );

  return (
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
          aria-pressed={biControl.enabled}
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
              aria-pressed={scope === s}
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
      {onModeChange && (
        <div className="flex h-7 items-center rounded-md border border-border bg-background p-0.5">
          {(["fast", "deep"] as const).map((m) => {
            const disabled = m === "deep" && !deepAvailable;
            return (
              <button
                key={m}
                type="button"
                disabled={disabled}
                onClick={() => !disabled && onModeChange(m)}
                aria-pressed={!disabled && mode === m}
                title={
                  disabled
                    ? `Deep mode is unavailable — ${deepReason ?? "the doc-gen service isn't reachable"}. Documents would be built in the browser anyway, so this is the same as Fast.`
                    : m === "fast"
                      ? "Builds instantly in your browser. Works on every deployment."
                      : "Server renderer: native Office output (editable charts, real tables) plus an AI visual review pass. Slower."
                }
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                  disabled && "cursor-not-allowed opacity-40",
                  !disabled && mode === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "fast" ? "Browser · fast" : "Deep · slow"}
                {disabled && " ✕"}
              </button>
            );
          })}
        </div>
      )}
      {formatBtn(
        "pptx",
        PptIcon,
        "PPT",
        "Generate a PowerPoint — then describe it in the chat box",
      )}
      {formatBtn(
        "docx",
        WordIcon,
        "Word",
        "Generate a Word document — then describe it in the chat box",
      )}
      {formatBtn(
        "xlsx",
        ExcelIcon,
        "Excel",
        "Generate an Excel workbook — then describe it in the chat box",
      )}
    </div>
  );
}
