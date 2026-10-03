import { Check, LayoutGrid, PanelLeft, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SWARM_VIEWS,
  DENSITIES,
  useLayoutPrefs,
  type DefaultSwarmView,
  type Density,
} from "@/hooks/use-layout-prefs";

function OptionCard<T extends string>({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "relative flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border hover:border-primary/40 hover:bg-muted/40",
      )}
    >
      {active && <Check className="absolute right-3 top-3 h-4 w-4 text-primary" />}
      <p className="text-sm font-medium text-foreground">{label}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </button>
  );
}

/**
 * Workspace-shape preferences: density, the /swarms landing view, and
 * quick actions for sidebar behavior (the sidebar itself already persists
 * collapsed state and drag-resized width the moment you interact with it —
 * see src/components/ui/sidebar.tsx — so this doesn't duplicate that with a
 * second set of controls, only a way to reset it).
 */
export function LayoutSettingsPanel() {
  const { density, setDensity, defaultSwarmView, setDefaultSwarmView } = useLayoutPrefs();

  const resetSidebar = () => {
    try {
      window.localStorage.removeItem("sidebar:state");
      window.localStorage.removeItem("sidebar:width");
    } catch {
      // Storage disabled — nothing to reset either way.
    }
    toast.success("Sidebar reset to its default width and expanded state — reload to see it.");
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Density</h3>
          <p className="text-xs text-muted-foreground">
            How much spacing the whole app uses — tables, lists, cards, everything. Applies
            immediately, everywhere.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {DENSITIES.map((d) => (
            <OptionCard<Density>
              key={d.id}
              active={density === d.id}
              label={d.label}
              hint={d.hint}
              onClick={() => setDensity(d.id)}
            />
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <LayoutGrid className="h-4 w-4 text-primary" /> Default Swarms view
          </h3>
          <p className="text-xs text-muted-foreground">
            What opening the Swarms page shows you first.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {DEFAULT_SWARM_VIEWS.map((v) => (
            <OptionCard<DefaultSwarmView>
              key={v.id}
              active={defaultSwarmView === v.id}
              label={v.label}
              hint={v.hint}
              onClick={() => setDefaultSwarmView(v.id)}
            />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <PanelLeft className="h-4 w-4 text-primary" /> Sidebar
        </h3>
        <p className="text-xs text-muted-foreground">
          Drag its right edge to resize, drag past ~100px (or click the collapse button) to hide it
          entirely — both are remembered automatically. If it's ever stuck too narrow or too wide:
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={resetSidebar}
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset sidebar to default
        </Button>
      </div>
    </div>
  );
}
