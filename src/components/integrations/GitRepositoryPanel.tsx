// Integrations → Git repository (R541): the team's GitHub or GitLab
// repository, connected once and used everywhere a definition is kept as a
// file — ML pipelines and model configurations, notebooks, BI dashboards and
// semantic models. Before this tab the settings were reachable only from
// BI's admin menu, so a data scientist looking for "connect my repo" never
// found them.
import { useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { CheckCircle2, Loader2, PlugZap } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useGitRepositorySettings } from "@/components/git/GitRepositoryFields";
import { gitCheckConnection } from "@/utils/mlRepo.functions";

export function GitRepositoryPanel() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const git = useGitRepositorySettings(token, true);
  const check = useServerFn(gitCheckConnection);
  const [checking, setChecking] = useState(false);
  const [reached, setReached] = useState<{ branch: string; commit: string } | null>(null);

  async function saveAndCheck() {
    if (!(await git.save())) return;
    setChecking(true);
    setReached(null);
    try {
      const res = await check({ data: { accessToken: token } });
      if (!res.ok) throw new Error(res.error);
      setReached({ branch: res.branch, commit: res.commit });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  const folder = git.folder;
  const holds: { path: string; what: ReactNode }[] = [
    {
      path: `${folder}/ml/pipelines/`,
      what: (
        <>
          ML pipelines, one file each. Save, update and import them on{" "}
          <Link to="/ml/pipelines" className="underline">
            ML pipelines
          </Link>
          ; a CI job can deploy a reviewed commit.
        </>
      ),
    },
    {
      path: `${folder}/ml/models/`,
      what: "Each model's configuration, written with the pipelines that train or score it.",
    },
    {
      path: `${folder}/notebooks/`,
      what: "Notebooks as Python files, committed from a notebook's version history.",
    },
    {
      path: `${folder}/dashboards/ · semantic-models/`,
      what: "BI definitions, exported from BI's Git sync.",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Git repository</CardTitle>
        <CardDescription>
          Keep your ML pipelines, model configurations, notebooks and BI definitions as files in
          your own GitHub or GitLab repository, where your team reviews changes in pull requests.
          One repository, used by every page that saves to Git.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {git.loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="max-w-lg space-y-4">
            {git.fields}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void saveAndCheck()}
                disabled={!git.canSave || git.saving || checking}
                className="gap-1.5"
              >
                {git.saving || checking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PlugZap className="h-4 w-4" />
                )}
                Save and check
              </Button>
              {reached && (
                <p
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  role="status"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  Reached {reached.branch} at{" "}
                  <span className="font-mono">{reached.commit.slice(0, 7)}</span>
                </p>
              )}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-sm font-medium">What lives in it</h3>
          <ul className="mt-2 divide-y rounded-md border">
            {holds.map((h) => (
              <li key={h.path} className="grid gap-1 px-3 py-2.5 sm:grid-cols-[16rem_1fr] sm:gap-4">
                <span className="truncate font-mono text-xs">{h.path}</span>
                <span className="text-xs text-muted-foreground">{h.what}</span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
