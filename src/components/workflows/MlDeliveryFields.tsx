// What a Promote model or Deploy model step does (R542): which of the owner's
// models, and how. The safe defaults are the ones a new step starts with:
// promote only when the newest version beats production, and deploy by
// serving production.
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  ML_CANARY_MAX_PERCENT,
  pickPlaceholder,
  type MlDeployMode,
  type WorkflowNode,
} from "@/lib/workflows";
import type { WorkflowCandidates } from "@/utils/workflows.functions";
import { Field } from "./inspectorFields";

// Short enough for the inspector's field (FOUND FROM THE UI, R542: "Canary:
// the newest version answers a share" was cut off); the hint below says more.
const MODE_LABEL: Record<MlDeployMode, string> = {
  production: "Serve production",
  canary: "Canary (answers a share)",
  shadow: "Shadow (answers nobody)",
};

const MODE_HINT: Record<MlDeployMode, string> = {
  production:
    "Starts the model's endpoint on its production version, or moves a running one to it. Put it after a Promote step to roll out what was promoted.",
  canary: `The newest version answers this share of real requests beside production, and is taken off again by itself if it fails more than production does. At most ${ML_CANARY_MAX_PERCENT}%: past that, promote it.`,
  shadow:
    "The newest version is sent a copy of every request and its answers are compared with production's; customers only ever get production's.",
};

export function MlDeliveryFields({
  node,
  candidates,
  onChange,
}: {
  node: WorkflowNode;
  candidates: WorkflowCandidates;
  onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  const ml = node.ml ?? {};
  const set = (patch: Partial<NonNullable<WorkflowNode["ml"]>>) =>
    onChange({ ml: { ...ml, ...patch } });
  const model = candidates.mlModels.find((m) => m.id === node.targetId);
  const verb = node.kind === "ml_promote" ? "Promote" : "Deploy";
  const mode: MlDeployMode = ml.mode ?? "production";

  return (
    <>
      <Field label="Model">
        <Select
          value={node.targetId ?? ""}
          onValueChange={(v) => {
            const picked = candidates.mlModels.find((m) => m.id === v);
            onChange({ targetId: v, label: node.label || `${verb} ${picked?.name ?? "model"}` });
          }}
        >
          <SelectTrigger className="h-7 text-xs" aria-label="Model">
            <SelectValue placeholder={pickPlaceholder("Model")} />
          </SelectTrigger>
          <SelectContent>
            {candidates.mlModels.length === 0 ? (
              <SelectItem value="__none" disabled>
                You have no ML models yet
              </SelectItem>
            ) : null}
            {candidates.mlModels.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {node.kind === "ml_promote" ? (
        <>
          <label className="flex items-center gap-2 text-[11px]">
            <Switch
              checked={ml.onlyIfBetter !== false}
              onCheckedChange={(v) => set({ onlyIfBetter: v })}
              aria-label="Only when it beats production"
            />
            Only when it beats production
          </label>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Promotes the newest version the model has trained. When it does not beat production on
            the model&apos;s main score, production is kept and the step still succeeds.
            {model?.gated
              ? " This model's promotions need an approver: the step asks them and waits for an answer."
              : ""}
          </p>
        </>
      ) : (
        <>
          <Field label="How">
            <Select value={mode} onValueChange={(v) => set({ mode: v as MlDeployMode })}>
              <SelectTrigger className="h-7 text-xs" aria-label="How">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MODE_LABEL) as MlDeployMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODE_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {mode === "canary" ? (
            <Field label="Share of requests (%)">
              <Input
                type="number"
                min={1}
                max={ML_CANARY_MAX_PERCENT}
                className="h-7 text-xs"
                value={ml.percent ?? ""}
                onChange={(e) =>
                  set({ percent: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            </Field>
          ) : null}
          <p className="text-[10px] leading-relaxed text-muted-foreground">{MODE_HINT[mode]}</p>
        </>
      )}
    </>
  );
}
