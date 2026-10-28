// The ontology at a glance: the model as a picture, how complete it is, how
// well it fits the data (rows, keys, link match rates — measured, not
// assumed) and whether its rules hold.
import { useEffect, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Compass,
  GitPullRequest,
  ListChecks,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ModelCanvas } from "@/components/ontology/ModelCanvas";
import { useOntology } from "@/components/ontology/OntologyContext";
import { relativeTime, TypeBadge } from "@/components/ontology/theme";
import {
  ontologyProfile,
  type LinkProfile,
  type TypeProfile,
} from "@/utils/ontologyData.functions";
import { findObjectType } from "@/lib/ontology/spec";
import { validateSpec } from "@/lib/ontology/validate";
import { cn } from "@/lib/utils";

export function OverviewTab() {
  const o = useOntology();
  const profileFn = useServerFn(ontologyProfile);
  const [profile, setProfile] = useState<{ types: TypeProfile[]; links: LinkProfile[] } | null>(
    null,
  );
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const issues = validateSpec(o.spec).issues;

  const loadProfile = async () => {
    setLoading(true);
    try {
      const res = await profileFn({ data: { access_token: o.tokenRef.current, id: o.id } });
      if (res.ok) {
        setProfile(res);
        setProfileErr(null);
      } else setProfileErr(res.error);
    } catch (e) {
      setProfileErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProfile();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const health = o.detail.health;
  const parts = o.detail.completeness.parts;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <section className="space-y-3">
        {o.spec.description && (
          <p className="max-w-3xl text-sm text-muted-foreground">{o.spec.description}</p>
        )}
        <ModelCanvas
          spec={o.spec}
          issues={issues}
          canEdit={o.canEdit}
          onSelectType={(name) => o.go("model", { kind: "type", name })}
          onSelectLink={(from, name) => o.go("model", { kind: "link", from, name })}
          onMove={(pos) =>
            o.setSpec((s) => ({
              ...s,
              objectTypes: s.objectTypes.map((t) =>
                pos.get(t.name) ? { ...t, position: pos.get(t.name) } : t,
              ),
            }))
          }
          className="h-[min(68vh,720px)] min-h-[420px]"
        />
      </section>

      <aside className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <QuickLink icon={Compass} label="Explore objects" onClick={() => o.go("explore")} />
          <QuickLink icon={Bot} label="Ask a question" onClick={() => o.go("ask")} />
          <QuickLink icon={ListChecks} label="Check rules" onClick={() => o.go("rules")} />
          <QuickLink
            icon={Zap}
            label="Actions"
            onClick={() => o.go("actions")}
            badge={o.detail.role === "owner" ? o.detail.pending_actions : 0}
          />
        </div>

        <Panel title="Model completeness" aside={`${o.detail.completeness.score}%`}>
          <div className="space-y-2">
            {parts.map((p) => (
              <div key={p.label}>
                <div className="flex justify-between text-xs">
                  <span>{p.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {p.done}/{p.of}
                  </span>
                </div>
                <Progress value={p.of ? (p.done / p.of) * 100 : 0} className="mt-1 h-1.5" />
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Rules"
          aside={health ? `last run ${relativeTime(health.ran_at)}` : "not run yet"}
        >
          {health ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> {health.passed} pass
              </span>
              <span
                className={cn(
                  "flex items-center gap-1",
                  health.failed ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
                )}
              >
                <CircleAlert className="h-4 w-4" /> {health.failed} failing
              </span>
              {health.errored > 0 && (
                <span className="text-rose-700 dark:text-rose-300">{health.errored} errored</span>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Run the rules to see whether the data holds to the model.
            </p>
          )}
          <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => o.go("rules")}>
            <ListChecks className="mr-1.5 h-4 w-4" /> Open rules
          </Button>
        </Panel>

        <Panel
          title="Fit to the data"
          aside={
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => void loadProfile()}
              disabled={loading}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
          }
        >
          {profileErr ? (
            <p className="text-xs text-destructive">{profileErr}</p>
          ) : !profile ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Measuring against the tables…
            </p>
          ) : (
            <div className="space-y-3">
              <ul className="space-y-1.5">
                {profile.types.map((p) => {
                  const t = findObjectType(o.spec, p.objectType);
                  return (
                    <li
                      key={p.objectType}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() => o.go("explore", { kind: "type", name: p.objectType })}
                        className="min-w-0 text-left"
                      >
                        <TypeBadge type={t} label={p.objectType} />
                      </button>
                      {p.error ? (
                        <span className="truncate text-destructive" title={p.error}>
                          error
                        </span>
                      ) : (
                        <span className="flex items-center gap-2 tabular-nums text-muted-foreground">
                          {p.rows?.toLocaleString()} rows
                          {p.keyUnique === false ? (
                            <span
                              className="rounded bg-rose-500/15 px-1 text-[10px] text-rose-700 dark:text-rose-300"
                              title={`${p.distinctKeys} distinct keys`}
                            >
                              key not unique
                            </span>
                          ) : p.keyUnique ? (
                            <CheckCircle2
                              className="h-3.5 w-3.5 text-emerald-600"
                              aria-label="Key is unique"
                            />
                          ) : null}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {profile.links.length > 0 && (
                <div className="border-t border-border pt-2">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Links that resolve
                  </p>
                  <ul className="space-y-1">
                    {profile.links.map((l) => (
                      <li
                        key={`${l.from}.${l.link}`}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="truncate font-mono">
                          {l.from}.{l.link} → {l.to}
                        </span>
                        <span
                          className={cn(
                            "tabular-nums",
                            l.matchRate === null
                              ? "text-muted-foreground"
                              : l.matchRate >= 0.99
                                ? "text-emerald-700 dark:text-emerald-400"
                                : l.matchRate >= 0.9
                                  ? "text-amber-700 dark:text-amber-400"
                                  : "text-rose-700 dark:text-rose-300",
                          )}
                          title={l.error ?? `${l.checked ?? 0} checked`}
                        >
                          {l.matchRate === null ? "—" : `${(l.matchRate * 100).toFixed(1)}%`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>

        {o.detail.role === "owner" && o.detail.open_proposals > 0 && (
          <button
            type="button"
            onClick={() => o.go("history")}
            className="flex w-full items-center gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3 text-left text-sm"
          >
            <GitPullRequest className="h-4 w-4 text-primary" />
            {o.detail.open_proposals} proposal{o.detail.open_proposals === 1 ? "" : "s"} waiting for
            your review
          </button>
        )}
      </aside>
    </div>
  );
}

function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {typeof aside === "string" ? (
          <span className="text-xs text-muted-foreground">{aside}</span>
        ) : (
          aside
        )}
      </div>
      {children}
    </section>
  );
}

function QuickLink({
  icon: Icon,
  label,
  onClick,
  badge = 0,
}: {
  icon: typeof Bot;
  label: string;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-sm transition hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-4 w-4 text-primary" />
      {label}
      {badge > 0 && (
        <span className="absolute -right-1 -top-1 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">
          {badge}
        </span>
      )}
    </button>
  );
}
