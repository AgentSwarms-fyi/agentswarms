// Reusable picker that shows built-in + user prompts in a popover, lets the
// user search, preview, and "Use this prompt" — which calls onPick(content).
//
// Used by AgentForm (System Prompt field) and the Swarm NodeInspector
// (per-node system prompt). Stateless and dependency-light so it can be
// dropped into any form.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Library, Search, BookMarked, User, Plus, ExternalLink } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  BUILT_IN_PROMPTS,
  PROMPT_CATEGORIES,
  type BuiltInPrompt,
  type PromptCategory,
} from "@/lib/promptLibrary";

type UserPrompt = {
  id: string;
  title: string;
  description: string | null;
  category: string;
  tags: string[];
  content: string;
};

type PickedPrompt = {
  source: "builtin" | "user";
  id: string;
  title: string;
  content: string;
};

type Props = {
  /** Called with the chosen prompt's text — caller decides what to do (replace / append). */
  onPick: (prompt: PickedPrompt) => void;
  /** Optional override for the trigger button label. */
  buttonLabel?: string;
  /** Compact icon-only trigger (used inside swarm node inspector). */
  iconOnly?: boolean;
  align?: "start" | "center" | "end";
};

export function PromptLibraryPicker({
  onPick,
  buttonLabel = "Use prompt from Library",
  iconOnly = false,
  align = "end",
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"builtin" | "mine">("builtin");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PromptCategory | "all">("all");
  const [userPrompts, setUserPrompts] = useState<UserPrompt[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Lazy-load user prompts the first time the popover opens.
  useEffect(() => {
    if (!open || userPrompts.length > 0) return;
    (async () => {
      const { data } = await supabase
        .from("user_prompts")
        .select("id, title, description, category, tags, content")
        .order("updated_at", { ascending: false });
      if (data) setUserPrompts(data as UserPrompt[]);
    })();
  }, [open, userPrompts.length]);

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

  const allItems: Array<BuiltInPrompt | UserPrompt> =
    tab === "builtin" ? filteredBuiltins : filteredUser;
  const preview = allItems.find((p) => p.id === previewId) ?? allItems[0];

  function handlePick(item: BuiltInPrompt | UserPrompt) {
    onPick({
      source: tab === "mine" ? "user" : "builtin",
      id: item.id,
      title: item.title,
      content: item.content,
    });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {iconOnly ? (
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5">
            <Library className="h-3.5 w-3.5" />
            <span className="text-xs">Library</span>
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" className="gap-1.5">
            <Library className="h-3.5 w-3.5" />
            {buttonLabel}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side="bottom"
        className="w-[min(680px,var(--radix-popover-content-available-width))] max-h-[min(520px,var(--radix-popover-content-available-height))] p-0 overflow-hidden flex flex-col"
        sideOffset={6}
        collisionPadding={12}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <BookMarked className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Prompt Library</span>
          </div>
          <Button asChild variant="ghost" size="sm" className="h-7 text-xs gap-1">
            <Link to="/prompts" onClick={() => setOpen(false)}>
              Manage <ExternalLink className="h-3 w-3" />
            </Link>
          </Button>
        </div>

        <div className="p-3 space-y-3 flex-1 min-h-0 flex flex-col overflow-hidden">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "builtin" | "mine")}>
            <TabsList className="grid w-full grid-cols-2 h-8">
              <TabsTrigger value="builtin" className="text-xs gap-1.5">
                <BookMarked className="h-3 w-3" />
                Built-in ({BUILT_IN_PROMPTS.length})
              </TabsTrigger>
              <TabsTrigger value="mine" className="text-xs gap-1.5">
                <User className="h-3 w-3" />
                My Prompts ({userPrompts.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by title, description, or tag…"
                className="h-8 pl-7 text-xs"
              />
            </div>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as PromptCategory | "all")}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">All categories</option>
              {PROMPT_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {/* Height comes from the flex parent, which is bounded by the
              popover's own max-height. A fixed h-[...] keyed to 100vh ignored
              how much room the popover actually got — inside a dialog that is
              far less than the viewport — so the panes overflowed and were
              clipped by the overflow-hidden above. */}
          <div className="grid grid-cols-2 gap-3 flex-1 min-h-0 min-w-0">
            {/* List */}
            <div className="border border-border rounded-md min-w-0 min-h-0 overflow-y-auto overscroll-contain">
              <div className="p-1.5 space-y-1">
                {allItems.length === 0 ? (
                  <div className="text-center py-8 text-xs text-muted-foreground">
                    {tab === "mine" ? (
                      <>
                        No saved prompts yet.
                        <br />
                        <Link
                          to="/prompts"
                          className="text-primary underline mt-2 inline-flex items-center gap-1"
                          onClick={() => setOpen(false)}
                        >
                          <Plus className="h-3 w-3" /> Create one
                        </Link>
                      </>
                    ) : (
                      "No prompts match your search."
                    )}
                  </div>
                ) : (
                  allItems.map((p) => {
                    const isActive = preview?.id === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPreviewId(p.id)}
                        onDoubleClick={() => handlePick(p)}
                        className={`w-full text-left rounded p-2 text-xs transition-colors ${
                          isActive
                            ? "bg-primary/10 border border-primary/30"
                            : "border border-transparent hover:bg-muted/50"
                        }`}
                      >
                        <div className="font-medium truncate">{p.title}</div>
                        <div className="text-muted-foreground line-clamp-2 mt-0.5 text-[11px]">
                          {("description" in p ? p.description : "") || "—"}
                        </div>
                        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                          <Badge variant="secondary" className="text-[9px] py-0 px-1.5 h-4">
                            {PROMPT_CATEGORIES.find((c) => c.id === p.category)?.label ??
                              p.category}
                          </Badge>
                          {p.tags.slice(0, 2).map((t) => (
                            <span key={t} className="text-[9px] text-muted-foreground">
                              #{t}
                            </span>
                          ))}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Preview */}
            <div className="border border-border rounded-md flex flex-col min-w-0 overflow-hidden">
              {preview ? (
                <>
                  <div className="border-b border-border p-2 min-w-0">
                    <div className="font-semibold text-xs truncate">{preview.title}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                      {("description" in preview ? preview.description : "") || ""}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain">
                    <pre className="p-2 text-[10.5px] leading-relaxed whitespace-pre-wrap break-words font-mono text-foreground/90">
                      {preview.content}
                    </pre>
                  </div>
                  <div className="border-t border-border p-2">
                    <Button
                      type="button"
                      size="sm"
                      className="w-full h-7 text-xs"
                      onClick={() => handlePick(preview)}
                    >
                      Use this prompt
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex-1 grid place-items-center text-xs text-muted-foreground p-4 text-center">
                  Pick a prompt to preview it.
                </div>
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
