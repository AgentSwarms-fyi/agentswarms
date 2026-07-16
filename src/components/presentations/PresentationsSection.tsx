// Presentations gallery for the /learn page. Lists available decks as cards;
// opening one launches the full-screen PresentationViewer overlay.
import { useState } from "react";
import { Play, Presentation as PresentationIcon, Layers } from "lucide-react";
import { PRESENTATIONS, type Presentation } from "@/lib/presentations";
import { PresentationViewer } from "./PresentationViewer";

export function PresentationsSection() {
  const [active, setActive] = useState<Presentation | null>(null);

  return (
    <section id="presentations" className="scroll-mt-24">
      <div className="mb-2 inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
        <PresentationIcon className="h-3 w-3" /> Presentations
      </div>
      <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Visual presentations</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">
        Bite-size, slide-based explainers built right into the app. Open one for a focused,
        full-screen walk-through — use the arrow keys or the on-screen controls to navigate.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PRESENTATIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setActive(p)}
            className="group flex flex-col rounded-xl border border-border/50 bg-card/40 p-5 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
          >
            <div className="flex items-center justify-between">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                <Layers className="h-5 w-5" />
              </div>
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                {p.slides.length} slides
              </span>
            </div>
            <h3 className="mt-4 text-base font-semibold text-foreground">{p.title}</h3>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">
              {p.description}
            </p>
            <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
              <Play className="h-3.5 w-3.5" /> Present
            </span>
          </button>
        ))}
      </div>

      {active && <PresentationViewer presentation={active} onClose={() => setActive(null)} />}
    </section>
  );
}
