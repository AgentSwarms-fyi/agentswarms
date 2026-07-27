import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader2, Sparkles, Save } from "lucide-react";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { parseModelChoice } from "@/utils/providers/modelChoice";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** When provided, the dialog opens in edit mode for this skill. */
  initial?: {
    id: string;
    name: string;
    description: string | null;
    body: string;
    tags: string[];
  } | null;
};

export function SkillEditorDialog({ open, onOpenChange, onSaved, initial }: Props) {
  const editing = !!initial?.id;
  const [tab, setTab] = useState<string>(editing ? "manual" : "ai");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [brief, setBrief] = useState("");
  // Encoded "provider::model"; null means let the server decide
  // (the caller's default integration, then the operator fallback).
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab(editing ? "manual" : "ai");
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setBody(initial?.body ?? "");
    setTags((initial?.tags ?? []).join(", "));
    setBrief("");
  }, [open, editing, initial]);

  const handleGenerate = async () => {
    if (!brief.trim()) {
      toast.error("Describe what the skill should do.");
      return;
    }
    const picked = parseModelChoice(modelChoice);
    setGenerating(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not signed in");
      const resp = await fetch("/api/skills/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          brief: brief.trim(),
          ...(picked?.provider ? { provider: picked.provider } : {}),
          ...(picked?.model ? { model: picked.model } : {}),
        }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(txt || `Generation failed (${resp.status})`);
      }
      const data = (await resp.json()) as {
        name?: string;
        description?: string;
        body?: string;
        tags?: string[];
      };
      if (data.name) setName(data.name);
      if (data.description) setDescription(data.description);
      if (data.body) setBody(data.body);
      if (Array.isArray(data.tags)) setTags(data.tags.join(", "));
      setTab("manual");
      toast.success("Skill draft generated. Review and save.");
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Failed to generate");
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim() || !body.trim()) {
      toast.error("Name and body are required.");
      return;
    }
    setSaving(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");
      const tagArr = tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        body: body,
        tags: tagArr,
      };
      if (editing && initial?.id) {
        const { error } = await supabase.from("agent_skills").update(payload).eq("id", initial.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("agent_skills")
          .insert({ ...payload, user_id: user.id });
        if (error) throw error;
      }
      toast.success(editing ? "Skill updated" : "Skill saved");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      console.error(e);
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit skill" : "Create a new skill"}</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="ai" disabled={editing}>
              <Sparkles className="mr-2 h-4 w-4" /> Generate with AI
            </TabsTrigger>
            <TabsTrigger value="manual">Write manually</TabsTrigger>
          </TabsList>

          <TabsContent value="ai" className="space-y-3 pt-3">
            <p className="text-xs text-muted-foreground">
              Describe what the skill should teach the agent (when to use it, what steps to follow,
              what to avoid). The AI will draft a properly structured skill.md with frontmatter,
              <em> When to use</em>, <em>Instructions</em>, <em>Examples</em>, and{" "}
              <em>Constraints</em>.
            </p>
            <Textarea
              rows={6}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder='e.g. "Triage incoming bug reports: classify severity, ask for repro steps when missing, and suggest the team to route it to."'
            />
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[16rem] flex-1">
                <Label className="mb-1.5 block text-xs">Model</Label>
                <BiModelSelect
                  value={modelChoice}
                  onChange={setModelChoice}
                  allowUnset
                  className="w-full"
                />
              </div>
              <Button onClick={handleGenerate} disabled={generating || !brief.trim()}>
                {generating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Generate skill
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Runs on the provider you pick, billed to that integration. Leave it on the default and
              the server uses your default integration.
            </p>
          </TabsContent>

          <TabsContent value="manual" className="space-y-3 pt-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="skill-name">Name</Label>
                <Input
                  id="skill-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Bug Triager"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="skill-tags">Tags (comma-separated)</Label>
                <Input
                  id="skill-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="support, engineering"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-desc">One-line description</Label>
              <Input
                id="skill-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Triage incoming bug reports and route them to the right team."
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-body">Skill body (markdown)</Label>
              <Textarea
                id="skill-body"
                rows={16}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="font-mono text-xs"
                placeholder={`---\nname: ...\ndescription: ...\n---\n\n## When to use\n...\n\n## Instructions\n1. ...\n\n## Examples\n...\n\n## Constraints\n- ...`}
              />
              <p className="text-[11px] text-muted-foreground">
                The full markdown body is injected into the agent's system prompt at run time. Keep
                it focused — one capability per skill.
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim() || !body.trim()}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {editing ? "Update skill" : "Save skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
