import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Wand2 } from "lucide-react";
import { SAMPLE_SKILLS } from "@/lib/sampleSkills";

type SkillRow = {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
};

type Props = {
  value: string[];
  onChange: (next: string[]) => void;
};

/**
 * Multi-select picker for Agent Skills (sample + user-saved).
 * Used inside Agent Builder and the Swarm Node Inspector.
 */
export function SkillPicker({ value, onChange }: Props) {
  const [userSkills, setUserSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase
        .from("agent_skills")
        .select("id, name, description, tags")
        .order("updated_at", { ascending: false });
      if (mounted) {
        setUserSkills((data ?? []) as SkillRow[]);
        setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const selected = useMemo(() => new Set(value), [value]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  const renderSkill = (
    s: { id: string; name: string; description: string | null; tags: string[] },
    sample: boolean,
  ) => (
    <label
      key={s.id}
      className="flex cursor-pointer items-start gap-3 rounded-md border border-border/60 bg-card/60 p-3 hover:bg-accent/30"
    >
      <Checkbox
        checked={selected.has(s.id)}
        onCheckedChange={() => toggle(s.id)}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{s.name}</span>
          {sample && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              sample
            </Badge>
          )}
        </div>
        {s.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.description}</p>
        )}
        {s.tags?.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {s.tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2 text-sm">
          <Wand2 className="h-4 w-4 text-primary" />
          Skills
          {value.length > 0 && (
            <Badge variant="outline" className="h-5">
              {value.length} selected
            </Badge>
          )}
        </Label>
        <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
          <Link to="/skills">Manage skill library →</Link>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Skills are reusable playbooks injected into this agent's system prompt at run time. Pick the
        ones that match what this agent should be able to do.
      </p>

      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Built-in samples
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {SAMPLE_SKILLS.map((s) => renderSkill(s, true))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Your skills
        </div>
        {loading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : userSkills.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
            You haven't saved any custom skills yet.{" "}
            <Link to="/skills" className="text-primary underline">
              Create one in the Skill Library
            </Link>
            .
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {userSkills.map((s) => renderSkill(s, false))}
          </div>
        )}
      </div>
    </div>
  );
}
