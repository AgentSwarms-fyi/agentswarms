// NotificationCenter — bell-icon popover in the topbar that surfaces
// in-app announcements (no email blasts). Each announcement is identified
// by a stable `key`; acknowledgements are persisted per-user in
// `user_announcements_dismissed` so they don't reappear after dismissal.
//
// To add a new announcement: append an entry to ANNOUNCEMENTS below with
// a brand-new `key`. Removing/renaming a key would resurface it for users
// who already dismissed it — don't do that.
import { useEffect, useState, useCallback, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Bell,
  Award,
  Check,
  ArrowRight,
  Sparkles,
  Wand2,
  Network,
  ImageIcon,
  BookOpen,
  Code2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type AnnouncementCTA = {
  label: string;
  to: string;
  search?: Record<string, string>;
};

type Announcement = {
  key: string;
  icon: ReactNode;
  iconClassName?: string;
  title: string;
  body: ReactNode;
  ctas?: AnnouncementCTA[];
  // When true, hide for users who already hold a certificate.
  hideIfCertified?: boolean;
};

const ANNOUNCEMENTS: Announcement[] = [
  {
    key: "mastra-voltagent-notebooks-2026q2",
    icon: <Code2 className="h-4 w-4" />,
    iconClassName: "from-primary to-chart-2",
    title: "New: Mastra & VoltAgent notebook tracks",
    body: (
      <>
        <p>
          Two brand-new TypeScript tutorial tracks just landed in{" "}
          <strong className="text-foreground">Notebooks</strong> — built for devs who want to learn
          the hottest TS agent frameworks hands-on, right in your browser.
        </p>
        <ul className="mt-2 ml-4 list-disc space-y-1 text-xs text-muted-foreground">
          <li>
            <strong className="text-foreground">Mastra</strong> — fundamentals, tools, memory, RAG,
            workflows, and evals.
          </li>
          <li>
            <strong className="text-foreground">VoltAgent</strong> — agents, tools, memory, RAG,
            guardrails, MCP, voice, and workflows.
          </li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Every cell runs live against the AgentSwarm AI Gateway — no setup, no API keys. Sample
          knowledge bases included.
        </p>
      </>
    ),
    ctas: [{ label: "Open Notebooks", to: "/notebooks" }],
  },
  {
    key: "ts-notebooks-launch-2026q2",
    icon: <Code2 className="h-4 w-4" />,
    iconClassName: "from-chart-2 to-primary",
    title: "New: TypeScript Notebooks for coding enthusiasts",
    body: (
      <>
        <p>
          Roll up your sleeves and <strong className="text-foreground">build agents in code</strong>
          . Our new <strong className="text-foreground">TypeScript Notebooks</strong> give you
          Jupyter-style cells that run live in your browser — with LangChain, LangGraph, tool
          calling, RAG over your Knowledge Bases, and the AgentSwarm AI Gateway all wired up. No
          setup, no API keys.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Perfect for devs who want to learn agentic AI hands-on: edit cells, run them with
          Shift+Enter, inspect outputs, and remix the worked examples (chat, tools, agents, RAG,
          semantic chunking, and more).
        </p>
      </>
    ),
    ctas: [{ label: "Open Notebooks", to: "/notebooks" }],
  },
  {
    key: "blog-launch-2026q2",
    icon: <BookOpen className="h-4 w-4" />,
    iconClassName: "from-primary to-chart-4",
    title: "New: Latest blogs section is live",
    body: (
      <>
        <p>
          We just launched the <strong className="text-foreground">Blog</strong> — a fresh hub for
          deep-dives, tutorials, and field notes on building with agentic AI. Expect practical
          write-ups on multi-agent patterns, evals, RAG, MCP, tool use, and lessons from real
          production swarms.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          New posts drop regularly — bookmark it, or check back from the top nav. Got a topic you
          want us to cover? Reply to any post and let us know.
        </p>
      </>
    ),
    ctas: [{ label: "Read the latest posts", to: "/blog" }],
  },
  {
    key: "image-gen-nano-banana-2026q2",
    icon: <ImageIcon className="h-4 w-4" />,
    iconClassName: "from-chart-4 to-primary",
    title: "New: Image Playground with Nano Banana 2",
    body: (
      <>
        <p>
          AgentSwarms now has a dedicated{" "}
          <strong className="text-foreground">Image Playground</strong> powered by Gemini Nano
          Banana, Nano Banana 2, and Gemini 3 Pro Image. Pick a model, write a prompt, and download
          the result — no chat history, so you stay clear of token limits.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Upload an image to <strong className="text-foreground">edit</strong> it instead of
          generating from scratch, or reuse any result as the input for the next edit.
        </p>
      </>
    ),
    ctas: [{ label: "Open Image Playground", to: "/image-playground" }],
  },
  {
    key: "demo-howto-kb-2026q2",
    icon: <Sparkles className="h-4 w-4" />,
    iconClassName: "from-primary to-chart-2",
    title: "Ask the Demo Assistant how to use AgentSwarms",
    body: (
      <>
        <p>
          The <strong className="text-foreground">Demo · Friendly Assistant</strong> in the
          Playground now has a curated{" "}
          <strong className="text-foreground">AgentSwarms How-To knowledge base</strong> attached.
          Ask it anything — how to create an agent, build a swarm, add OpenRouter as a provider,
          upload a CSV and query it, attach an MCP server, use guardrails, memory, skills, prompts,
          templates, and more.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          It will tell you the exact page to go to, and clearly say{" "}
          <em>"that isn't supported yet"</em> instead of making things up. If it can't do something
          itself (like searching the web), it'll tell you which tool to enable on the agent.
        </p>
      </>
    ),
    ctas: [
      {
        label: "Open the Playground",
        to: "/playground",
      },
    ],
  },
  {
    key: "chatgpt-vs-swarms-2026q2",
    icon: <Network className="h-4 w-4" />,
    iconClassName: "from-chart-4 to-primary",
    title: "You're using this like ChatGPT. Let's fix that.",
    body: (
      <>
        <p>
          I noticed you're hanging out in the basic chat playground. Single-prompt chat is cool, but
          AgentSwarms is built for{" "}
          <strong className="text-foreground">multi-agent workflows</strong>. Give your agent a
          brain and some hands.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Load the <strong className="text-foreground">Customer Support Triage</strong> swarm
          template and play with it to see how multiple agents communicate to achieve a complex
          task.
        </p>
      </>
    ),
    ctas: [
      {
        label: "Load the support triage swarm",
        to: "/swarms",
        search: { template: "support-triage" },
      },
    ],
  },
  {
    key: "skills-prompt-library-2026q2",
    icon: <Wand2 className="h-4 w-4" />,
    iconClassName: "from-primary to-chart-4",
    title: "New: Skill Library, Prompt Library & AI Skill Generator",
    body: (
      <>
        <p>Three new building blocks just landed to make your agents sharper:</p>
        <ul className="mt-2 ml-4 list-disc space-y-1 text-xs text-muted-foreground">
          <li>
            <strong className="text-foreground">Skill Library</strong> — reusable{" "}
            <span className="font-mono">skill.md</span> playbooks you can attach to any agent or
            swarm node.
          </li>
          <li>
            <strong className="text-foreground">AI Skill Generator</strong> — describe a capability
            in one sentence, get a structured Anthropic-style skill in markdown ready to use.
          </li>
          <li>
            <strong className="text-foreground">Prompt Library</strong> — curated, versioned prompts
            you can drop into agents in one click.
          </li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Open the Skill Library to try the generator, or pick skills directly from the Agent
          Builder and Swarm node inspector.
        </p>
      </>
    ),
    ctas: [
      { label: "Open Skill Library", to: "/skills" },
      { label: "Browse Prompts", to: "/prompts" },
    ],
  },
  {
    key: "cert-free-launch-2026q2",
    icon: <Award className="h-4 w-4" />,
    iconClassName: "from-primary to-nexus-glow",
    title: "Get certified — free for a limited time",
    body: (
      <p>
        Pass our 50-question Agentic AI Practitioner exam and walk away with a LinkedIn-pluggable
        badge and a verifiable certificate.
      </p>
    ),
    ctas: [{ label: "Start the exam", to: "/certification" }],
    hideIfCertified: true,
  },
];

export function NotificationCenter() {
  const [dismissed, setDismissed] = useState<Set<string> | null>(null);
  const [hasCertificate, setHasCertificate] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) setDismissed(new Set());
        return;
      }
      const [dismissResult, certResult] = await Promise.all([
        supabase
          .from("user_announcements_dismissed")
          .select("announcement_key")
          .eq("user_id", user.id),
        supabase.from("certificates").select("id").eq("user_id", user.id).limit(1).maybeSingle(),
      ]);
      if (cancelled) return;
      const keys = new Set((dismissResult.data ?? []).map((row) => row.announcement_key as string));
      setDismissed(keys);
      setHasCertificate(Boolean(certResult.data));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const acknowledge = useCallback(async (key: string) => {
    // Optimistic update so the item disappears immediately.
    setDismissed((prev) => {
      const next = new Set(prev ?? []);
      next.add(key);
      return next;
    });
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase
      .from("user_announcements_dismissed")
      .insert({ user_id: user.id, announcement_key: key });
    if (error && error.code !== "23505") {
      // 23505 = unique violation, meaning it was already dismissed.
      // Anything else: roll back so the user can retry.
      setDismissed((prev) => {
        const next = new Set(prev ?? []);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const eligible =
    dismissed === null
      ? []
      : ANNOUNCEMENTS.filter((a) => {
          if (a.hideIfCertified && hasCertificate) return false;
          return true;
        });
  const visible = eligible.filter((a) => !dismissed?.has(a.key));
  const archived = eligible.filter((a) => dismissed?.has(a.key));
  const unreadCount = visible.length;
  const [showArchived, setShowArchived] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
          className={cn(
            "relative flex h-9 w-9 items-center justify-center rounded-full border bg-card/60 transition hover:bg-card",
            unreadCount > 0
              ? "border-primary/60 shadow-[0_0_0_2px_hsl(var(--background)),0_0_18px_hsl(var(--primary)/0.55)] animate-pulse"
              : "border-border/60 hover:border-primary/50",
          )}
        >
          <Bell
            className={cn("h-4 w-4", unreadCount > 0 ? "text-primary" : "text-muted-foreground")}
          />
          {unreadCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground ring-2 ring-background">
              {unreadCount}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0 sm:w-[400px]" sideOffset={8}>
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <h3 className="text-sm font-semibold">Notifications</h3>
          </div>
          {unreadCount > 0 ? (
            <span className="text-[11px] text-muted-foreground">{unreadCount} new</span>
          ) : null}
        </div>

        {dismissed === null ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">Loading…</div>
        ) : visible.length === 0 && archived.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
              <Check className="h-5 w-5" />
            </div>
            <p className="mt-3 text-sm font-medium">You're all caught up</p>
            <p className="mt-1 text-xs text-muted-foreground">
              We'll let you know when there's something new.
            </p>
          </div>
        ) : (
          <ScrollArea className="h-[70vh] max-h-[600px]">
            {visible.length > 0 ? (
              <ul className="divide-y divide-border/60">
                {visible.map((a) => (
                  <li key={a.key} className="p-4">
                    {renderAnnouncement(a, false, acknowledge, () => setOpen(false))}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-4 py-6 text-center">
                <div className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Check className="h-4 w-4" />
                </div>
                <p className="mt-2 text-xs font-medium">You're all caught up</p>
              </div>
            )}

            {archived.length > 0 ? (
              <div className="border-t border-border/60">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
                >
                  <span>Old notifications ({archived.length})</span>
                  <ArrowRight
                    className={cn("h-3 w-3 transition-transform", showArchived ? "rotate-90" : "")}
                  />
                </button>
                {showArchived ? (
                  <ul className="divide-y divide-border/60 opacity-70">
                    {archived.map((a) => (
                      <li key={a.key} className="p-4">
                        {renderAnnouncement(a, true, acknowledge, () => setOpen(false))}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}

function renderAnnouncement(
  a: Announcement,
  isArchived: boolean,
  acknowledge: (key: string) => void | Promise<void>,
  closePopover: () => void,
) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br text-white shadow-sm",
          a.iconClassName ?? "from-primary to-nexus-glow",
          isArchived ? "grayscale" : "",
        )}
      >
        {a.icon}
      </div>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-semibold leading-tight">{a.title}</h4>
        <div className="mt-1 text-xs leading-relaxed text-foreground/80">{a.body}</div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {a.ctas?.map((cta) => (
            <Button
              key={cta.to}
              asChild
              size="sm"
              variant="secondary"
              className="h-7 gap-1 px-2.5 text-xs"
              onClick={closePopover}
            >
              <Link to={cta.to} search={cta.search as never}>
                {cta.label}
                <ArrowRight className="h-3 w-3" />
              </Link>
            </Button>
          ))}
          {!isArchived ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void acknowledge(a.key)}
            >
              <Check className="h-3 w-3" />
              Got it
            </Button>
          ) : (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Read</span>
          )}
        </div>
      </div>
    </div>
  );
}
