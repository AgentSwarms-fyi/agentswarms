import { PageHeader } from "@/components/PageHeader";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { usePageIntent } from "@/hooks/use-page-intent";
import { readPageIntent } from "@/lib/pageIntent";
import { sessionUser } from "@/lib/sessionUser";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Pencil, Trash2, Copy, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { SAMPLE_SKILLS } from "@/lib/sampleSkills";
import { SkillEditorDialog } from "@/components/skills/SkillEditorDialog";
import { listClaim } from "@/lib/listClaim";
import { StarButton } from "@/components/StarButton";
import { FavouritesFilter } from "@/components/FavouritesFilter";
import { useFavouritesFilter } from "@/hooks/use-favourites-filter";
import { useRecordOpened } from "@/hooks/use-object-marks";
import { moveToTrash } from "@/hooks/use-trash";
import { RESTORE_HINT } from "@/lib/trash";

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
  // `?new=1` starts a new skill and `?open=<id>` opens one — how search
  // results and the "New" menu link here (src/lib/pageIntent.ts).
  validateSearch: (s: Record<string, unknown>) => readPageIntent(s),
});

function SkillLibraryPage() {
  const search = Route.useSearch();
  const [tab, setTab] = useState<string>("mine");
  const [mine, setMine] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** Why the skills could not be read — see refresh. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SkillRow | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("agent_skills")
      .select("id, name, description, body, tags, updated_at")
      .order("updated_at", { ascending: false });
    if (error) {
      // `setMine(data ?? [])` ran even here, so a 403 produced "My skills (0)",
      // "You haven't created any skills yet." and "Create your first skill" —
      // MEASURED, and still saying it seven seconds later once the toast had
      // gone. The toast was the only trace, and it does not last.
      setLoadError(error.message);
      toast.error(error.message);
      setLoading(false);
      return;
    }
    setLoadError(null);
    setMine((data ?? []) as SkillRow[]);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);
  useRecordOpened("skill", editorOpen ? (editing?.id ?? null) : null);
  const favourites = useFavouritesFilter(
    "skill",
    mine.map((s) => s.id),
  );
  const shownMine = mine.filter((s) => favourites.keep(s.id));

  const handleNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const handleEdit = (s: SkillRow) => {
    setEditing(s);
    setEditorOpen(true);
  };

  // A link here can ask for a new skill or for one skill to be opened in the
  // editor, the way its pencil button does.
  usePageIntent(search, {
    ready: !loading && !loadError,
    noun: "skill",
    onNew: handleNew,
    onOpen: (id) => {
      const skill = mine.find((s) => s.id === id);
      if (!skill) return false;
      setTab("mine");
      handleEdit(skill);
    },
  });

  const handleDelete = async (id: string, name: string) => {
    if (
      !(await confirmAsk({
        title: `Move “${name}” to the trash?`,
        body: `Agents that reference it drop it. ${RESTORE_HINT}`,
        actionLabel: "Move to trash",
      }))
    )
      return;
    const r = await moveToTrash({ kind: "skill", id, name, onRestored: () => void refresh() });
    if (!r.ok) return;
    refresh();
  };

  const handleDuplicateSample = async (sampleId: string) => {
    const sample = SAMPLE_SKILLS.find((s) => s.id === sampleId);
    if (!sample) return;
    const user = await sessionUser();
    // It used to return here in silence: "Duplicate to my skills" did nothing.
    if (!user) {
      toast.error("Not signed in");
      return;
    }
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

  // What the "My skills" tab may claim — same rule as the notebooks list and
  // the prompt library.
  const mineClaim = listClaim({ loaded: !loading, error: loadError, count: mine.length });

  return (
    <div className="flex">
      <div className="container mx-auto min-w-0 flex-1 space-y-6 p-6">
        <PageHeader
          title="Skill Library"
          description="Write reusable playbooks and attach them to any agent or swarm node; they are added to its system prompt when it runs."
          actions={
            <Button onClick={handleNew}>
              <Plus className="mr-2 h-4 w-4" />
              New skill
            </Button>
          }
        />

        <Tabs value={tab} onValueChange={setTab}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList>
              {/* Not mine.length — that is 0 on a failed read. */}
              <TabsTrigger value="mine">My skills ({mineClaim.countLabel})</TabsTrigger>
              <TabsTrigger value="samples">Sample skills ({SAMPLE_SKILLS.length})</TabsTrigger>
            </TabsList>
            {/* Sample skills cannot be starred, so the chip is for "My skills" only. */}
            {tab === "mine" && <FavouritesFilter filter={favourites} />}
          </div>

          <TabsContent value="mine" className="pt-4">
            {mineClaim.message === "error" ? (
              // Not the empty state: "you haven't created any" and "create your
              // first" both assert this account is empty, and a refused read
              // does not support either.
              <Card className="border-destructive/40 bg-destructive/5">
                <CardContent className="py-12 text-center">
                  <BookOpen className="mx-auto mb-3 h-10 w-10 text-destructive" />
                  <p className="text-sm text-destructive">
                    Could not load your skills — {loadError}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Any skills you have created are still there. Reload to try again.
                  </p>
                </CardContent>
              </Card>
            ) : loading ? (
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
                {shownMine.map((s) => (
                  <Card key={s.id}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base">{s.name}</CardTitle>
                        <div className="flex gap-1">
                          <StarButton
                            kind="skill"
                            id={s.id}
                            name={s.name}
                            className="self-center"
                          />
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
                            onClick={() => handleDelete(s.id, s.name)}
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
