// Data & BI -> Enterprise Ontology: the gallery.
//
// An ontology describes the business in its own words — Customers, Orders,
// Shipments, how they connect, what is measured, what must hold true and
// what may be changed — bound to lakehouse tables, so every surface (the
// explorer, metrics, rules, Agent Chat) answers in those terms. This page
// lists the caller's ontologies and the ones shared with them, and starts new
// ones four ways: the sample (one click, real tables), a draft from tables
// (measured, optionally described by AI), an import (Apache Ossie or JSON),
// or a blank model. The workspace is ontology_.$ontologyId.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportFailure } from "@/lib/silentFailureNet";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Database,
  FileUp,
  GitBranch,
  Layers,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Shapes,
  Sigma,
  Sparkles,
  Users,
  Wand2,
  Zap,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useTokenRef } from "@/hooks/use-token-ref";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { relativeTime } from "@/components/ontology/theme";
import {
  ontologyCreate,
  ontologyCreateSample,
  ontologyList,
  ontologyTables,
  type OntologySummary,
} from "@/utils/ontology.functions";
import { ontologyDraftFromTables, type DraftEvidence } from "@/utils/ontologyAi.functions";
import { importOssie } from "@/lib/ontology/ossie";
import { ontologySpecSchema, type OntologySpec } from "@/lib/ontology/spec";
import { cn } from "@/lib/utils";
import { parseModelChoice } from "@/utils/providers/modelChoice";

export const Route = createFileRoute("/_authenticated/ontology")({
  head: () => ({ meta: [{ title: "Enterprise Ontology — AgentSwarms" }] }),
  component: OntologyGallery,
});

type Mode = null | "blank" | "draft" | "import";

