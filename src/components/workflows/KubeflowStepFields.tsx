// What a Kubeflow pipeline step runs (R540): one of the author's Kubeflow
// connections, a pipeline on it, a version (or whichever is newest when the
// step runs), and a value for each input that version declares.
//
// Read live from the server, so the step offers what is there now, and the
// parameters shown are the version's own: a run given a parameter its
// pipeline does not take, or text for a number, is refused before it starts.
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { type WorkflowNode, type WorkflowParam } from "@/lib/workflows";
import type { KubeflowPipeline, KubeflowVersion } from "@/utils/ml/kubeflowClient.server";
import {
  kubeflowConnectionsList,
  kubeflowPipelinesList,
  kubeflowVersionsList,
} from "@/utils/kubeflow.functions";
import { Field, TemplatedText } from "./inspectorFields";

type Kf = NonNullable<WorkflowNode["kubeflow"]>;

const NEWEST = "__newest";

const TYPE_HINT: Record<string, string> = {
  STRING: "text",
  NUMBER_INTEGER: "whole number",
  NUMBER_DOUBLE: "number",
  BOOLEAN: "true or false",
  LIST: "JSON list",
  STRUCT: "JSON object",
};

export function KubeflowStepFields({
  node,
  params,
  onChange,
}: {
  node: WorkflowNode;
  params: WorkflowParam[];
  onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listConnections = useServerFn(kubeflowConnectionsList);
  const listPipelines = useServerFn(kubeflowPipelinesList);
  const listVersions = useServerFn(kubeflowVersionsList);
  const kf: Kf = node.kubeflow ?? { integrationId: "", pipelineId: "" };
  const set = (patch: Partial<Kf>) => onChange({ kubeflow: { ...kf, ...patch } });

  const [connections, setConnections] = useState<
    { id: string; name: string; active: boolean }[] | null
  >(null);
  const [pipelines, setPipelines] = useState<KubeflowPipeline[] | null>(null);
  const [versions, setVersions] = useState<KubeflowVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let gone = false;
    void listConnections({ data: { access_token: token } }).then((r) => {
      if (gone) return;
      if (r.ok) setConnections(r.connections);
      else setError(r.error);
    });
    return () => {
      gone = true;
    };
    // The list is read once per opened step: a refresh of the session token
    // re-reads nothing the author is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(token)]);

  useEffect(() => {
    setPipelines(null);
    if (!token || !kf.integrationId) return;
    let gone = false;
    setError(null);
    void listPipelines({ data: { access_token: token, integration_id: kf.integrationId } }).then(
      (r) => {
        if (gone) return;
        if (r.ok) setPipelines(r.pipelines);
        else setError(r.error);
      },
    );
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kf.integrationId, Boolean(token)]);

  useEffect(() => {
    setVersions(null);
    if (!token || !kf.integrationId || !kf.pipelineId) return;
    let gone = false;
    void listVersions({
      data: { access_token: token, integration_id: kf.integrationId, pipeline_id: kf.pipelineId },
    }).then((r) => {
      if (gone) return;
      if (r.ok) setVersions(r.versions);
      else setError(r.error);
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kf.integrationId, kf.pipelineId, Boolean(token)]);

  // The inputs shown: the chosen version's, or the newest version's when the
  // step runs whatever is newest.
  const version = versions
    ? kf.versionId
      ? versions.find((v) => v.id === kf.versionId)
      : versions[0]
    : undefined;
  const declared = version?.parameters ?? [];
  const values = kf.parameters ?? {};
  const stray = Object.keys(values).filter((n) => !declared.some((p) => p.name === n));

  const setParam = (name: string, value: string) => {
    const next = { ...values };
    if (value === "") delete next[name];
    else next[name] = value;
    set({ parameters: next });
  };

  if (connections && connections.length === 0) {
    return (
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        No Kubeflow connection yet. Add your Kubeflow Pipelines server under{" "}
        <Link to="/integrations" className="text-primary hover:underline">
          Integrations
        </Link>
        , then come back to pick a pipeline.
      </p>
    );
  }

  return (
    <>
      <Field label="Kubeflow connection">
        <Select
          value={kf.integrationId || undefined}
          onValueChange={(v) =>
            onChange({
              kubeflow: { integrationId: v, pipelineId: "", parameters: {} },
            })
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder={connections ? "Pick a connection…" : "Loading…"} />
          </SelectTrigger>
          <SelectContent>
            {(connections ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
                {c.active ? "" : " (off)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {kf.integrationId ? (
        <Field label="Pipeline">
          <Select
            value={kf.pipelineId || undefined}
            onValueChange={(v) => {
              const p = pipelines?.find((x) => x.id === v);
              onChange({
                label: node.label || p?.name || "",
                kubeflow: {
                  integrationId: kf.integrationId,
                  pipelineId: v,
                  pipelineName: p?.name,
                  parameters: {},
                },
              });
            }}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue
                placeholder={
                  pipelines ? "Pick a pipeline…" : error ? "Could not list them" : "Loading…"
                }
              >
                {kf.pipelineName ?? undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {pipelines && pipelines.length === 0 ? (
                <SelectItem value="__none" disabled>
                  The server has no pipelines yet
                </SelectItem>
              ) : null}
              {(pipelines ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      {kf.pipelineId ? (
        <Field label="Version">
          <Select
            value={kf.versionId || NEWEST}
            onValueChange={(v) => {
              const ver = versions?.find((x) => x.id === v);
              set(
                v === NEWEST
                  ? { versionId: undefined, versionName: undefined }
                  : { versionId: v, versionName: ver?.name },
              );
            }}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue>
                {kf.versionId ? (kf.versionName ?? kf.versionId) : "Newest when the step runs"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEWEST}>Newest when the step runs</SelectItem>
              {(versions ?? []).map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                  {v.createdAt ? ` · ${new Date(v.createdAt).toLocaleDateString()}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      {version
        ? declared.map((p) => (
            <TemplatedText
              key={p.name}
              label={`${p.name} · ${TYPE_HINT[p.type] ?? p.type}${p.optional ? "" : " · required"}`}
              mono
              params={params}
              placeholder={p.default ?? ""}
              value={values[p.name] ?? ""}
              onChange={(v) => setParam(p.name, v)}
            />
          ))
        : null}

      {version && stray.length ? (
        <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-[11px]">
          <p className="text-amber-700 dark:text-amber-400">
            Not inputs of this version, so the step would be refused:
          </p>
          {stray.map((n) => (
            <button
              key={n}
              type="button"
              className="mr-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono"
              onClick={() => setParam(n, "")}
              title={`Remove ${n}`}
            >
              {n} <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

      <p className="text-[10px] leading-relaxed text-muted-foreground">
        The run starts on your Kubeflow with these values (blank keeps the pipeline&apos;s default)
        and the step waits for it to finish. A workflow that gives up on the step leaves the run
        going there.
      </p>
    </>
  );
}
