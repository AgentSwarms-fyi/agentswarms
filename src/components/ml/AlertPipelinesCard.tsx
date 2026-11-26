// On a model's Automation tab (R544): which of the owner's workflows start
// when this model raises an alert, and what came of the last one. The setting
// lives on the workflow (it is when the workflow runs); this card is where a
// person looking at a drifting model finds out whether anything will act.
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { alertNoteLine, cooldownWords, ALERT_EVENT_LABEL } from "@/lib/workflowAlerts";
import { relTime } from "@/components/ml/mlFormat";
import { modelAlertWorkflows, type ModelAlertWorkflow } from "@/utils/mlConsole.functions";

export function AlertPipelinesCard({ token, modelId }: { token: string; modelId: string }) {
  const fn = useServerFn(modelAlertWorkflows);
  const [rows, setRows] = useState<ModelAlertWorkflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fn({ data: { access_token: token, modelId } })
      .then((res) => {
        if (!live) return;
        if (res.ok) setRows(res.workflows);
        else setError(res.error);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : "Could not read the workflows");
      });
    return () => {
      live = false;
    };
  }, [fn, token, modelId]);

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-2">
          <BellRing className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">When this model alerts</h3>
        </div>
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : rows === null ? (
          <p className="text-xs text-muted-foreground">Reading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            You are notified, and nothing starts. To retrain or promote by itself, open an{" "}
            <Link to="/ml/pipelines" className="underline underline-offset-2">
              ML pipeline
            </Link>
            &apos;s settings and switch on <strong>Also start when a model alerts</strong>.
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map((w) => (
              <li key={w.id} className="space-y-0.5 py-2 first:pt-0 last:pb-0">
                <p className="text-sm">
                  <Link
                    to="/workflows"
                    search={{ open: w.id }}
                    className="font-medium hover:underline"
                  >
                    {w.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    · on {w.events.map((e) => ALERT_EVENT_LABEL[e].toLowerCase()).join(" or ")}
                    {", "}at most once every {cooldownWords(w.cooldownHours)}
                    {w.is_active ? "" : " · paused"}
                  </span>
                </p>
                {w.last ? (
                  <p className="text-xs text-muted-foreground">
                    Last alert {relTime(w.last.at)}: {alertNoteLine(w.last)}.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
