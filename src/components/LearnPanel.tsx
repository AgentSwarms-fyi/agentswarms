import { Link } from "@tanstack/react-router";
import { BookOpen, Compass, GraduationCap, Building2, Lightbulb, ArrowRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type LearnSection = {
  /** Why this page/concept exists */
  why: string;
  /** What the user will encounter here */
  whatToExpect: string[];
  /** What they'll learn by using it */
  whatYouLearn: string[];
  /** How they will learn (suggested workflow) */
  howYouLearn: string[];
  /** Real-world / personal use cases */
  realLife: string[];
  /** Enterprise / production use cases */
  enterprise: string[];
  /** Optional deep-dive link target on /learn */
  learnMoreHash?: string;
};

type Props = {
  topic: string;
  tagline?: string;
  section: LearnSection;
  className?: string;
  onHide?: () => void;
};

/**
 * Persistent right-rail educational panel.
 * Drop into any in-app page to give context to newcomers
 * AND keep advanced users oriented (real-life + enterprise framing).
 */
export function LearnPanel({ topic, tagline, section, className, onHide }: Props) {
  return (
    <aside
      className={cn(
        "hidden xl:flex w-80 shrink-0 flex-col gap-4 border-l border-border/50 bg-card/30 p-5 overflow-y-auto",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            <GraduationCap className="h-3 w-3" /> Learn as you build
          </div>
          <h3 className="text-base font-bold tracking-tight">{topic}</h3>
          {tagline && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tagline}</p>
          )}
        </div>
        {onHide && (
          <button
            type="button"
            onClick={onHide}
            className="shrink-0 -mt-1 -mr-1 grid h-7 w-7 place-items-center rounded-md border border-border/50 text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
            title="Hide lesson panel"
            aria-label="Hide lesson panel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <Block icon={Lightbulb} title="Why we're here" tone="primary">
        <p>{section.why}</p>
      </Block>

      <Block icon={Compass} title="What to expect">
        <BulletList items={section.whatToExpect} />
      </Block>

      <Block icon={BookOpen} title="What you'll learn">
        <BulletList items={section.whatYouLearn} />
      </Block>

      <Block icon={GraduationCap} title="How you'll learn">
        <OrderedList items={section.howYouLearn} />
      </Block>

      <Block icon={Lightbulb} title="In real life" tone="muted">
        <BulletList items={section.realLife} />
      </Block>

      <Block icon={Building2} title="In the enterprise" tone="muted">
        <BulletList items={section.enterprise} />
      </Block>

      <Link
        to="/learn"
        hash={section.learnMoreHash}
        className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-primary/50 hover:text-primary"
      >
        Open full lesson <ArrowRight className="h-3 w-3" />
      </Link>
    </aside>
  );
}

function Block({
  icon: Icon,
  title,
  tone = "default",
  children,
}: {
  icon: typeof Lightbulb;
  title: string;
  tone?: "default" | "primary" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-xs leading-relaxed",
        tone === "primary" && "border-primary/30 bg-primary/5",
        tone === "muted" && "border-border/40 bg-background/40",
        tone === "default" && "border-border/50 bg-background/60",
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3 text-primary" />
        {title}
      </div>
      <div className="text-muted-foreground [&_strong]:text-foreground">{children}</div>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1">
      {items.map((it) => (
        <li key={it} className="flex items-start gap-1.5">
          <span className="mt-1.5 inline-block h-1 w-1 flex-shrink-0 rounded-full bg-primary" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

function OrderedList({ items }: { items: string[] }) {
  return (
    <ol className="space-y-1">
      {items.map((it, i) => (
        <li key={it} className="flex items-start gap-2">
          <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
            {i + 1}
          </span>
          <span>{it}</span>
        </li>
      ))}
    </ol>
  );
}
