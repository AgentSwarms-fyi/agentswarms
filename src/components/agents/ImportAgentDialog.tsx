import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { UploadCloud, FileCheck2, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_IMPORT_BYTES, parseImportedAgent } from "@/lib/agentExport";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type ParsedAgent = ReturnType<typeof parseImportedAgent>;

export function ImportAgentDialog({
  userId,
  onImported,
  trigger,
}: {
  userId: string;
  onImported: () => void;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedAgent | null>(null);
  const [filename, setFilename] = useState("");
  const [importing, setImporting] = useState(false);

  const onDrop = useCallback((files: File[]) => {
    const f = files[0];
    if (!f) return;
    // Checked BEFORE reading, not after. readAsText pulls the whole file into
    // memory, so a size check that runs on the result has already paid the
    // cost it is meant to avoid.
    if (f.size > MAX_IMPORT_BYTES) {
      toast.error(
        `That file is ${Math.round(f.size / 1024)} KB. Agent files are a few KB — the limit is ${MAX_IMPORT_BYTES / 1024} KB.`,
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = parseImportedAgent(reader.result as string, f.name);
        setParsed(result);
        setFilename(f.name);
      } catch (err) {
        toast.error(
          `Could not parse file: ${err instanceof Error ? err.message : "unrecognised format"}`,
        );
      }
    };
    reader.onerror = () => toast.error("Could not read that file.");
    reader.readAsText(f);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/json": [".json"], "text/yaml": [".yaml", ".yml"] },
    maxFiles: 1,
  } as unknown as Parameters<typeof useDropzone>[0]);

  function reset() {
    setParsed(null);
    setFilename("");
  }

  async function handleImport() {
    if (!parsed) return;
    setImporting(true);
    const { error } = await supabase.from("agents").insert({
      user_id: userId,
      name: parsed.name,
      description: parsed.description || null,
      system_prompt: parsed.system_prompt || null,
      llm_provider: parsed.llm_provider || "openrouter",
      llm_model: parsed.llm_model || "openai/gpt-4o-mini",
      temperature: parsed.temperature ?? 0.7,
      max_tokens: parsed.max_tokens ?? 4096,
      tools: parsed.tools || {},
    });
    setImporting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Imported "${parsed.name}"`);
    reset();
    setOpen(false);
    onImported();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import Agent</DialogTitle>
        </DialogHeader>

        {!parsed ? (
          <div
            {...(getRootProps() as React.HTMLAttributes<HTMLDivElement>)}
            className={cn(
              "border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-all",
              isDragActive
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50",
            )}
          >
            <input {...(getInputProps() as React.InputHTMLAttributes<HTMLInputElement>)} />
            <UploadCloud className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="font-medium">Drag and drop an agent.json or CrewAI YAML file here</p>
            <p className="text-xs text-muted-foreground mt-2">
              or click to browse — supports .json, .yaml, .yml
            </p>
          </div>
        ) : (
          <Card className="p-4 border-primary/40 bg-primary/5">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="rounded-md bg-primary/10 p-2">
                  <FileCheck2 className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{filename}</p>
                  <p className="font-semibold mt-1">Successfully loaded: {parsed.name}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Requires {parsed.toolCount} {parsed.toolCount === 1 ? "tool" : "tools"} • Model:{" "}
                    {parsed.llm_provider}/{parsed.llm_model}
                  </p>
                  {parsed.description && (
                    <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                      {parsed.description}
                    </p>
                  )}
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={reset}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </Card>
        )}

        {parsed && (
          <Button onClick={handleImport} disabled={importing} className="w-full">
            {importing ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Importing...
              </>
            ) : (
              "Add to my agents"
            )}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