function OntologyGallery() {
  const { session } = useAuth();
  const { tokenRef, signedIn } = useTokenRef(session?.access_token);
  const navigate = useNavigate();
  const listFn = useServerFn(ontologyList);
  const sampleFn = useServerFn(ontologyCreateSample);

  const [items, setItems] = useState<OntologySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>(null);
  const [creatingSample, setCreatingSample] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!tokenRef.current) return;
    setRefreshing(true);
    try {
      const res = await listFn({ data: { access_token: tokenRef.current } });
      if (res.ok) {
        setItems(res.ontologies);
        setError(null);
      } else setError(res.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [listFn, tokenRef]);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  const startSample = async () => {
    setCreatingSample(true);
    try {
      const res = await sampleFn({ data: { access_token: tokenRef.current } });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Sample ready: six tables in ${res.schema}, bound to a new ontology`);
      void navigate({ to: "/ontology/$ontologyId", params: { ontologyId: res.id } });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreatingSample(false);
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (o) =>
        !q ||
        o.name.toLowerCase().includes(q) ||
        (o.description ?? "").toLowerCase().includes(q) ||
        o.domains.some((d) => d.toLowerCase().includes(q)),
    );
  }, [items, query]);

  const totals = useMemo(() => {
    const own = (items ?? []).filter((o) => o.role === "owner");
    return {
      ontologies: items?.length ?? 0,
      types: (items ?? []).reduce((n, o) => n + o.counts.objectTypes, 0),
      metrics: (items ?? []).reduce((n, o) => n + o.counts.metrics, 0),
      shared: (items ?? []).length - own.length,
    };
  }, [items]);

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-8 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Data &amp; BI
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            Enterprise Ontology
          </h1>
          <p className="mt-1.5 max-w-3xl text-balance text-muted-foreground">
            Describe the business once — the things it deals in, how they connect, what is measured,
            what must hold true and what may be changed — on top of your lakehouse tables. People,
            dashboards and agents then ask in business words and get governed answers.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw className={cn("mr-1.5 h-4 w-4", refreshing && "animate-spin")} /> Refresh
          </Button>
          <Button variant="outline" onClick={() => setMode("import")}>
            <FileUp className="mr-1.5 h-4 w-4" /> Import
          </Button>
          <Button variant="outline" onClick={() => setMode("draft")}>
            <Wand2 className="mr-1.5 h-4 w-4" /> Draft from tables
          </Button>
          <Button onClick={() => setMode("blank")}>
            <Plus className="mr-1.5 h-4 w-4" /> New ontology
          </Button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <p className="font-medium">The ontologies could not be loaded</p>
            <p className="text-muted-foreground">{error}</p>
          </div>
        </div>
      )}

      {items === null && !error ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-xl border border-border bg-muted/40"
            />
          ))}
        </div>
      ) : items && items.length === 0 ? (
        <Onboarding
          onSample={startSample}
          creatingSample={creatingSample}
          onDraft={() => setMode("draft")}
          onImport={() => setMode("import")}
          onBlank={() => setMode("blank")}
        />
      ) : items ? (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="At a glance">
            <Stat icon={Shapes} label="Ontologies" value={totals.ontologies} />
            <Stat icon={Layers} label="Object types" value={totals.types} />
            <Stat icon={Sigma} label="Metrics" value={totals.metrics} />
            <Stat icon={Users} label="Shared with you" value={totals.shared} />
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, description or domain"
                className="pl-8"
                aria-label="Search ontologies"
              />
            </div>
            <Button variant="ghost" size="sm" onClick={startSample} disabled={creatingSample}>
              {creatingSample ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-4 w-4" />
              )}
              Add the Northwind Outfitters sample
            </Button>
          </div>

          {shown.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Nothing matches “{query}”.
            </p>
          ) : (
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Ontologies">
              {shown.map((o) => (
                <OntologyCard key={o.id} o={o} />
              ))}
            </section>
          )}
        </>
      ) : null}

      <BlankDialog
        open={mode === "blank"}
        onClose={() => setMode(null)}
        tokenRef={tokenRef}
        onCreated={(id) =>
          void navigate({ to: "/ontology/$ontologyId", params: { ontologyId: id } })
        }
      />
      <DraftDialog
        open={mode === "draft"}
        onClose={() => setMode(null)}
        tokenRef={tokenRef}
        onCreated={(id) =>
          void navigate({ to: "/ontology/$ontologyId", params: { ontologyId: id } })
        }
      />
      <ImportDialog
        open={mode === "import"}
        onClose={() => setMode(null)}
        tokenRef={tokenRef}
        onCreated={(id) =>
          void navigate({ to: "/ontology/$ontologyId", params: { ontologyId: id } })
        }
      />
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Shapes; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <p className="text-xl font-semibold tabular-nums leading-none">{value.toLocaleString()}</p>
        <p className="mt-1 text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function CompletenessRing({ score }: { score: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const tone = score >= 80 ? "text-emerald-500" : score >= 50 ? "text-amber-500" : "text-rose-500";
  return (
    <div className="relative h-11 w-11 shrink-0" title={`Model completeness ${score}%`}>
      <svg viewBox="0 0 40 40" className="h-11 w-11 -rotate-90">
        <circle cx="20" cy="20" r={r} className="fill-none stroke-muted" strokeWidth="4" />
        <circle
          cx="20"
          cy="20"
          r={r}
          className={cn("fill-none stroke-current transition-all", tone)}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold tabular-nums">
        {score}%
      </span>
    </div>
  );
}

function OntologyCard({ o }: { o: OntologySummary }) {
  const health = o.health;
  return (
    <Link
      to="/ontology/$ontologyId"
      params={{ ontologyId: o.id }}
      className="group flex flex-col rounded-xl border border-border bg-card p-4 transition hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="truncate font-semibold">{o.name}</h2>
            {o.role === "viewer" && (
              <Badge variant="outline" className="text-[10px]">
                Shared with you
              </Badge>
            )}
            {o.sample && (
              <Badge variant="secondary" className="text-[10px]">
                Sample
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {o.description || "No description yet."}
          </p>
        </div>
        <CompletenessRing score={o.completeness} />
      </div>

      <dl className="mt-4 grid grid-cols-5 gap-1 text-center">
        {(
          [
            ["Types", o.counts.objectTypes],
            ["Links", o.counts.linkTypes],
            ["Metrics", o.counts.metrics],
            ["Rules", o.counts.rules],
            ["Actions", o.counts.actions],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="rounded-md bg-muted/50 px-1 py-1.5">
            <dd className="text-sm font-semibold tabular-nums">{n}</dd>
            <dt className="text-[10px] text-muted-foreground">{label}</dt>
          </div>
        ))}
      </dl>

      {o.domains.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {o.domains.slice(0, 5).map((d) => (
            <span
              key={d}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {d}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5" />
          {o.published_version ? `v${o.published_version} published` : "Draft, not published"}
        </span>
        {health ? (
          <span
            className={cn(
              "flex items-center gap-1",
              health.failed > 0
                ? "text-amber-700 dark:text-amber-400"
                : "text-emerald-700 dark:text-emerald-400",
            )}
            title={`Rules last run ${relativeTime(health.ran_at)}`}
          >
            {health.failed > 0 ? (
              <CircleAlert className="h-3.5 w-3.5" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {health.failed > 0
              ? `${health.failed} rule${health.failed === 1 ? "" : "s"} failing`
              : `${health.passed} rules pass`}
          </span>
        ) : (
          <span>Rules not run</span>
        )}
        <span>{relativeTime(o.updated_at)}</span>
      </div>
    </Link>
  );
}

function Onboarding(props: {
  onSample: () => void;
  creatingSample: boolean;
  onDraft: () => void;
  onImport: () => void;
  onBlank: () => void;
}) {
  const pillars = [
    {
      icon: Network,
      title: "Objects and links, not tables and joins",
      body: "Customers place Orders; Orders contain Products. Explore and search around the business the way people describe it.",
    },
    {
      icon: Sigma,
      title: "Certified metrics on the things they measure",
      body: "Revenue belongs to Orders and can be broken down by the Customer's region — never double counted through a fan-out.",
    },
    {
      icon: ShieldCheck,
      title: "Rules that run, actions that are governed",
      body: "Business rules are checked against the data. Changes go through typed actions with criteria, approval and a full edit log.",
    },
    {
      icon: Zap,
      title: "Grounded AI, open standard",
      body: "Agents answer from the ontology with a trust envelope, not guessed SQL. Exports to Apache Ossie, OWL and JSON.",
    },
  ];
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-5 p-6 sm:p-8">
          <h2 className="font-display text-2xl font-semibold tracking-tight">
            One model of the business, under every answer
          </h2>
          <p className="text-muted-foreground">
            Start with a sample business on real lakehouse tables, draft a model from tables you
            already have, or bring an Apache Ossie model from another tool.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={props.onSample}
              disabled={props.creatingSample}
              className="group flex flex-col items-start gap-1 rounded-xl border border-primary/40 bg-primary/5 p-4 text-left transition hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <span className="flex items-center gap-2 font-medium">
                {props.creatingSample ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 text-primary" />
                )}
                Try the sample
              </span>
              <span className="text-xs text-muted-foreground">
                Northwind Outfitters: six tables, seven types, rules with real violations. About a
                minute.
              </span>
            </button>
            <button
              type="button"
              onClick={props.onDraft}
              className="flex flex-col items-start gap-1 rounded-xl border border-border p-4 text-left transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2 font-medium">
                <Wand2 className="h-4 w-4 text-primary" /> Draft from tables
              </span>
              <span className="text-xs text-muted-foreground">
                Keys and links guessed from your tables, then measured against the data.
              </span>
            </button>
            <button
              type="button"
              onClick={props.onImport}
              className="flex flex-col items-start gap-1 rounded-xl border border-border p-4 text-left transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2 font-medium">
                <FileUp className="h-4 w-4 text-primary" /> Import Apache Ossie
              </span>
              <span className="text-xs text-muted-foreground">
                A semantic model, ontology and mapping from Snowflake, dbt, Databricks…
              </span>
            </button>
            <button
              type="button"
              onClick={props.onBlank}
              className="flex flex-col items-start gap-1 rounded-xl border border-border p-4 text-left transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2 font-medium">
                <Plus className="h-4 w-4 text-primary" /> Start blank
              </span>
              <span className="text-xs text-muted-foreground">
                Model it type by type on the canvas.
              </span>
            </button>
          </div>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2">
          {pillars.map((p) => (
            <div key={p.title} className="space-y-2 bg-muted/30 p-5">
              <p.icon className="h-5 w-5 text-primary" />
              <h3 className="text-sm font-semibold">{p.title}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

type TokenRef = { current: string };

function BlankDialog(props: {
  open: boolean;
  onClose: () => void;
  tokenRef: TokenRef;
  onCreated: (id: string) => void;
}) {
  const createFn = useServerFn(ontologyCreate);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await createFn({
        data: {
          access_token: props.tokenRef.current,
          name: name.trim(),
          description: description.trim() || undefined,
          origin: "blank",
        },
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`Created ${name.trim()}`);
        props.onCreated(res.id);
      }
    } catch (e) {
      reportFailure("save it", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New ontology</DialogTitle>
          <DialogDescription>
            A blank model. Add object types on the canvas, bind each to a table.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="onto-name">Name</Label>
            <Input
              id="onto-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Customer operations"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="onto-desc">What it describes</Label>
            <Textarea
              id="onto-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Who buys from us, what they order and how it reaches them."
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DraftDialog(props: {
  open: boolean;
  onClose: () => void;
  tokenRef: TokenRef;
  onCreated: (id: string) => void;
}) {
  const tablesFn = useServerFn(ontologyTables);
  const draftFn = useServerFn(ontologyDraftFromTables);
  const createFn = useServerFn(ontologyCreate);
  const [tables, setTables] = useState<
    { table: string; columns: { name: string; type: string }[] }[] | null
  >(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [enrich, setEnrich] = useState(true);
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "draft" | "create">(null);
  const [draft, setDraft] = useState<{
    spec: OntologySpec;
    evidence: DraftEvidence;
    warnings: string[];
  } | null>(null);

  useEffect(() => {
    if (!props.open || tables) return;
    void (async () => {
      const res = await tablesFn({ data: { access_token: props.tokenRef.current } });
      if (!res.ok) setLoadErr(res.error);
      else if (!res.enabled) setLoadErr("The lakehouse is not configured on this instance.");
      else setTables(res.tables);
    })();
  }, [props.open, tables, tablesFn, props.tokenRef]);

  const reset = () => {
    setDraft(null);
    setPicked([]);
    setName("");
  };

  const runDraft = async () => {
    setBusy("draft");
    try {
      const res = await draftFn({
        data: {
          access_token: props.tokenRef.current,
          name: name.trim() || "Draft ontology",
          tables: picked,
          enrich,
          ...(enrich && parseModelChoice(modelChoice)
            ? {
                provider: parseModelChoice(modelChoice)!.provider,
                model: parseModelChoice(modelChoice)!.model,
              }
            : {}),
        },
      });
      if (!res.ok) toast.error(res.error);
      else setDraft(res);
    } catch (e) {
      reportFailure("draft the ontology", e);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!draft) return;
    setBusy("create");
    try {
      const res = await createFn({
        data: {
          access_token: props.tokenRef.current,
          name: draft.spec.name,
          spec: draft.spec,
          origin: "draft",
        },
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Draft created — review it, then publish");
        reset();
        props.onCreated(res.id);
      }
    } catch (e) {
      reportFailure("create the ontology", e);
    } finally {
      setBusy(null);
    }
  };

  const visible = (tables ?? []).filter(
    (t) => !filter || t.table.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          props.onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" /> Draft an ontology from tables
          </DialogTitle>
          <DialogDescription>
            Each table becomes an object type and each column a property. Keys and links are guessed
            from names, then measured against the data before you see them; AI adds descriptions,
            labels and synonyms (never structure).
          </DialogDescription>
        </DialogHeader>
        {!draft ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="draft-name">Name</Label>
                <Input
                  id="draft-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Sales operations"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={enrich}
                  onCheckedChange={setEnrich}
                  aria-label="Describe with AI"
                />{" "}
                Describe with AI
              </label>
              {enrich && (
                <div className="w-48" title="The model that writes the descriptions">
                  <BiModelSelect value={modelChoice} onChange={setModelChoice} allowUnset />
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Tables ({picked.length} picked)</Label>
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter"
                  className="h-8 w-48"
                />
              </div>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                {loadErr ? (
                  <p className="p-4 text-sm text-destructive">{loadErr}</p>
                ) : !tables ? (
                  <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Reading the lakehouse…
                  </p>
                ) : visible.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">No tables you can read match.</p>
                ) : (
                  visible.map((t) => (
                    <label
                      key={t.table}
                      className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-0 hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={picked.includes(t.table)}
                        onCheckedChange={(c) =>
                          setPicked((p) =>
                            c ? [...new Set([...p, t.table])] : p.filter((x) => x !== t.table),
                          )
                        }
                      />
                      <Database className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono text-xs">{t.table}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {t.columns.length} columns
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : (
          <DraftReview draft={draft} />
        )}
        <DialogFooter>
          {draft ? (
            <>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Back
              </Button>
              <Button onClick={create} disabled={busy !== null}>
                {busy === "create" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Create
                the ontology
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={props.onClose}>
                Cancel
              </Button>
              <Button onClick={runDraft} disabled={!picked.length || busy !== null}>
                {busy === "draft" ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="mr-1.5 h-4 w-4" />
                )}
                Draft and measure
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DraftReview({
  draft,
}: {
  draft: { spec: OntologySpec; evidence: DraftEvidence; warnings: string[] };
}) {
  const { spec, evidence, warnings } = draft;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-muted/50 p-2">
          <p className="text-lg font-semibold">{spec.objectTypes.length}</p>
          <p className="text-[11px] text-muted-foreground">object types</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <p className="text-lg font-semibold">{spec.linkTypes.length}</p>
          <p className="text-[11px] text-muted-foreground">links kept</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <p className="text-lg font-semibold capitalize">{evidence.ai}</p>
          <p className="text-[11px] text-muted-foreground">AI descriptions</p>
        </div>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Measured
        </p>
        {evidence.keys.map((k) => (
          <p key={`${k.objectType}-key`} className="flex items-center gap-2 text-xs">
            {k.kept ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <CircleAlert className="h-3.5 w-3.5 text-amber-600" />
            )}
            <span className="font-medium">{k.objectType}</span> key {k.properties.join(", ")}:{" "}
            {k.rows === null
              ? "not checked"
              : `${k.distinct?.toLocaleString()} distinct in ${k.rows.toLocaleString()} rows`}
          </p>
        ))}
        {evidence.links.map((l) => (
          <p key={`${l.objectType}-${l.link}`} className="flex items-center gap-2 text-xs">
            {l.kept ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <CircleAlert className="h-3.5 w-3.5 text-amber-600" />
            )}
            <span className="font-medium">{l.objectType}</span>.{l.link} → {l.to}:{" "}
            {l.matchRate === null ? "not measured" : `${Math.round(l.matchRate * 100)}% match`}
            {!l.kept && " — dropped"}
          </p>
        ))}
      </div>
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200">
          {warnings.map((w) => (
            <li key={w}>• {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ImportDialog(props: {
  open: boolean;
  onClose: () => void;
  tokenRef: TokenRef;
  onCreated: (id: string) => void;
}) {
  const createFn = useServerFn(ontologyCreate);
  const [texts, setTexts] = useState<{ name: string; text: string }[]>([]);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const docs = [...texts.map((t) => t.text), ...(paste.trim() ? [paste] : [])];
  const preview = useMemo(():
    { spec: OntologySpec; warnings: string[]; native: boolean } | { error: string } | null => {
    if (!docs.length) return null;
    // Our own JSON first (a full-fidelity copy), then Ossie.
    if (docs.length === 1) {
      try {
        const native = ontologySpecSchema.safeParse(JSON.parse(docs[0]));
        if (native.success) return { spec: native.data, warnings: [], native: true };
      } catch {
        /* not JSON: try Ossie */
      }
    }
    try {
      const r = importOssie(docs);
      return { ...r, native: false };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [docs.join("\u0000")]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const read = await Promise.all(
      [...files].slice(0, 10).map(async (f) => ({ name: f.name, text: await f.text() })),
    );
    setTexts((prev) => [...prev, ...read]);
  };

  const create = async () => {
    if (!preview || "error" in preview) return;
    setBusy(true);
    try {
      const res = await createFn({
        data: {
          access_token: props.tokenRef.current,
          name: preview.spec.name,
          spec: preview.spec,
          origin: "import",
        },
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`Imported ${preview.spec.name}`);
        setTexts([]);
        setPaste("");
        props.onCreated(res.id);
      }
    } catch (e) {
      reportFailure("create the ontology", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-4 w-4 text-primary" /> Import an ontology
          </DialogTitle>
          <DialogDescription>
            Apache Ossie YAML or JSON — a semantic model, and optionally its ontology and mapping
            documents — or an AgentSwarms ontology JSON export. Vendor extensions are kept for the
            round trip.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground hover:bg-muted/40">
            <FileUp className="h-5 w-5" />
            <span>Choose .yaml, .yml or .json files</span>
            <input
              type="file"
              multiple
              accept=".yaml,.yml,.json,application/json,text/yaml"
              className="sr-only"
              onChange={(e) => void onFiles(e.target.files)}
              aria-label="Choose files to import"
            />
          </label>
          {texts.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {texts.map((t, i) => (
                <Badge key={`${t.name}-${i}`} variant="secondary" className="gap-1">
                  {t.name}
                  <button
                    type="button"
                    className="ml-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() => setTexts((p) => p.filter((_, j) => j !== i))}
                    aria-label={`Remove ${t.name}`}
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <Textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="…or paste a document here"
            rows={5}
            className="font-mono text-xs"
            aria-label="Paste a document"
          />
          {preview &&
            ("error" in preview ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {preview.error}
              </p>
            ) : (
              <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs">
                <p className="font-medium">
                  {preview.spec.name} — {preview.spec.objectTypes.length} types,{" "}
                  {preview.spec.linkTypes.length} links,{" "}
                  {preview.spec.objectTypes.reduce((n, t) => n + t.metrics.length, 0)} metrics
                  {preview.native ? " (AgentSwarms JSON)" : " (Apache Ossie)"}
                </p>
                {preview.warnings.slice(0, 8).map((w) => (
                  <p key={w} className="text-amber-800 dark:text-amber-300">
                    • {w}
                  </p>
                ))}
                {preview.warnings.length > 8 && (
                  <p className="text-muted-foreground">…and {preview.warnings.length - 8} more</p>
                )}
              </div>
            ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!preview || "error" in preview || busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
