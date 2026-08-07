// Custom component authoring: create, edit, test and delete reusable
// transform nodes (see lib/swarmComponents for the rules and why bindings are
// snapshots rather than live links).
//
// The "Test" button runs the snippet in the SAME Worker sandbox the canvas
// uses, with the same params coercion — so a component that passes here
// behaves identically on a node. One execution path, no second definition.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Play, Plus, Puzzle, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { runSandboxed, safeStringify } from "@/lib/sandbox/jsSandbox";
import {
  coerceParams,
  defaultValues,
  STARTER_CODE,
  validateComponent,
  type ComponentParam,
  type ComponentParamType,
  type SwarmComponent,
} from "@/lib/swarmComponents";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Refresh the palette after the library changes. */
  onChanged: () => void;
};

const EMPTY: SwarmComponent = {
  id: "",
  name: "",
  description: "",
  category: "Custom",
  params: [],
  code: STARTER_CODE,
  version: 1,
};

export function ComponentLibraryDialog({ open, onOpenChange, onChanged }: Props) {
  const { user } = useAuth();
  const [list, setList] = useState<SwarmComponent[]>([]);
  const [draft, setDraft] = useState<SwarmComponent>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [testInput, setTestInput] = useState("Hello from the test harness");
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [testOut, setTestOut] = useState<{ ok: boolean; text: string; logs: string[] } | null>(
    null,
  );
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("swarm_components")
      .select("id, name, description, category, params, code, version, updated_at")
      .order("updated_at", { ascending: false });
    setList((data as unknown as SwarmComponent[]) ?? []);
  }, []);
  useEffect(() => {
    if (open && user?.id) void load();
  }, [open, user?.id, load]);

  const edit = (c: SwarmComponent) => {
    setDraft({ ...c, params: c.params ?? [] });
    setTestValues(defaultValues(c.params ?? []));
    setTestOut(null);
  };

  const patchParam = (i: number, patch: Partial<ComponentParam>) =>
    setDraft((d) => ({
      ...d,
      params: d.params.map((p, idx) => (idx === i ? { ...p, ...patch } : p)),
    }));

  const save = async () => {
    const err = validateComponent(draft);
    if (err) return toast.error(err);
    setSaving(true);
    try {
      if (draft.id) {
        const { error } = await supabase
          .from("swarm_components")
          .update({
            name: draft.name.trim(),
            description: draft.description,
            category: draft.category || "Custom",
            params: draft.params as never,
            code: draft.code,
            // Bump so bound nodes can see that the library moved on.
            version: draft.version + 1,
          })
          .eq("id", draft.id);
        if (error) throw new Error(error.message);
        toast.success(`Saved "${draft.name}" (v${draft.version + 1})`);
      } else {
        const { error } = await supabase.from("swarm_components").insert({
          user_id: user!.id,
          name: draft.name.trim(),
          description: draft.description,
          category: draft.category || "Custom",
          params: draft.params as never,
          code: draft.code,
        });
        if (error) throw new Error(error.message);
        toast.success(`Created "${draft.name}"`);
      }
      await load();
      onChanged();
      setDraft(EMPTY);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: SwarmComponent) => {
    if (
      !window.confirm(
        `Delete "${c.name}"? Nodes already using it keep working — they carry their own snapshot of the code.`,
      )
    )
      return;
    const { error } = await supabase.from("swarm_components").delete().eq("id", c.id);
    if (error) return toast.error(error.message);
    await load();
    onChanged();
    if (draft.id === c.id) setDraft(EMPTY);
  };

  const test = async () => {
    setTesting(true);
    setTestOut(null);
    try {
      const res = await runSandboxed(
        draft.code,
        {
          input: testInput,
          vars: { input: testInput },
          params: coerceParams(draft.params, testValues),
        },
        2000,
      );
      setTestOut({
        ok: res.ok,
        text: res.ok ? safeStringify(res.value) : res.error,
        logs: res.logs ?? [],
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[86vh] p-0 gap-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Puzzle className="h-4 w-4 text-primary" /> Component library
          </DialogTitle>
          <DialogDescription className="text-xs">
            Author a reusable node once — it appears in the palette for every swarm. Code runs in
            the same sandboxed worker as a Function node, so components are canvas-only (headless
            API and scheduled runs refuse custom code).
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Saved components */}
          <aside className="w-56 shrink-0 border-r overflow-y-auto p-2 space-y-1">
            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 text-xs"
              onClick={() => {
                setDraft(EMPTY);
                setTestValues({});
                setTestOut(null);
              }}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> New component
            </Button>
            {list.length === 0 && (
              <p className="p-2 text-[11px] text-muted-foreground">
                No components yet. Author one and it shows up in the palette.
              </p>
            )}
            {list.map((c) => (
              <button
                key={c.id}
                onClick={() => edit(c)}
                className={cn(
                  "w-full rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-accent",
                  draft.id === c.id && "border-primary/50 bg-primary/5",
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-xs font-medium">{c.name}</span>
                  <Badge variant="outline" className="shrink-0 text-[9px] px-1 py-0">
                    v{c.version}
                  </Badge>
                </div>
                <p className="truncate text-[10px] text-muted-foreground">
                  {c.description || c.category}
                </p>
              </button>
            ))}
          </aside>

          {/* Editor */}
          <div className="min-w-0 flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="cmp-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="cmp-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Extract emails"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cmp-cat" className="text-xs">
                  Category
                </Label>
                <Input
                  id="cmp-cat"
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  placeholder="Custom"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cmp-desc" className="text-xs">
                  Description
                </Label>
                <Input
                  id="cmp-desc"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="What it does, in a few words"
                  className="h-8 text-sm"
                />
              </div>
            </div>

            {/* Parameters */}
            <div className="space-y-2 rounded-md border p-2.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold">Parameters</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      params: [
                        ...draft.params,
                        { name: `param_${draft.params.length + 1}`, type: "text" },
                      ],
                    })
                  }
                >
                  <Plus className="h-3 w-3 mr-1" /> Add parameter
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Each parameter becomes a field on the node and is readable in the code as{" "}
                <code className="font-mono">ctx.params.name</code>. Numbers and booleans arrive
                typed, not as strings.
              </p>
              {draft.params.map((p, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <Input
                    value={p.name}
                    onChange={(e) =>
                      patchParam(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })
                    }
                    placeholder="name"
                    aria-label={`Parameter ${i + 1} name`}
                    className="h-7 w-32 font-mono text-xs"
                  />
                  <Select
                    value={p.type}
                    onValueChange={(v) => patchParam(i, { type: v as ComponentParamType })}
                  >
                    <SelectTrigger
                      className="h-7 w-28 text-xs"
                      aria-label={`Parameter ${i + 1} type`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["text", "number", "boolean", "select"].map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={p.label ?? ""}
                    onChange={(e) => patchParam(i, { label: e.target.value })}
                    placeholder="Label"
                    aria-label={`Parameter ${i + 1} label`}
                    className="h-7 flex-1 min-w-[8rem] text-xs"
                  />
                  <Input
                    value={p.default ?? ""}
                    onChange={(e) => patchParam(i, { default: e.target.value })}
                    placeholder="default"
                    aria-label={`Parameter ${i + 1} default`}
                    className="h-7 w-24 text-xs"
                  />
                  {p.type === "select" && (
                    <Input
                      value={(p.options ?? []).join(", ")}
                      onChange={(e) =>
                        patchParam(i, {
                          options: e.target.value
                            .split(",")
                            .map((x) => x.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="a, b, c"
                      aria-label={`Parameter ${i + 1} options`}
                      className="h-7 w-32 text-xs"
                    />
                  )}
                  <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-primary"
                      checked={!!p.required}
                      onChange={(e) => patchParam(i, { required: e.target.checked })}
                    />
                    req
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Delete parameter ${p.name}`}
                    onClick={() =>
                      setDraft({ ...draft, params: draft.params.filter((_, idx) => idx !== i) })
                    }
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>

            {/* Code */}
            <div className="space-y-1.5">
              <Label htmlFor="cmp-code" className="text-xs">
                Code — receives <code className="font-mono">ctx.input</code>,{" "}
                <code className="font-mono">ctx.vars</code>,{" "}
                <code className="font-mono">ctx.params</code>; return a value
              </Label>
              <Textarea
                id="cmp-code"
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                rows={10}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>

            {/* Test harness */}
            <div className="space-y-2 rounded-md border p-2.5">
              <p className="text-xs font-semibold">Test</p>
              <div className="space-y-1.5">
                <Label htmlFor="cmp-test-input" className="text-[10px] text-muted-foreground">
                  ctx.input
                </Label>
                <Textarea
                  id="cmp-test-input"
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  rows={2}
                  className="text-xs"
                />
              </div>
              {draft.params.length > 0 && (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {draft.params.map((p) => (
                    <div key={p.name} className="space-y-0.5">
                      <Label
                        htmlFor={`cmp-test-${p.name}`}
                        className="text-[10px] text-muted-foreground"
                      >
                        {p.label || p.name}
                      </Label>
                      <Input
                        id={`cmp-test-${p.name}`}
                        value={testValues[p.name] ?? p.default ?? ""}
                        onChange={(e) => setTestValues({ ...testValues, [p.name]: e.target.value })}
                        className="h-7 text-xs"
                      />
                    </div>
                  ))}
                </div>
              )}
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => void test()}
                disabled={testing}
              >
                {testing ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1" />
                )}
                Run test
              </Button>
              {testOut && (
                <div
                  className={cn(
                    "rounded-md border p-2 text-xs",
                    testOut.ok
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : "border-destructive/40 bg-destructive/5",
                  )}
                  role="status"
                >
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {testOut.ok ? "Returned" : "Error"}
                  </p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
                    {testOut.text || "(empty)"}
                  </pre>
                  {testOut.logs.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px] text-muted-foreground">
                        console ({testOut.logs.length})
                      </summary>
                      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                        {testOut.logs.join("\n")}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 pb-2">
              <Button onClick={() => void save()} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                <Save className="h-4 w-4 mr-1.5" />
                {draft.id ? `Save as v${draft.version + 1}` : "Create component"}
              </Button>
              {draft.id && (
                <Button variant="outline" onClick={() => void remove(draft)}>
                  <Trash2 className="h-4 w-4 mr-1.5" /> Delete
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
