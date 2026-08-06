// Add Source dialog for the Knowledge Base "Sources" tab.
// Four kinds:
//   - URL: scraped via Firecrawl (server route /api/kb/ingest-url)
//   - GitHub: walks the repo tree (server route /api/kb/ingest-github)
//   - Upload (file): handled by the existing parseFileToText pipeline; we just
//     write the kb_sources row alongside the knowledge_documents row.
//   - Manual paste: same, kind="manual"
//
// All four are real ingestion paths — no stubs.
import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { parseFileToText } from "@/lib/fileParsers";
import { embedKbDocuments } from "@/utils/tools/kbEmbed.functions";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Globe, GitBranch, UploadCloud, FileText, Loader2, X } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  knowledgeBaseId: string;
  userId: string;
  onAdded: () => void;
  // Hands off to the Connect dialog. Cloud connectors live behind a separate
  // button, and a person looking for Google Drive lands here first — without
  // a pointer they conclude connectors don't exist.
  onConnectInstead?: () => void;
};

export function AddSourceDialog({
  open,
  onOpenChange,
  knowledgeBaseId,
  userId,
  onAdded,
  onConnectInstead,
}: Props) {
  const [tab, setTab] = useState<"file" | "url" | "github" | "manual">("file");
  const [busy, setBusy] = useState(false);
  const embedFn = useServerFn(embedKbDocuments);

  // ── URL state ──────────────────────────────────────────────────────────
  const [url, setUrl] = useState("");
  const [urlLabel, setUrlLabel] = useState("");

  // ── GitHub state ───────────────────────────────────────────────────────
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [globs, setGlobs] = useState("*.md, *.mdx, *.txt");

  // ── Manual paste state ─────────────────────────────────────────────────
  const [manualName, setManualName] = useState("");
  const [manualBody, setManualBody] = useState("");

  // ── File upload state ──────────────────────────────────────────────────
  const [files, setFiles] = useState<{ name: string; content: string; size: number }[]>([]);
  const onDropFiles = useCallback(
    (accepted: File[], rejected: { file?: File; errors?: { message?: string }[] }[]) => {
      rejected?.forEach((r) => {
        const reasons = (r.errors || []).map((e) => e.message).join(", ");
        toast.error(`${r.file?.name || "file"} rejected: ${reasons || "unsupported"}`);
      });
      accepted.forEach(async (file) => {
        if (file.size > 50 * 1024 * 1024) {
          toast.error(`${file.name} exceeds 50MB`);
          return;
        }
        try {
          const text = await parseFileToText(file);
          if (!text || !text.trim()) {
            toast.error(`${file.name}: no extractable text`);
            return;
          }
          setFiles((prev) => [...prev, { name: file.name, content: text, size: file.size }]);
        } catch (err) {
          toast.error(`${file.name}: ${err instanceof Error ? err.message : "could not parse"}`);
        }
      });
    },
    [],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onDropFiles,
    validator: (file: File) => {
      const allowed = [
        ".txt",
        ".md",
        ".markdown",
        ".csv",
        ".tsv",
        ".log",
        ".html",
        ".htm",
        ".xml",
        ".yaml",
        ".yml",
        ".json",
        ".rtf",
        ".pdf",
        ".docx",
      ];
      const lower = file.name.toLowerCase();
      return allowed.some((ext) => lower.endsWith(ext))
        ? null
        : { code: "file-invalid-type", message: `Unsupported. Allowed: ${allowed.join(", ")}` };
    },
    multiple: true,
    maxSize: 50 * 1024 * 1024,
  } as unknown as Parameters<typeof useDropzone>[0]);

  function reset() {
    setUrl("");
    setUrlLabel("");
    setRepo("");
    setBranch("");
    setGlobs("*.md, *.mdx, *.txt");
    setManualName("");
    setManualBody("");
    setFiles([]);
  }

  async function handleSubmit() {
    if (busy) return;
    setBusy(true);
    try {
      if (tab === "url") {
        if (!url.trim()) {
          toast.error("Enter a URL");
          return;
        }
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        const res = await fetch("/api/kb/ingest-url", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            knowledge_base_id: knowledgeBaseId,
            url: url.trim(),
            label: urlLabel.trim() || undefined,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(json.error || `Ingest failed (${res.status})`);
          return;
        }
        toast.success(`Scraped 1 page (${json.chars?.toLocaleString() || "?"} chars)`);
        reset();
        onAdded();
        onOpenChange(false);
      } else if (tab === "github") {
        if (!repo.match(/^[\w.-]+\/[\w.-]+$/)) {
          toast.error("repo must be owner/name");
          return;
        }
        const globList = globs
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        const res = await fetch("/api/kb/ingest-github", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            knowledge_base_id: knowledgeBaseId,
            repo: repo.trim(),
            branch: branch.trim() || undefined,
            globs: globList.length > 0 ? globList : undefined,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(json.error || `Ingest failed (${res.status})`);
          return;
        }
        toast.success(
          `Imported ${json.documents} file${json.documents === 1 ? "" : "s"} from ${repo}@${json.branch}`,
        );
        reset();
        onAdded();
        onOpenChange(false);
      } else if (tab === "manual") {
        if (!manualName.trim() || !manualBody.trim()) {
          toast.error("Name and content are required");
          return;
        }
        // Insert source + doc in a small client-side "transaction" (best-effort).
        const { data: src, error: srcErr } = await supabase
          .from("kb_sources")
          .insert({
            knowledge_base_id: knowledgeBaseId,
            user_id: userId,
            kind: "manual",
            label: manualName.trim(),
            config: {},
            status: "ok",
            last_synced_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (srcErr || !src) {
          toast.error(srcErr?.message || "Could not record source");
          return;
        }
        const { data: insertedDoc, error: docErr } = await supabase
          .from("knowledge_documents")
          .insert({
            knowledge_base_id: knowledgeBaseId,
            user_id: userId,
            source_id: src.id,
            name: manualName.trim(),
            content: manualBody,
            metadata: { source: "manual" },
          })
          .select("id")
          .single();
        if (docErr || !insertedDoc) {
          toast.error(docErr?.message || "Insert failed");
          return;
        }
        try {
          await embedFn({ data: { documentIds: [insertedDoc.id] } });
        } catch (err) {
          console.warn("[AddSourceDialog] embedding failed:", err);
        }
        toast.success("Document added");
        reset();
        onAdded();
        onOpenChange(false);
      } else {
        // file
        if (files.length === 0) {
          toast.error("Drop at least one file");
          return;
        }
        const newDocIds: string[] = [];
        for (const f of files) {
          const ext = f.name.split(".").pop()?.toLowerCase() || "";
          const kind = ext === "pdf" ? "pdf" : ext === "csv" ? "csv" : "manual";
          const { data: src, error: srcErr } = await supabase
            .from("kb_sources")
            .insert({
              knowledge_base_id: knowledgeBaseId,
              user_id: userId,
              kind,
              label: f.name,
              config: { filename: f.name, size_bytes: f.size },
              status: "ok",
              last_synced_at: new Date().toISOString(),
            })
            .select("id")
            .single();
          if (srcErr || !src) {
            toast.error(srcErr?.message || `Could not record source for ${f.name}`);
            continue;
          }
          const { data: insertedDoc } = await supabase
            .from("knowledge_documents")
            .insert({
              knowledge_base_id: knowledgeBaseId,
              user_id: userId,
              source_id: src.id,
              name: f.name,
              content: f.content,
              metadata: { source: "upload", size_bytes: f.size },
            })
            .select("id")
            .single();
          if (insertedDoc) newDocIds.push(insertedDoc.id);
        }
        if (newDocIds.length > 0) {
          try {
            await embedFn({ data: { documentIds: newDocIds } });
          } catch (err) {
            console.warn("[AddSourceDialog] embedding failed:", err);
          }
        }
        toast.success(`${files.length} file${files.length === 1 ? "" : "s"} added`);
        reset();
        onAdded();
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Source</DialogTitle>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="w-full">
            <TabsTrigger value="file" className="flex-1">
              <UploadCloud className="h-3 w-3 mr-1" /> File
            </TabsTrigger>
            <TabsTrigger value="url" className="flex-1">
              <Globe className="h-3 w-3 mr-1" /> URL
            </TabsTrigger>
            <TabsTrigger value="github" className="flex-1">
              <GitBranch className="h-3 w-3 mr-1" /> GitHub
            </TabsTrigger>
            <TabsTrigger value="manual" className="flex-1">
              <FileText className="h-3 w-3 mr-1" /> Manual
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="space-y-3 mt-4">
            <div
              {...(getRootProps() as React.HTMLAttributes<HTMLDivElement>)}
              className={cn(
                "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all",
                isDragActive
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50",
              )}
            >
              <input {...(getInputProps() as React.InputHTMLAttributes<HTMLInputElement>)} />
              <div
                className={cn(
                  "mx-auto mb-2.5 grid h-11 w-11 place-items-center rounded-xl transition-colors",
                  isDragActive ? "bg-primary/20 text-primary" : "bg-primary/10 text-primary",
                )}
              >
                <UploadCloud className="h-5 w-5" />
              </div>
              <p className="text-sm font-medium">
                {isDragActive ? "Drop to add" : "Drop files here or click to browse"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                PDF, DOCX, TXT, MD, CSV, JSON, HTML — up to 50MB each
              </p>
            </div>
            {files.length > 0 && (
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {files.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{f.name}</span>
                      <span className="text-muted-foreground shrink-0">
                        ({(f.size / 1024).toFixed(1)} KB)
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => setFiles((p) => p.filter((_, idx) => idx !== i))}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="url" className="space-y-3 mt-4">
            <div className="space-y-1">
              <Label className="text-xs">URL to scrape</Label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/docs/intro"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Label (optional)</Label>
              <Input
                value={urlLabel}
                onChange={(e) => setUrlLabel(e.target.value)}
                placeholder="Defaults to page title"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Powered by Firecrawl. Only the page's main content is captured (no nav / footer).
              Re-sync any time to refresh.
            </p>
          </TabsContent>

          <TabsContent value="github" className="space-y-3 mt-4">
            <div className="space-y-1">
              <Label className="text-xs">Repo (owner/name)</Label>
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="vercel/next.js"
                className="font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Branch (optional)</Label>
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">File patterns</Label>
                <Input
                  value={globs}
                  onChange={(e) => setGlobs(e.target.value)}
                  placeholder="*.md, *.mdx, *.txt"
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Walks the repo's git tree and imports up to 50 matching files (≤1 MB each). Public
              repos work without auth; rate-limited to 60 reqs/h unless GITHUB_TOKEN is configured.
            </p>
          </TabsContent>

          <TabsContent value="manual" className="space-y-3 mt-4">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="Product FAQ"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Content</Label>
              <Textarea
                rows={8}
                value={manualBody}
                onChange={(e) => setManualBody(e.target.value)}
                placeholder="Paste your text here…"
              />
            </div>
          </TabsContent>
        </Tabs>

        <Button onClick={handleSubmit} disabled={busy} className="w-full mt-4">
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Working…
            </>
          ) : (
            "Add source"
          )}
        </Button>
        {onConnectInstead && (
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Google Drive, Notion, SharePoint or Dropbox?{" "}
            <button
              type="button"
              onClick={onConnectInstead}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Connect a source
            </button>{" "}
            instead.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
