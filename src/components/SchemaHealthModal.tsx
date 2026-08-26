import { useState } from "react";
import { AlertTriangle, Check, Copy, DatabaseZap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { SchemaIssue } from "@/lib/schemaHealthCheck";

type Command = { command: string; description: string; danger?: boolean };

const COMMANDS: Command[] = [
  {
    command: "npx supabase db push",
    description:
      "Recommended. Pushes local migration files (supabase/migrations) to your linked project.",
  },
  {
    command: "npx supabase migration up",
    description: "Applies pending migrations to your local Supabase (CLI dev stack).",
  },
  {
    command: "npx supabase db reset",
    description:
      "Wipes and rebuilds your LOCAL database from migrations. Never run against a linked remote project — this drops all data.",
    danger: true,
  },
];

function CommandBlock({ command, description, danger }: Command) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not access clipboard");
    }
  }

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        danger ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{command}</code>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1 px-2 text-xs"
          onClick={copy}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{description}</p>
    </div>
  );
}

function issueLabel(issue: SchemaIssue): string {
  return issue.column ? `${issue.table}.${issue.column}` : issue.table;
}

export function SchemaHealthModal({
  open,
  issues,
  onDismiss,
}: {
  open: boolean;
  issues: SchemaIssue[];
  onDismiss: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDismiss()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DatabaseZap className="h-4 w-4 text-destructive" />
            Your database schema is out of date
          </DialogTitle>
          <DialogDescription>
            The app just tried to read a column or table your database doesn't have yet. This almost
            always means a recent migration hasn't been applied to this Supabase project.
          </DialogDescription>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {issues.length === 1
              ? "1 schema mismatch found"
              : `${issues.length} schema mismatches found`}
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1.5 space-y-1.5">
              {issues.map((issue) => (
                <li key={issueLabel(issue)} className="text-xs">
                  <code className="font-mono font-semibold">{issueLabel(issue)}</code>{" "}
                  {issue.kind === "missing_table" ? "table" : "column"} does not exist.
                  {issue.check && (
                    <>
                      {" "}
                      <span className="opacity-80">
                        {issue.check.description} (added in{" "}
                        <code className="font-mono">{issue.check.migration}</code>)
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>

        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">Run one of these, then reload:</p>
          {COMMANDS.map((c) => (
            <CommandBlock key={c.command} {...c} />
          ))}
        </div>

        <DialogFooter className="sm:justify-between">
          <p className="text-[11px] text-muted-foreground">
            Full setup instructions: <code className="font-mono">docs/SCHEMA_HEALTH_CHECK.md</code>
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss for now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
