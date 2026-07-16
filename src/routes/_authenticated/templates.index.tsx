import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Search,
  Play,
  Sparkles,
  Bot,
  BookOpen,
  Shield,
  KeyRound,
  Zap,
  Headphones,
  FlaskConical,
  Mail,
  Code2,
  FileText,
  Network,
  Briefcase,
  HeartPulse,
  Scale,
  Megaphone,
  Wrench,
  Database,
  Globe,
  Terminal,
  PenTool,
  LifeBuoy,
  Bug,
  Siren,
  Users,
  Umbrella,
  Factory,
  GraduationCap,
  ShoppingCart,
} from "lucide-react";
import {
  REAL_TEMPLATES,
  TEMPLATE_CATEGORIES,
  type RealTemplate,
  type TemplateCategory,
} from "@/lib/realTemplates";
import { SWARM_TEMPLATES, type SwarmTemplate } from "@/lib/swarmTemplates";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { ExportSwarmDropdown } from "@/components/swarms/ExportSwarmDropdown";

// Industry → icon for the swarm-template grouping.
const swarmIndustryIcon: Record<SwarmTemplate["category"], typeof Bot> = {
  "Customer Support": Headphones,
  Research: FlaskConical,
  Engineering: Wrench,
  Sales: Mail,
  Marketing: Megaphone,
  "Financial Services": Briefcase,
  Healthcare: HeartPulse,
  Legal: Scale,
  Debugging: Bug,
  Operations: Siren,
  "HR & Talent": Users,
  Insurance: Umbrella,
  Manufacturing: Factory,
  Cybersecurity: Shield,
  Education: GraduationCap,
  Retail: ShoppingCart,
};

// Stable industry order for the tab strip.
const SWARM_INDUSTRY_ORDER: SwarmTemplate["category"][] = [
  "Customer Support",
  "Sales",
  "Marketing",
  "Engineering",
  "Research",
  "Financial Services",
  "Healthcare",
  "Insurance",
  "Manufacturing",
  "Cybersecurity",
  "Education",
  "Retail",
  "Legal",
  "Operations",
  "HR & Talent",
  "Debugging",
];

export const Route = createFileRoute("/_authenticated/templates/")({
  component: TemplatesPage,
});

const categoryIcon: Record<TemplateCategory, typeof Bot> = {
  "Customer Support": Headphones,
  "Research & Analysis": FlaskConical,
  "Knowledge Q&A": BookOpen,
  "Sales & Marketing": Mail,
  Engineering: Code2,
  "Data Processing": Database,
  "Web Research": Globe,
  "Developer Productivity": Terminal,
  "Content & Marketing": PenTool,
  "Support & Operations": LifeBuoy,
};

