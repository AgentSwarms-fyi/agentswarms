// Admin → Developer runtime → AI services → Default model.
//
// The one model every surface falls back to: chat, swarms, BI, Ask over an
// ontology, AI SQL, the Sheets assistant, document reading, memory and the
// generators — whenever a section has no model of its own, or its own cannot
// run for the person (provider not connected, IAM model rules).
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportFailure } from "@/lib/silentFailureNet";
import { CircleAlert, Loader2, Sparkles } from "lucide-react";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adminDefaultModelGet,
  adminDefaultModelSet,
  type DefaultModelState,
} from "@/utils/defaultModelAdmin.functions";
import { parseModelChoice } from "@/utils/providers/modelChoice";

export function DefaultModelCard(props: { token: string }) {
  const getFn = useServerFn(adminDefaultModelGet);
  const setFn = useServerFn(adminDefaultModelSet);
  const [state, setState] = useState<DefaultModelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const res = await getFn({ data: { access_token: props.token } });
      if (!res.ok) return setError(res.error);
      setError(null);
      setState(res);
      setDraft(res.spec ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (spec: string | null) => {
    setSaving(true);
    try {
      const res = await setFn({ data: { access_token: props.token, spec } });
      if (!res.ok) return toast.error(res.error);
      toast.success(
        res.spec ? `Default model set to ${res.spec}` : "Default model reset to the built-in one",
      );
      if (res.unavailableToYou) {
        toast.warning(`It can't run for your own account: ${res.unavailableToYou}`, {
          duration: 10000,
        });
      }
      await load();
    } catch (e) {
      reportFailure("save the default model", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby="default-model-title"
      className="space-y-3 rounded-lg border border-primary/30 bg-primary/[0.03] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="default-model-title" className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Default model
        </h3>
        {state && (
          <Badge variant="outline" className="font-mono text-[11px]">
            In force: {state.effective.spec}
            {state.effective.source === "built-in" ? " (built-in)" : ""}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        What every part of the platform runs on when it has no model of its own — agent chat,
        swarms, BI, Ask over an ontology, AI in SQL, the Sheets assistant, document reading, memory
        and the generators — and when its own model can't run for the person (its provider isn't
        connected for them, or their IAM model rules don't allow it). A model chosen in an agent, a
        swarm node, a picker or a section below always comes first.
      </p>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : !state ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : (
        <>
          {!state.installed && (
            <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
              The database does not have this setting yet: apply the migration
              20261031000000_default_model.sql (npx supabase db push --include-all). Until then the
              built-in default, {state.builtIn}, is in force.
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="default-model" className="text-xs">
                provider/model
              </Label>
              <Input
                id="default-model"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={state.builtIn}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">or pick one you can use</Label>
              <BiModelSelect
                value={pick}
                onChange={(v) => {
                  setPick(v);
                  const c = parseModelChoice(v);
                  if (c) setDraft(`${c.provider}/${c.model}`);
                }}
                allowUnset
                unsetLabel="—"
                unsetSub="type it instead"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void save(draft.trim() || null)}
                disabled={saving || !state.installed || draft.trim() === (state.spec ?? "")}
              >
                {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Save
              </Button>
              {state.spec && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void save(null)}
                  disabled={saving || !state.installed}
                >
                  Use built-in
                </Button>
              )}
            </div>
          </div>
          {state.unavailableToYou && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              The default can't run for your own account: {state.unavailableToYou}. People for whom
              it can't run get an error that says so, instead of a reply.
            </p>
          )}
          {state.retiredEnv.length > 0 && (
            <p className="text-xs text-muted-foreground">
              No longer read from the environment:{" "}
              <span className="font-mono">{state.retiredEnv.join(", ")}</span> — set the model here
              (and the per-section ones below) and remove{" "}
              {state.retiredEnv.length === 1 ? "it" : "them"} from .env.
            </p>
          )}
        </>
      )}
    </section>
  );
}
