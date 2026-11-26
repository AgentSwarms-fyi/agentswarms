// "Also start when a model alerts" in a workflow's settings (R544): which of
// the owner's models, which alerts, and how long to wait between alert starts.
// Switched on, it starts from the models the workflow's own steps work on,
// because that is nearly always what a person means.
import { formatDistanceToNow } from "date-fns";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  ALERT_COOLDOWN_DEFAULT_HOURS,
  ALERT_COOLDOWN_MAX_HOURS,
  ALERT_EVENTS,
  ALERT_EVENT_LABEL,
  ALERT_MAX_MODELS,
  alertNoteLine,
  type AlertNote,
  type AlertTrigger,
} from "@/lib/workflowAlerts";
import type { WorkflowCandidates } from "@/utils/workflows.functions";

const EVENT_HINT = {
  drift: "the rows it scores stop looking like the rows it learned from",
  decay: "measured against real outcomes, it does worse than it did in training",
} as const;

export function AlertTriggerFields({
  value,
  onChange,
  models,
  suggested,
  last,
}: {
  value: AlertTrigger | null;
  onChange: (next: AlertTrigger | null) => void;
  models: WorkflowCandidates["mlModels"];
  /** The models this workflow's own steps work on, offered first. */
  suggested: string[];
  last: AlertNote | null;
}) {
  const on = value !== null;
  const known = new Set(models.map((m) => m.id));
  // A model named in the trigger that is no longer the owner's still shows,
  // so it can be taken out (a save refuses it).
  const gone = (value?.models ?? []).filter((id) => !known.has(id));
  const set = (patch: Partial<AlertTrigger>) => value && onChange({ ...value, ...patch });
  const toggleModel = (id: string, checked: boolean) =>
    set({
      models: checked
        ? [...(value?.models ?? []), id].slice(0, ALERT_MAX_MODELS)
        : (value?.models ?? []).filter((m) => m !== id),
    });
  const ordered = [
    ...models.filter((m) => suggested.includes(m.id)),
    ...models.filter((m) => !suggested.includes(m.id)),
  ];

  return (
    <div className="space-y-2 border-t pt-2">
      <label className="flex items-center gap-2 text-xs">
        <Switch
          checked={on}
          aria-label="Also start when a model alerts"
          onCheckedChange={(v) =>
            onChange(
              v
                ? {
                    models: suggested.filter((id) => known.has(id)).slice(0, ALERT_MAX_MODELS),
                    events: ["drift", "decay"],
                    cooldownHours: ALERT_COOLDOWN_DEFAULT_HOURS,
                  }
                : null,
            )
          }
        />
        Also start when a model alerts
      </label>
      {!on ? (
        <p className="text-[11px] text-muted-foreground">
          Off. Switched on, a model&apos;s drift or accuracy alert starts this workflow, so a
          retrain and promote need nobody to read the notification first.
        </p>
      ) : (
        <div className="space-y-2.5 rounded-md border bg-muted/30 p-2.5">
          <div className="space-y-1">
            <Label className="text-xs">Models</Label>
            {models.length === 0 && gone.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">You have no models yet.</p>
            ) : (
              <div className="max-h-36 space-y-1 overflow-y-auto">
                {ordered.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={value.models.includes(m.id)}
                      onCheckedChange={(c) => toggleModel(m.id, c === true)}
                    />
                    <span className="min-w-0 truncate">{m.name}</span>
                    {suggested.includes(m.id) ? (
                      <span className="text-[10px] text-muted-foreground">in this workflow</span>
                    ) : null}
                  </label>
                ))}
                {gone.map((id) => (
                  <label key={id} className="flex items-center gap-2 text-xs text-destructive">
                    <Checkbox checked onCheckedChange={() => toggleModel(id, false)} />A model that
                    is gone, or is not yours (untick it to save)
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Alerts</Label>
            {ALERT_EVENTS.map((e) => (
              <label key={e} className="flex items-start gap-2 text-xs">
                <Checkbox
                  className="mt-0.5"
                  checked={value.events.includes(e)}
                  onCheckedChange={(c) =>
                    set({
                      events:
                        c === true
                          ? ALERT_EVENTS.filter((x) => x === e || value.events.includes(x))
                          : value.events.filter((x) => x !== e),
                    })
                  }
                />
                <span>
                  {ALERT_EVENT_LABEL[e]}
                  <span className="text-muted-foreground">: {EVENT_HINT[e]}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="alert-cooldown">
              Wait between alert starts (hours)
            </Label>
            <Input
              id="alert-cooldown"
              className="h-8 w-28 text-xs"
              type="number"
              min={1}
              max={ALERT_COOLDOWN_MAX_HOURS}
              value={value.cooldownHours}
              onChange={(e) =>
                set({
                  cooldownHours: Math.min(
                    ALERT_COOLDOWN_MAX_HOURS,
                    Math.max(1, Math.round(Number(e.target.value) || ALERT_COOLDOWN_DEFAULT_HOURS)),
                  ),
                })
              }
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Only alerts on runs you started, about the version in production, start it; each alert
            starts it once. A paused workflow is not started.
          </p>
          {last ? (
            <p className="text-[11px] text-muted-foreground">
              Last alert, {formatDistanceToNow(new Date(last.at), { addSuffix: true })}:{" "}
              {alertNoteLine(last)}.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
