// Share an agent.
//
// WHAT THIS USED TO DO, all of it untrue:
//
//   const url = `https://nexusforge.dev/registry/${agent.id}`;
//
// A hardcoded link to a domain this project does not own, appearing exactly
// once in the codebase — placeholder text from a template that shipped. There
// is no /registry route anywhere, and nothing was published when the dialog
// opened, so "Public read-only URL" named a page that could not exist. The
// user copied a dead link to a third party and sent it to a colleague.
//
// Under it, a green tick: "API keys and tool credentials are stripped before
// sharing." True but hollow — nothing was shared — and it sat above a preview
// showing name, description, model and tools while the manifest ALSO carries
// system_prompt. Someone reading that preview to decide whether the share was
// safe would have concluded their prompt stayed private. It does not: it is in
// the file, it is usually the most proprietary part of an agent, and the
// preview was the only thing telling them otherwise.
//
// So this now offers the two things that genuinely exist: the portable
// manifest (the same one the exporter writes and the importer reads), shown in
// full so the preview cannot mislead, and a pointer to /embeds, which is where
// a real public URL is minted against a domain allow-list.
import { useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { buildAgentManifest, downloadFile } from "@/lib/agentExport";
import { safeIdentifier } from "@/lib/swarmExportTools";
import type { Agent } from "@/components/agents/AgentForm";

export function ShareAgentDialog({
  agent,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  agent: Agent;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [copied, setCopied] = useState(false);

  const manifest = buildAgentManifest(agent);
  // The WHOLE manifest, not a flattering subset. This is exactly the bytes the
  // recipient gets, so the preview cannot promise something the file does not.
  const manifestJson = JSON.stringify(manifest, null, 2);
  const hasPrompt = Boolean(manifest.system_prompt?.trim());

  async function copyManifest() {
    // clipboard.writeText rejects on an insecure origin and when the
    // permission is denied. Unguarded, that was an unhandled rejection and a
    // success toast that never fired — the user saw nothing at all and
    // reasonably assumed it had worked.
    try {
      await navigator.clipboard.writeText(manifestJson);
      setCopied(true);
      toast.success("Agent definition copied");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Could not copy — your browser blocked clipboard access.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">Share “{agent.name}”</DialogTitle>
        </DialogHeader>

        <div className="mt-2 space-y-4">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Agent definition
            </Label>
            <pre className="max-h-56 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs">
              {manifestJson}
            </pre>
            <p className="text-xs text-muted-foreground">
              No API keys or tool credentials are included — only the ids of tools that need
              configuring.
              {hasPrompt ? (
                <>
                  {" "}
                  <span className="font-medium text-foreground">
                    Your system prompt is included
                  </span>{" "}
                  so the agent works for whoever imports it.
                </>
              ) : null}
            </p>
            <div className="flex gap-2">
              <Button onClick={copyManifest} variant="outline" size="sm" className="gap-1.5">
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                Copy JSON
              </Button>
              <Button
                onClick={() =>
                  downloadFile(
                    `${safeIdentifier(agent.name, "agent")}.agent.json`,
                    manifestJson,
                    "application/json",
                  )
                }
                variant="outline"
                size="sm"
              >
                Download
              </Button>
            </div>
          </div>

          <div className="space-y-1.5 rounded-lg border border-border/60 p-3">
            <p className="text-sm font-medium">Want a public chat link instead?</p>
            <p className="text-xs text-muted-foreground">
              Embed keys give this agent a hosted URL, restricted to the domains you list.
            </p>
            <Button asChild variant="secondary" size="sm" className="mt-1 gap-1.5">
              <Link to="/embeds" onClick={() => setOpen(false)}>
                Create an embed <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
