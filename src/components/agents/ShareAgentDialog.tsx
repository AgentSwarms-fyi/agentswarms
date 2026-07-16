import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy, Check } from "lucide-react";
import { buildAgentManifest } from "@/lib/agentExport";
import type { Agent } from "@/components/agents/AgentForm";
import { toast } from "sonner";

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

  const url = `https://nexusforge.dev/registry/${agent.id}`;
  const manifest = buildAgentManifest(agent);
  const previewJson = JSON.stringify(
    {
      name: manifest.name,
      description: manifest.description,
      model: manifest.model,
      tools: manifest.tools,
    },
    null,
    2,
  );

  async function copyLink() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share "{agent.name}"</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Public read-only URL
            </Label>
            <div className="flex gap-2">
              <Input value={url} readOnly className="font-mono text-xs" />
              <Button onClick={copyLink} variant="outline" size="icon">
                {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              JSON preview (no secrets)
            </Label>
            <pre className="rounded-lg border bg-muted/30 p-3 text-xs font-mono overflow-x-auto max-h-56">
              {previewJson}
            </pre>
            <p className="text-xs text-muted-foreground">
              ✓ API keys and tool credentials are stripped before sharing.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
