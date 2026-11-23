// Where a model's data comes from and where its answers go (R527): the tables
// it trains on, and the prediction tables, dashboards, agents, schedules and
// pipelines that use it. Read from facts each of those already records.
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import type { MlModelLineage } from "@/lib/mlLineage";
import { mlModelLineage } from "@/utils/ml.functions";

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <ul className="space-y-1 text-sm">{children}</ul>
    </div>
  );
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : null);

export function ModelLineageCard({ modelId, token }: { modelId: string; token: string }) {
  const fn = useServerFn(mlModelLineage);
  const [data, setData] = useState<MlModelLineage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    fn({ data: { access_token: token, model_id: modelId } })
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // Read once per model: a refreshed session token is not a new question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, fn]);

  const feeds = data
    ? data.writes.length +
      data.dashboards.length +
      data.agents.length +
      data.schedules.length +
      data.pipelines.length
    : 0;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <p className="text-sm font-medium">Reads and feeds</p>
          <p className="text-xs text-muted-foreground">
            The tables it learns from, and what uses its answers.
          </p>
        </div>
        {error ? (
          <p className="text-sm text-muted-foreground">This could not be read: {error}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Reading…</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <Group label="Reads">
              {data.reads.map((r) => (
                <li key={r.table} className="font-mono text-xs">
                  {r.table}
                  <span className="ml-1.5 font-sans text-muted-foreground">
                    {r.via === "source" ? "the table it trains on" : "joined in its preparation"}
                  </span>
                </li>
              ))}
            </Group>
            <div className="space-y-3">
              {feeds === 0 ? (
                <Group label="Feeds">
                  <li className="text-muted-foreground">
                    Nothing of yours uses it yet: no batch predictions written to a table, and no
                    dashboard, agent, schedule or pipeline.
                  </li>
                </Group>
              ) : null}
              {data.writes.length > 0 ? (
                <Group label="Predictions written to">
                  {data.writes.map((w) => (
                    <li key={w.table}>
                      <span className="font-mono text-xs">{w.table}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {w.from ? `from ${w.from}, ` : ""}
                        {w.runs} run{w.runs === 1 ? "" : "s"}
                        {when(w.last_at) ? `, last ${when(w.last_at)}` : ""}
                      </span>
                    </li>
                  ))}
                </Group>
              ) : null}
              {data.dashboards.length > 0 ? (
                <Group label="Dashboards drawing its forecast">
                  {data.dashboards.map((d) => (
                    <li key={d.id}>
                      <Link
                        to="/bi/$dashboardId"
                        params={{ dashboardId: d.id }}
                        className="hover:text-primary hover:underline"
                      >
                        {d.name}
                      </Link>
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {d.charts.slice(0, 3).join(", ")}
                        {d.charts.length > 3 ? ", …" : ""}
                      </span>
                    </li>
                  ))}
                </Group>
              ) : null}
              {data.agents.length > 0 ? (
                <Group label="Agents that may predict with it">
                  {data.agents.map((a) => (
                    <li key={a.id}>
                      {a.name}
                      {a.anyModel ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">any model</span>
                      ) : null}
                    </li>
                  ))}
                </Group>
              ) : null}
              {data.schedules.length > 0 ? (
                <Group label="Schedules">
                  {data.schedules.map((s) => (
                    <li key={s.id}>
                      {s.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {s.kind === "retrain" ? "retrains it" : "predicts with it"}
                        {s.is_active ? "" : ", paused"}
                      </span>
                    </li>
                  ))}
                </Group>
              ) : null}
              {data.pipelines.length > 0 ? (
                <Group label="Pipelines that start a schedule">
                  {data.pipelines.map((p) => (
                    <li key={p.id}>
                      <Link
                        to="/etl"
                        search={{ open: p.id } as never}
                        className="hover:text-primary hover:underline"
                      >
                        {p.name}
                      </Link>
                    </li>
                  ))}
                </Group>
              ) : null}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
