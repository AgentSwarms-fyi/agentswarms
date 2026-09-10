// Configuring one step.
//
// Two halves, deliberately separated: WHAT this step runs, which is different
// for every kind, and HOW the run treats it — when it may start, how often to
// retry, when to give up — which is the same for all fifteen. Mixing them
// meant an author hunting for "retries" in a different place depending on the
// step they had selected.
import { Trash2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  NODE_KIND_LABEL,
  TRIGGER_RULES,
  TRIGGER_RULE_LABEL,
  type WorkflowNode,
  type WorkflowParam,
} from "@/lib/workflows";
import type { WorkflowCandidates } from "@/utils/workflows.functions";
import { ConditionBuilder, Field, HeaderRows, ModelPicker, TemplatedText } from "./inspectorFields";
import { KIND_STYLE } from "./nodeStyles";

type Patch = (patch: Partial<WorkflowNode>) => void;

export function StepInspector({
  node,
  candidates,
  params,
  hasParents,
  onChange,
  onDelete,
}: {
  node: WorkflowNode;
  candidates: WorkflowCandidates;
  /** The workflow's declared parameters, so they can be offered rather than spelt. */
  params: WorkflowParam[];
  hasParents: boolean;
  onChange: Patch;
  onDelete: () => void;
}) {
  const style = KIND_STYLE[node.kind];
  const Icon = style.icon;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={cn("rounded p-1", style.chip)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {NODE_KIND_LABEL[node.kind]}
        </p>
        <button className="text-destructive" title="Delete step" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <Field label="Label">
        <Input
          className="h-7 text-xs"
          placeholder={NODE_KIND_LABEL[node.kind]}
          value={node.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </Field>

      <WhatItRuns node={node} candidates={candidates} params={params} onChange={onChange} />

      <div className="space-y-2 border-t pt-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          How the run treats it
        </p>

        {hasParents ? (
          <Field label="Start this step">
            <Select
              value={node.triggerRule ?? "all_success"}
              onValueChange={(v) => onChange({ triggerRule: v as WorkflowNode["triggerRule"] })}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_RULES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {TRIGGER_RULE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Field label="Retries">
            <Input
              className="h-7 text-xs"
              type="number"
              min={0}
              max={10}
              value={node.retries ?? 0}
              onChange={(e) => onChange({ retries: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
          <Field label="First wait (s)">
            <Input
              className="h-7 text-xs"
              type="number"
              min={1}
              value={node.retryBackoffSeconds ?? 60}
              onChange={(e) =>
                onChange({ retryBackoffSeconds: Math.max(1, Number(e.target.value) || 60) })
              }
            />
          </Field>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          The wait doubles each attempt and stops at an hour. Zero retries means one try.
        </p>

        <Field label="Give up after (minutes)">
          <Input
            className="h-7 text-xs"
            type="number"
            min={1}
            placeholder="platform default"
            value={node.timeoutMinutes ?? ""}
            onChange={(e) =>
              onChange({ timeoutMinutes: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </Field>

        <label className="flex items-center gap-2 text-[11px]">
          <Switch
            checked={Boolean(node.continueOnFailure)}
            onCheckedChange={(v) => onChange({ continueOnFailure: v })}
          />
          Carry on if this step fails
        </label>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Off, a failure here skips everything downstream and reddens the run. On, the workflow
          continues and the failure is tolerated — for the step that refreshes a dashboard, not the
          one that loads the data.
        </p>
      </div>
    </div>
  );
}

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string, label: string) => void;
}) {
  return (
    <Field label={label}>
      <Select
        value={value}
        onValueChange={(v) => onChange(v, options.find((o) => o.value === v)?.label ?? "")}
      >
        <SelectTrigger className="h-7 text-xs">
          <SelectValue placeholder={`Pick a ${label.toLowerCase()}…`} />
        </SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <SelectItem value="__none" disabled>
              You have none yet
            </SelectItem>
          ) : null}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The half that differs per kind. */
function WhatItRuns({
  node,
  candidates,
  params,
  onChange,
}: {
  node: WorkflowNode;
  candidates: WorkflowCandidates;
  params: WorkflowParam[];
  onChange: Patch;
}) {
  const name = (v: string, label: string) => onChange({ targetId: v, label: node.label || label });

  switch (node.kind) {
    case "pipeline":
      return (
        <Picker
          label="Pipeline"
          value={node.targetId ?? ""}
          options={candidates.pipelines.map((p) => ({ value: p.id, label: p.name }))}
          onChange={name}
        />
      );
    case "ml_schedule":
      return (
        <Picker
          label="ML schedule"
          value={node.targetId ?? ""}
          options={candidates.mlSchedules.map((s) => ({
            value: s.id,
            label: `${s.name} · ${s.kind === "batch_predict" ? "batch predict" : "retrain"}`,
          }))}
          onChange={name}
        />
      );
    case "notebook":
      return (
        <Picker
          label="Notebook"
          value={node.targetId ?? ""}
          options={candidates.notebooks.map((n) => ({ value: n.id, label: n.title }))}
          onChange={name}
        />
      );
    case "swarm":
      return (
        <>
          <Picker
            label="Swarm"
            value={node.targetId ?? ""}
            options={candidates.swarms.map((s) => ({ value: s.id, label: s.name }))}
            onChange={name}
          />
          <TemplatedText
            label="Input"
            rows={2}
            placeholder="What to ask it"
            params={params}
            value={node.text ?? ""}
            onChange={(text) => onChange({ text })}
          />
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            The PUBLISHED graph runs, not the draft on the canvas. A swarm that stops at an approval
            fails the step — an unattended run has nobody to ask.
          </p>
        </>
      );
    case "prep_flow":
      return (
        <Picker
          label="Prep flow"
          value={node.targetId ?? ""}
          options={candidates.prepFlows.map((f) => ({ value: f.id, label: f.name }))}
          onChange={name}
        />
      );
    case "dashboard_refresh":
      return (
        <Picker
          label="Dashboard"
          value={node.targetId ?? ""}
          options={candidates.dashboards.map((d) => ({ value: d.id, label: d.name }))}
          onChange={name}
        />
      );
    case "data_monitor":
      return (
        <>
          <Picker
            label="Monitor"
            value={node.targetId ?? ""}
            options={candidates.monitors.map((m) => ({ value: m.id, label: m.name }))}
            onChange={name}
          />
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            An alert fails this step on purpose: putting a monitor in a graph is how you stop what
            comes after it when the data is wrong.
          </p>
        </>
      );
    case "sub_workflow":
      return (
        <Picker
          label="Workflow"
          value={node.targetId ?? ""}
          options={candidates.workflows.map((w) => ({ value: w.id, label: w.name }))}
          onChange={name}
        />
      );
    case "sql_models":
      return (
        <ModelPicker
          selected={node.models ?? []}
          available={candidates.models}
          onChange={(models) => onChange({ models })}
        />
      );
    case "sql":
      return (
        <TemplatedText
          label="Statement"
          rows={4}
          mono
          placeholder="insert into analytics.daily select …"
          params={params}
          value={node.text ?? ""}
          onChange={(text) => onChange({ text })}
          hint="One statement, against schemas you can already write to. Same rules as the lakehouse workbench."
        />
      );
    case "condition":
      return (
        <ConditionBuilder
          text={node.text}
          params={params}
          onChange={(text) => onChange({ text })}
        />
      );
    case "notify":
      return (
        <TemplatedText
          label="Message"
          rows={3}
          placeholder="Nightly load finished."
          params={params}
          value={node.text ?? ""}
          onChange={(text) => onChange({ text })}
        />
      );
    case "wait":
      return (
        <Field label="Wait (seconds)">
          <Input
            className="h-7 text-xs"
            type="number"
            min={1}
            max={86400}
            value={node.waitSeconds ?? 60}
            onChange={(e) => onChange({ waitSeconds: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
      );
    case "approval":
      return (
        <TemplatedText
          label="What to ask"
          rows={3}
          placeholder="Publish the month-end numbers?"
          params={params}
          value={node.text ?? ""}
          onChange={(text) => onChange({ text })}
          hint="The question lands in the approvals inbox beside every other one. The run waits — set a timeout above if it should not wait forever."
        />
      );
    case "http": {
      const http = node.http ?? { method: "POST" as const, url: "" };
      const set = (patch: Partial<NonNullable<WorkflowNode["http"]>>) =>
        onChange({ http: { ...http, ...patch } });
      return (
        <>
          <div className="grid grid-cols-[80px_1fr] gap-2">
            <Field label="Method">
              <Select
                value={http.method}
                onValueChange={(v) => set({ method: v as typeof http.method })}
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <TemplatedText
              label="URL"
              mono
              placeholder="https://hooks.example.com/run"
              params={params}
              value={http.url}
              onChange={(url) => set({ url })}
            />
          </div>
          <HeaderRows
            headers={http.headers}
            secrets={candidates.secrets}
            onChange={(headers) => set({ headers })}
          />
          {http.method !== "GET" ? (
            <TemplatedText
              label="Body"
              rows={3}
              mono
              placeholder='{"day": "…"}'
              params={params}
              value={http.body ?? ""}
              onChange={(body) => set({ body })}
            />
          ) : null}
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Any 2xx counts as success. A header set to a secret is filled in on the server and never
            reaches this page.
          </p>
        </>
      );
    }
  }
}
