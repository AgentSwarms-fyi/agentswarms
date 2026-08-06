// Prompt Library page — browse all built-in prompts (read-only), and
// create / edit / delete the user's own saved prompts.
//
// Built-ins are shipped in src/lib/promptLibrary.ts and cannot be removed.
// User prompts are persisted to public.user_prompts (RLS: owner-only).
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import {
  BookMarked,
  Search,
  Plus,
  Pencil,
  Trash2,
  Lock,
  User as UserIcon,
  Copy,
  Eye,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BUILT_IN_PROMPTS, PROMPT_CATEGORIES, type PromptCategory } from "@/lib/promptLibrary";

export const Route = createFileRoute("/_authenticated/prompts")({
  component: PromptsPage,
});

type UserPrompt = {
  id: string;
  title: string;
  description: string | null;
  category: string;
  tags: string[];
  content: string;
  updated_at: string;
};

const EMPTY_FORM = {
  id: null as string | null,
  title: "",
  description: "",
  category: "custom" as PromptCategory,
  tags: "",
  content: "",
};

function PromptsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"builtin" | "mine">("builtin");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PromptCategory | "all">("all");
  const [userPrompts, setUserPrompts] = useState<UserPrompt[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [previewPrompt, setPreviewPrompt] = useState<{
    title: string;
    description?: string | null;
    content: string;
  } | null>(null);

  useEffect(() => {
    loadUserPrompts();
  }, []);

  async function loadUserPrompts() {
    const { data, error } = await supabase
      .from("user_prompts")
      .select("id, title, description, category, tags, content, updated_at")
      .order("updated_at", { ascending: false });
    if (error) {
      toast.error("Failed to load your prompts");
      return;
    }
    if (data) setUserPrompts(data as UserPrompt[]);
  }

  function openNew() {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(p: UserPrompt) {
    setForm({
      id: p.id,
      title: p.title,
      description: p.description ?? "",
      category: (p.category as PromptCategory) ?? "custom",
      tags: p.tags.join(", "),
      content: p.content,
    });
    setDialogOpen(true);
  }

  async function savePrompt() {
    if (!user) return;
    if (!form.title.trim() || !form.content.trim()) {
      toast.error("Title and prompt content are required");
      return;
    }
    setSaving(true);
    const tags = form.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const payload = {
      user_id: user.id,
      title: form.title.trim(),
      description: form.description.trim() || null,
      category: form.category,
      tags,
      content: form.content.trim(),
    };
    const res = form.id
      ? await supabase.from("user_prompts").update(payload).eq("id", form.id)
      : await supabase.from("user_prompts").insert(payload);
    setSaving(false);
    if (res.error) {
      toast.error(res.error.message);
      return;
    }
    toast.success(form.id ? "Prompt updated" : "Prompt saved");
    setDialogOpen(false);
    loadUserPrompts();
  }

  async function deletePrompt(id: string) {
    if (!confirm("Delete this prompt? This cannot be undone.")) return;
    const { error } = await supabase.from("user_prompts").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Prompt deleted");
    loadUserPrompts();
  }

  function copyContent(content: string) {
    navigator.clipboard.writeText(content);
    toast.success("Prompt copied to clipboard");
  }

  const filteredBuiltins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BUILT_IN_PROMPTS.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [query, category]);

  const filteredUser = useMemo(() => {
    const q = query.trim().toLowerCase();
    return userPrompts.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [query, category, userPrompts]);

  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
              Library
            </p>
            <h1 className="font-display text-3xl font-semibold tracking-tight flex items-center gap-2">
              <BookMarked className="h-7 w-7 text-primary" />
              Prompt Library
            </h1>
            <p className="text-muted-foreground mt-1">
              Production-grade system prompts you can drop into any agent. Built-ins ship with the
              app and can't be deleted.
            </p>
          </div>
          <Button onClick={openNew}>
            <Plus className="h-4 w-4 mr-2" /> New Prompt
          </Button>
        </div>

        <div className="flex gap-3 flex-wrap items-center">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, description, or tag…"
              className="pl-9"
            />
          </div>
          <Select value={category} onValueChange={(v) => setCategory(v as PromptCategory | "all")}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {PROMPT_CATEGORIES.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "builtin" | "mine")}>
          <TabsList>
            <TabsTrigger value="builtin" className="gap-2">
              <BookMarked className="h-3.5 w-3.5" />
              Built-in ({BUILT_IN_PROMPTS.length})
            </TabsTrigger>
            <TabsTrigger value="mine" className="gap-2">
              <UserIcon className="h-3.5 w-3.5" />
              My Prompts ({userPrompts.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="builtin" className="mt-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredBuiltins.map((p) => (
                <Card key={p.id} className="border-border/50 flex flex-col">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base leading-tight">{p.title}</CardTitle>
                      <Badge variant="outline" className="shrink-0 text-[10px] gap-1">
                        <Lock className="h-2.5 w-2.5" /> Built-in
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{p.description}</p>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col">
                    <div className="flex items-center gap-1 mb-2 flex-wrap">
                      <Badge variant="secondary" className="text-[10px]">
                        {PROMPT_CATEGORIES.find((c) => c.id === p.category)?.label}
                      </Badge>
                      {p.tags.map((t) => (
                        <span key={t} className="text-[10px] text-muted-foreground">
                          #{t}
                        </span>
                      ))}
                    </div>
                    <pre className="text-[10.5px] leading-relaxed whitespace-pre-wrap font-mono text-foreground/80 line-clamp-[8] mb-3 flex-1">
                      {p.content}
                    </pre>
                    <div className="flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 gap-1.5"
                        onClick={() =>
                          setPreviewPrompt({
                            title: p.title,
                            description: p.description,
                            content: p.content,
                          })
                        }
                      >
                        <Eye className="h-3 w-3" /> Preview
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 gap-1.5"
                        onClick={() => copyContent(p.content)}
                      >
                        <Copy className="h-3 w-3" /> Copy
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            {filteredBuiltins.length === 0 && (
              <Card className="border-dashed">
                <CardContent className="text-center py-12 text-muted-foreground text-sm">
                  No built-in prompts match your search.
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="mine" className="mt-4">
            {filteredUser.length === 0 ? (
              <Card className="border-dashed border-2 border-border/50">
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <BookMarked className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-muted-foreground mb-4">
                    {userPrompts.length === 0
                      ? "You haven't saved any prompts yet."
                      : "No saved prompts match your search."}
                  </p>
                  <Button onClick={openNew}>
                    <Plus className="h-4 w-4 mr-2" /> Create your first prompt
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredUser.map((p) => (
                  <Card key={p.id} className="border-border/50 flex flex-col">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base leading-tight">{p.title}</CardTitle>
                        <Badge variant="default" className="shrink-0 text-[10px]">
                          Mine
                        </Badge>
                      </div>
                      {p.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {p.description}
                        </p>
                      )}
                    </CardHeader>
                    <CardContent className="flex-1 flex flex-col">
                      <div className="flex items-center gap-1 mb-2 flex-wrap">
                        <Badge variant="secondary" className="text-[10px]">
                          {PROMPT_CATEGORIES.find((c) => c.id === p.category)?.label ?? p.category}
                        </Badge>
                        {p.tags.map((t) => (
                          <span key={t} className="text-[10px] text-muted-foreground">
                            #{t}
                          </span>
                        ))}
                      </div>
                      <pre className="text-[10.5px] leading-relaxed whitespace-pre-wrap font-mono text-foreground/80 line-clamp-[8] mb-3 flex-1">
                        {p.content}
                      </pre>
                      <div className="flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() =>
                            setPreviewPrompt({
                              title: p.title,
                              description: p.description,
                              content: p.content,
                            })
                          }
                        >
                          <Eye className="h-3 w-3" /> Preview
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 gap-1.5"
                          onClick={() => copyContent(p.content)}
                        >
                          <Copy className="h-3 w-3" /> Copy
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => deletePrompt(p.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{form.id ? "Edit Prompt" : "Create Prompt"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Title *</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="e.g. Marketing copy reviewer"
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="One-line summary of what this prompt does"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select
                    value={form.category}
                    onValueChange={(v) => setForm({ ...form, category: v as PromptCategory })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROMPT_CATEGORIES.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Tags (comma-separated)</Label>
                  <Input
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    placeholder="marketing, copy, editor"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Prompt content *</Label>
                <Textarea
                  rows={14}
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  placeholder="You are a..."
                  className="font-mono text-xs"
                />
                <p className="text-[10px] text-muted-foreground">
                  Tip: a great system prompt names the role, defines the process step-by-step, gives
                  output format, and lists what the agent should refuse.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={savePrompt} disabled={saving}>
                {saving ? "Saving…" : form.id ? "Save changes" : "Create prompt"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!previewPrompt} onOpenChange={(o) => !o && setPreviewPrompt(null)}>
          <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>{previewPrompt?.title}</DialogTitle>
              {previewPrompt?.description && (
                <p className="text-sm text-muted-foreground">{previewPrompt.description}</p>
              )}
            </DialogHeader>
            <ScrollArea className="flex-1 border border-border rounded-md bg-muted/30">
              <pre className="p-4 text-xs leading-relaxed whitespace-pre-wrap font-mono text-foreground/90">
                {previewPrompt?.content}
              </pre>
            </ScrollArea>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPreviewPrompt(null)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  if (previewPrompt) {
                    copyContent(previewPrompt.content);
                    setPreviewPrompt(null);
                  }
                }}
              >
                <Copy className="h-3.5 w-3.5 mr-2" /> Copy prompt
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
