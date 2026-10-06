// The Settings page: a tab-to-tab interface (URL-persisted via ?tab=, so a
// link/bookmark/refresh lands on the same tab) over four panels that each
// own their own state and backend calls — this route is just the shell.
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, LayoutGrid, Palette, Settings as SettingsIcon, UserCircle2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { LayoutSettingsPanel } from "@/components/settings/LayoutSettingsPanel";
import { AccountSettingsPanel } from "@/components/settings/AccountSettingsPanel";
import { ApiKeysSettingsPanel } from "@/components/settings/ApiKeysSettingsPanel";
import { AppearanceSettingsPanel } from "@/components/settings/AppearanceSettingsPanel";

const TABS = [
  {
    id: "account",
    label: "Account",
    icon: UserCircle2,
    description: "Your profile, sign-in method, and usage.",
    Panel: AccountSettingsPanel,
  },
  {
    id: "layout",
    label: "Layout",
    icon: LayoutGrid,
    description: "Density, default views, and sidebar behavior.",
    Panel: LayoutSettingsPanel,
  },
  {
    id: "api-keys",
    label: "API Keys",
    icon: KeyRound,
    description: "Generate, copy, and revoke keys for programmatic access.",
    Panel: ApiKeysSettingsPanel,
  },
  {
    id: "theme",
    label: "Theme",
    icon: Palette,
    description: "Light, dark, system, and your accent color.",
    Panel: AppearanceSettingsPanel,
  },
] as const;

type TabId = (typeof TABS)[number]["id"];
const TAB_IDS: TabId[] = TABS.map((t) => t.id);
const DEFAULT_TAB: TabId = "account";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [{ title: "Settings — AgentSwarms" }],
  }),
  validateSearch: (s: Record<string, unknown>) => {
    const out: { tab?: TabId } = {};
    if (typeof s.tab === "string" && (TAB_IDS as string[]).includes(s.tab)) {
      out.tab = s.tab as TabId;
    }
    return out;
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const activeId = tab ?? DEFAULT_TAB;
  const active = TABS.find((t) => t.id === activeId) ?? TABS[0];

  const goToTab = (id: TabId) => {
    void navigate({ search: { tab: id }, replace: true });
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6">
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Workspace
        </p>
        <h1 className="flex items-center gap-2 font-display text-3xl font-semibold tracking-tight">
          <SettingsIcon className="h-7 w-7 text-primary" /> Settings
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your profile, workspace layout, API keys, and appearance.
        </p>
      </div>

      {/* Mobile: a dropdown, not a horizontal scroll strip — the brief asks
          for "collapsible/dropdown tabs," and with 4 tabs a select reads
          better than a row that scrolls off-screen on a phone width. */}
      <div className="mb-4 sm:hidden">
        <Select value={activeId} onValueChange={(v) => goToTab(v as TabId)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TABS.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                <span className="flex items-center gap-2">
                  <t.icon className="h-4 w-4" /> {t.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-6 sm:flex-row">
        {/* Desktop: vertical sidebar tabs. */}
        <nav className="hidden shrink-0 sm:block sm:w-52" aria-label="Settings sections">
          <ul className="space-y-1">
            {TABS.map((t) => {
              const isActive = t.id === activeId;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => goToTab(t.id)}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors",
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <t.icon className="h-4 w-4 shrink-0" />
                    {t.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 rounded-xl border border-border bg-card p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-foreground">{active.label}</h2>
            <p className="text-xs text-muted-foreground">{active.description}</p>
          </div>
          <active.Panel />
        </div>
      </div>
    </div>
  );
}
