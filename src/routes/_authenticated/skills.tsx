import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Wand2, Pencil, Trash2, Copy, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { SAMPLE_SKILLS } from "@/lib/sampleSkills";
import { SkillEditorDialog } from "@/components/skills/SkillEditorDialog";

type SkillRow = {
  id: string;
  name: string;
  description: string | null;
  body: string;
  tags: string[];
  updated_at: string;
};

export const Route = createFileRoute("/_authenticated/skills")({
  component: SkillLibraryPage,
});

function SkillLibraryPage() {
  const [tab, setTab] = useState<string>("mine");
  const [mine, setMine] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SkillRow | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("agent_skills")
      .select("id, name, description, body, tags, updated_at")
      .order("updated_at", { ascending: false });
    if (error) toast.error(error.message);
    setMine((data ?? []) as SkillRow[]);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const handleEdit = (s: SkillRow) => {
    setEditing(s);
    setEditorOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this skill? Agents that reference it will silently drop it.")) return;
    const { error } = await supabase.from("agent_skills").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Skill deleted");
    refresh();
  };

  const handleDuplicateSample = async (sampleId: string) => {
    const sample = SAMPLE_SKILLS.find((s) => s.id === sampleId);
    if (!sample) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.from("agent_skills").insert({
      user_id: user.id,
      name: `${sample.name} (copy)`,
      description: sample.description,
      body: sample.body,
      tags: sample.tags,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Copied to your skills");
    setTab("mine");
    refresh();
  };

  const renderPreview = (body: string) => (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 p-3 text-[11px] leading-relaxed">
      {body}
    </pre>
  );

  return (
    <div className="flex">
      <div className="flex-1 container mx-auto space-y-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
              Library
            </p>
            <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight">
              <Wand2 className="h-6 w-6 text-primary" />
              Skill Library
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Skills are reusable, focused playbooks (Anthropic-style{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">skill.md</code> files) you can
              attach to any agent or swarm node. At run time, every selected skill is composed into
              the agent's effective system prompt — so the same agent can be specialised for
              different jobs just by swapping skills.
            </p>
          </div>
          <Button onClick={handleNew}>
            <Plus className="mr-2 h-4 w-4" />
            New skill
          </Button>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="mine">My skills ({mine.length})</TabsTrigger>
            <TabsTrigger value="samples">Sample skills ({SAMPLE_SKILLS.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="mine" className="pt-4">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : mine.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <BookOpen className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    You haven't created any skills yet. Generate one with AI or write your own.
                  </p>
                  <Button className="mt-4" onClick={handleNew}>
                    <Plus className="mr-2 h-4 w-4" />
                    Create your first skill
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {mine.map((s) => (
                  <Card key={s.id}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base">{s.name}</CardTitle>
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => handleEdit(s)}
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => handleDelete(s.id)}
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      {s.description && (
                        <p className="text-xs text-muted-foreground">{s.description}</p>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {s.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {s.tags.map((t) => (
                            <Badge key={t} variant="secondary" className="text-[10px]">
                              {t}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="link"
                        className="h-auto p-0 text-xs"
                        onClick={() => setPreviewId(previewId === s.id ? null : s.id)}
                      >
                        {previewId === s.id ? "Hide" : "Show"} skill.md
                      </Button>
                      {previewId === s.id && renderPreview(s.body)}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="samples" className="pt-4">
            <p className="mb-3 text-xs text-muted-foreground">
              Built-in skills are always available to every agent. They cannot be edited or deleted,
              but you can duplicate one into your library and customise the copy.
            </p>
            <div className="grid gap-3 lg:grid-cols-2">
              {SAMPLE_SKILLS.map((s) => (
                <Card key={s.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base">{s.name}</CardTitle>
                      <Badge variant="secondary" className="h-5">
                        sample
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{s.description}</p>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex flex-wrap gap-1">
                      {s.tags.map((t) => (
                        <Badge key={t} variant="outline" className="text-[10px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPreviewId(previewId === s.id ? null : s.id)}
                      >
                        {previewId === s.id ? "Hide" : "Show"} skill.md
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleDuplicateSample(s.id)}>
                        <Copy className="mr-2 h-4 w-4" />
                        Duplicate to my skills
                      </Button>
                    </div>
                    {previewId === s.id && renderPreview(s.body)}
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        </Tabs>

        <SkillEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          onSaved={refresh}
          initial={editing}
        />
      </div>
    </div>
  );
}