function TemplatesPage() {
  const [query, setQuery] = useState("");
  const [activeCat, setActiveCat] = useState<"All" | TemplateCategory>("All");
  const [connectedProviders, setConnectedProviders] = useState<Set<string>>(
    new Set(["openrouter"]),
  );
  const [swarmQuery, setSwarmQuery] = useState("");
  const [activeIndustry, setActiveIndustry] = useState<"All" | SwarmTemplate["category"]>("All");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("provider_credentials").select("provider, is_active");
      const set = new Set<string>(["openrouter"]);
      (data || []).forEach((r) => {
        if (r.is_active) set.add(r.provider);
      });
      setConnectedProviders(set);
    })();
  }, []);

  const filtered = useMemo(() => {
    return REAL_TEMPLATES.filter((t) => {
      const matchCat = activeCat === "All" || t.category === activeCat;
      const q = query.toLowerCase().trim();
      const matchQuery =
        !q ||
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tagline.toLowerCase().includes(q);
      return matchCat && matchQuery;
    });
  }, [query, activeCat]);

  // Group swarm templates by industry, applying the search filter first.
  const swarmGroups = useMemo(() => {
    const q = swarmQuery.toLowerCase().trim();
    const matches = SWARM_TEMPLATES.filter((s) => {
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.tagline.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q)
      );
    });
    const byIndustry = new Map<SwarmTemplate["category"], SwarmTemplate[]>();
    for (const s of matches) {
      const list = byIndustry.get(s.category) ?? [];
      list.push(s);
      byIndustry.set(s.category, list);
    }
    const presentIndustries = SWARM_INDUSTRY_ORDER.filter((i) => byIndustry.has(i));
    return { matches, byIndustry, presentIndustries };
  }, [swarmQuery]);

  const visibleSwarms = useMemo(() => {
    if (activeIndustry === "All") return swarmGroups.matches;
    return swarmGroups.byIndustry.get(activeIndustry) ?? [];
  }, [activeIndustry, swarmGroups]);

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            Template Library
          </p>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Start from a real template</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Pick a multi-agent swarm to see several agents collaborate end-to-end, or a single-agent
          template to experiment with one focused agent. Every template is real and runnable.
        </p>
      </div>

      <Tabs defaultValue="swarms" className="w-full">
        <TabsList className="h-10">
          <TabsTrigger value="swarms" className="gap-2">
            <Network className="h-3.5 w-3.5" />
            Multi-agent swarms
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
              {SWARM_TEMPLATES.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="single" className="gap-2">
            <Bot className="h-3.5 w-3.5" />
            Single-agent templates
            <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
              {REAL_TEMPLATES.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        {/* ───────── Swarms tab — grouped by industry ───────── */}
        <TabsContent value="swarms" className="mt-6">
          <p className="text-sm text-muted-foreground mb-5 max-w-2xl">
            Browse swarms by industry. Each swarm is a graph of editable agents you can run
            end-to-end with one click — loading a template opens a guided tour explaining every
            node.
          </p>

          <div className="mb-5 flex flex-col gap-4">
            <div className="relative max-w-xl">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={swarmQuery}
                onChange={(e) => setSwarmQuery(e.target.value)}
                placeholder="Search swarms by name, use case, or industry…"
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <IndustryPill
                label="All industries"
                count={swarmGroups.matches.length}
                active={activeIndustry === "All"}
                onClick={() => setActiveIndustry("All")}
              />
              {swarmGroups.presentIndustries.map((ind) => {
                const Icon = swarmIndustryIcon[ind];
                return (
                  <IndustryPill
                    key={ind}
                    label={ind}
                    icon={Icon}
                    count={swarmGroups.byIndustry.get(ind)?.length ?? 0}
                    active={activeIndustry === ind}
                    onClick={() => setActiveIndustry(ind)}
                  />
                );
              })}
            </div>
          </div>

          {visibleSwarms.length === 0 ? (
            <Card className="p-12 text-center text-muted-foreground">
              <Network className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>No swarms match your search.</p>
            </Card>
          ) : activeIndustry === "All" ? (
            <div className="space-y-10">
              {swarmGroups.presentIndustries.map((ind) => {
                const list = swarmGroups.byIndustry.get(ind) ?? [];
                const Icon = swarmIndustryIcon[ind];
                return (
                  <section key={ind}>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="h-7 w-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Icon className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <h2 className="text-lg font-semibold">{ind}</h2>
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                        {list.length}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                      {list.map((s) => (
                        <SwarmTemplateCard key={s.id} s={s} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {visibleSwarms.map((s) => (
                <SwarmTemplateCard key={s.id} s={s} />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ───────── Single-agent templates tab ───────── */}
        <TabsContent value="single" className="mt-6">
          <div className="mb-6 space-y-4">
            <div className="relative max-w-xl">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search templates by name, use case, or domain..."
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {TEMPLATE_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCat(cat)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                    activeCat === cat
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/40"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <Card className="p-12 text-center text-muted-foreground">
              <Bot className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>No templates match your search.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filtered.map((tpl) => (
                <TemplateCard
                  key={tpl.id}
                  tpl={tpl}
                  connected={!tpl.requiresProvider || connectedProviders.has(tpl.requiresProvider)}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TemplateCard({ tpl, connected }: { tpl: RealTemplate; connected: boolean }) {
  const Icon = categoryIcon[tpl.category] || Bot;
  const navigate = useNavigate();
  const { user } = useAuth();
  const [provisioning, setProvisioning] = useState(false);
  const docCount = tpl.seedDocuments.length;
  const hasApproval = tpl.tools.some((t) => t.type === "human_approval");

  async function handleTryDemo() {
    if (!user || !connected) return;
    navigate({ to: "/templates/$templateId", params: { templateId: tpl.id } });
  }

  async function handleAddToWorkspace() {
    if (!user || !connected) return;
    setProvisioning(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Please sign in");
      const resp = await fetch("/api/templates/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ templateId: tpl.id }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error || "Failed to provision");
      toast.success(
        json.reused
          ? "Demo agent already in your workspace"
          : `Added "${tpl.title}" to your workspace`,
      );
      navigate({ to: "/agents" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add to workspace");
    } finally {
      setProvisioning(false);
    }
  }

  return (
    <Card className="group relative overflow-hidden border-border bg-card hover:border-primary/40 transition-all">
      <div
        className={`absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${tpl.accent} pointer-events-none`}
      />
      <div className="relative p-5 flex flex-col h-full min-h-[320px]">
        <div className="flex items-start justify-between mb-3">
          <div className="h-10 w-10 rounded-lg bg-background border border-border flex items-center justify-center">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {tpl.category}
            </Badge>
            {tpl.requiresProvider && (
              <Badge
                variant="outline"
                className={`text-[10px] gap-1 ${connected ? "border-emerald-500/40 text-emerald-400" : "border-amber-500/40 text-amber-400"}`}
              >
                <KeyRound className="h-2.5 w-2.5" />
                {connected ? `Using ${tpl.requiresProvider}` : `Requires ${tpl.requiresProvider}`}
              </Badge>
            )}
          </div>
        </div>

        <h3 className="font-semibold text-base mb-1">{tpl.title}</h3>
        <p className="text-xs text-muted-foreground mb-2">{tpl.tagline}</p>
        <p className="text-sm text-muted-foreground/80 leading-relaxed mb-4 line-clamp-2">
          {tpl.description}
        </p>

        <div className="flex flex-wrap gap-1.5 mb-3 text-[10px]">
          <Badge variant="secondary" className="gap-1 font-normal">
            <Zap className="h-2.5 w-2.5" /> {tpl.modelLabel}
          </Badge>
          {docCount > 0 && (
            <Badge variant="secondary" className="gap-1 font-normal">
              <FileText className="h-2.5 w-2.5" /> {docCount} seed docs
            </Badge>
          )}
          {hasApproval && (
            <Badge variant="secondary" className="gap-1 font-normal">
              <Shield className="h-2.5 w-2.5" /> HITL approval
            </Badge>
          )}
          {tpl.guardrails.enforceCitations && (
            <Badge variant="secondary" className="gap-1 font-normal">
              <BookOpen className="h-2.5 w-2.5" /> Citations enforced
            </Badge>
          )}
        </div>

        <div className="mt-auto flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            onClick={handleTryDemo}
            disabled={!connected}
            title={
              !connected
                ? `Connect ${tpl.requiresProvider} first`
                : "Run the live demo with a guided tour"
            }
          >
            <Play className="h-3.5 w-3.5 mr-1.5" /> Try live demo
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={handleAddToWorkspace}
            disabled={provisioning || !connected}
          >
            {provisioning ? "Adding…" : "Add to workspace"}
          </Button>
        </div>

        {!connected && tpl.requiresProvider && (
          <p className="mt-2 text-[10px] text-amber-400">
            <Link to="/integrations" className="underline">
              Connect {tpl.requiresProvider}
            </Link>{" "}
            to enable this template.
          </p>
        )}
      </div>
    </Card>
  );
}

function IndustryPill({
  label,
  count,
  active,
  onClick,
  icon: Icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  icon?: typeof Bot;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/40"
      }`}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      <span>{label}</span>
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded-full ${active ? "bg-primary-foreground/20" : "bg-muted"}`}
      >
        {count}
      </span>
    </button>
  );
}

function SwarmTemplateCard({ s }: { s: SwarmTemplate }) {
  const Icon = swarmIndustryIcon[s.category] ?? Network;
  return (
    <Card className="p-5 border-border hover:border-primary/40 transition-all flex flex-col">
      <div className="flex items-start justify-between mb-3">
        <div className="h-10 w-10 rounded-lg bg-background border border-border flex items-center justify-center">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
          {s.category} · {s.nodes.length} nodes
        </Badge>
      </div>
      <h3 className="font-semibold text-base mb-1">{s.title}</h3>
      <p className="text-xs text-muted-foreground mb-2">{s.tagline}</p>
      <p className="text-sm text-muted-foreground/80 leading-relaxed mb-4 line-clamp-3">
        {s.description}
      </p>
      {s.caseStudies && s.caseStudies.length > 0 && (
        <div className="mb-4 rounded-md border border-primary/20 bg-primary/5 p-3 space-y-2">
          <p className="text-[10px] uppercase tracking-wider text-primary font-bold">
            Used in production by
          </p>
          <div className="flex flex-wrap gap-1.5">
            {s.caseStudies.map((cs) => (
              <a
                key={cs.org}
                href={cs.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] px-2 py-0.5 rounded-full border border-primary/30 bg-background hover:bg-primary/10 transition-colors"
                title={cs.headline}
              >
                {cs.org}
              </a>
            ))}
          </div>
          <p className="text-[11px] text-foreground/80 leading-relaxed line-clamp-2">
            {s.caseStudies[0].headline}
          </p>
        </div>
      )}
      <div className="mt-auto flex items-center gap-2">
        <Link
          to="/swarms"
          search={{ template: s.id, swarm: undefined, view: "canvas" }}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <Play className="h-3.5 w-3.5" /> Open with guided tour
        </Link>
        <ExportSwarmDropdown
          name={s.title}
          description={s.description}
          nodes={s.nodes}
          edges={s.edges}
        />
      </div>
    </Card>
  );
}
