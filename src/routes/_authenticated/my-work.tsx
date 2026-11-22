// My work: what you opened last, what you starred, and what other people
// shared with you — across every kind of thing, on one page.
//
// It reads two lists it does not own: the search index (every name you may
// see) and your marks (what you starred and opened). Nothing here is a third
// copy, so this page, search and the star on a row always agree.
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Clock, Loader2, RefreshCw, Star, Users } from "lucide-react";

import { PageEyebrow } from "@/components/PageEyebrow";
import { ObjectRow } from "@/components/search/parts";
import { Button } from "@/components/ui/button";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { clearOpened } from "@/hooks/use-object-marks";
import { useMyWork } from "@/hooks/use-my-work";
import { agoLabel } from "@/lib/agoLabel";
import { isObjectKindId, OBJECT_KINDS, objectKind, type ObjectKindId } from "@/lib/objectKinds";
import {
  favourites,
  favouritesInView,
  markKey,
  recents,
  sharedWithMe,
  type WorkEntry,
} from "@/lib/objectMarks";
import { countByKind } from "@/lib/objectSearch";
import { MY_WORK_TABS, myWorkTabFrom, type MyWorkTab } from "@/lib/myWorkTabs";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/my-work")({
  component: MyWorkPage,
  head: () => ({ meta: [{ title: "My work — AgentSwarms" }] }),
  validateSearch: (s: Record<string, unknown>) => {
    const out: { tab?: MyWorkTab; kind?: ObjectKindId } = {};
    if (typeof s.tab === "string") out.tab = myWorkTabFrom(s.tab);
    if (isObjectKindId(s.kind)) out.kind = s.kind;
    return out;
  },
});

const TAB_TEXT: Record<
  MyWorkTab,
  {
    label: string;
    /** For a narrow screen, where the three tabs must share one line. */
    short?: string;
    icon: typeof Clock;
    emptyTitle: string;
    emptyHelp: string;
  }
> = {
  recent: {
    label: "Recent",
    icon: Clock,
    emptyTitle: "Nothing yet.",
    emptyHelp:
      "What you open is listed here, newest first, along with your own work you have not opened yet.",
  },
  favourites: {
    label: "Favourites",
    icon: Star,
    emptyTitle: "No favourites yet.",
    emptyHelp:
      "Press the star beside anything, here or in search, to keep it one click away. Favourites also come first when you open search.",
  },
  shared: {
    label: "Shared with me",
    short: "Shared",
    icon: Users,
    emptyTitle: "Nothing has been shared with you.",
    emptyHelp:
      "When someone shares an agent, a dataset, a dashboard or anything else with you, it is listed here, whichever page it lives on.",
  },
};

function MyWorkPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/my-work" });
  // An address can carry anything; what is drawn is always one of the tabs.
  const tab = myWorkTabFrom(search.tab);
  const kind = search.kind;
  const { index, marks, work } = useMyWork(true);
  const [clearing, setClearing] = useState(false);

  // What the Favourites tab has listed since it was opened, as keys in order.
  // A row whose star is taken off stays where it is until the tab is left:
  // vanishing at once pulled the next row up under the pointer.
  const [favShown, setFavShown] = useState<string[]>([]);
  const favList = useMemo(() => favouritesInView(work, favShown), [work, favShown]);
  useEffect(() => {
    const keys = tab === "favourites" ? favList.map((e) => markKey(e.kind, e.id)) : [];
    if (keys.join("\n") !== favShown.join("\n")) setFavShown(keys);
  }, [tab, favList, favShown]);

  const lists = useMemo(
    () => ({
      recent: recents(work),
      favourites: tab === "favourites" ? favList : favourites(work),
      shared: sharedWithMe(work),
    }),
    [work, tab, favList],
  );
  // The number on the Favourites tab is how many are starred, not how many
  // rows are being held in place.
  const tabCount = (t: MyWorkTab) =>
    t === "favourites" ? lists.favourites.filter((e) => e.starred).length : lists[t].length;
  const all = lists[tab];
  const counts = useMemo(() => countByKind(all), [all]);
  const kinds = OBJECT_KINDS.filter((k) => (counts.get(k.id) ?? 0) > 0);
  // A kind chosen on one tab may have nothing on the next: show everything.
  const chosen = kind && (counts.get(kind) ?? 0) > 0 ? kind : undefined;
  const shown = chosen ? all.filter((e) => e.kind === chosen) : all;
  const openedAny = lists.recent.some((e) => e.touched === "opened");

  // It cannot be undone, so it asks, and says what stays.
  const forgetOpened = async () => {
    const yes = await confirmAsk({
      title: "Forget what you opened?",
      body: "The times you opened things are deleted and cannot be brought back. Your favourites stay, and your own work is listed by when it last changed again.",
      actionLabel: "Forget",
    });
    if (!yes) return;
    setClearing(true);
    await clearOpened();
    setClearing(false);
  };

  const go = (next: { tab?: MyWorkTab; kind?: ObjectKindId }) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });

  const stillReading = index.pending.map((k) => objectKind(k).plural.toLowerCase()).join(", ");
  const text = TAB_TEXT[tab];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-6">
      <div>
        <PageEyebrow />
        <h1 className="text-xl font-semibold">My work</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What you opened last, what you starred, and what other people shared with you.
        </p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-4 border-b">
        <div role="tablist" aria-label="My work" className="flex flex-wrap gap-1">
          {MY_WORK_TABS.map((t) => {
            const Icon = TAB_TEXT[t].icon;
            const active = t === tab;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => go({ tab: t, kind: undefined })}
                className={cn(
                  "-mb-px inline-flex items-center gap-2 border-b-2 px-2 py-2 text-sm outline-none transition focus-visible:bg-muted/60 sm:px-3",
                  active
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="hidden h-4 w-4 sm:block" />
                {TAB_TEXT[t].short ? (
                  <>
                    <span className="sm:hidden" aria-hidden>
                      {TAB_TEXT[t].short}
                    </span>
                    <span className="sr-only sm:not-sr-only">{TAB_TEXT[t].label}</span>
                  </>
                ) : (
                  TAB_TEXT[t].label
                )}
                {!index.loading && (
                  <span className="tabular-nums text-xs text-muted-foreground">{tabCount(t)}</span>
                )}
              </button>
            );
          })}
        </div>
        {/* Beside the tabs, not under the list: what is kept about you is
            cleared from where it can be seen. */}
        {tab === "recent" && openedAny && (
          <button
            type="button"
            disabled={clearing}
            onClick={() => void forgetOpened()}
            title="Forgets what you opened. Favourites are kept."
            className="mb-1.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground outline-none transition hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            {clearing ? "Clearing…" : "Clear what I opened"}
          </button>
        )}
      </div>

      {kinds.length > 1 && (
        <div
          // One row that scrolls sideways on a phone, where fifteen kinds
          // stacked five lines deep above the list they filter.
          className="-mx-6 flex items-center gap-1.5 overflow-x-auto px-6 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label="Filter by kind"
        >
          <Chip
            active={!chosen}
            onClick={() => go({ kind: undefined })}
            label="All"
            count={all.length}
          />
          {kinds.map((k) => (
            <Chip
              key={k.id}
              active={chosen === k.id}
              onClick={() => go({ kind: chosen === k.id ? undefined : k.id })}
              label={k.plural}
              count={counts.get(k.id) ?? 0}
            />
          ))}
        </div>
      )}

      {index.error ? (
        <Notice>
          <p className="font-medium">Your work could not be read.</p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{index.error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={index.refresh}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
          </Button>
        </Notice>
      ) : index.loading || (!marks.loaded && tab !== "shared") ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading your work…
        </div>
      ) : tab === "favourites" && marks.unavailable ? (
        <Notice>
          <p className="font-medium">Favourites need a database update.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This install runs a newer app than its database. Whoever looks after it applies the
            latest migrations, and the stars appear on the next reload. Recent still lists your own
            work by when it last changed.
          </p>
        </Notice>
      ) : shown.length === 0 ? (
        <Notice>
          <p className="font-medium">{text.emptyTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{text.emptyHelp}</p>
        </Notice>
      ) : (
        <WorkList entries={shown} tab={tab} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5" role="status">
          {stillReading && !index.loading && !index.error ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> Still reading {stillReading}…
            </>
          ) : marks.error ? (
            `Your favourites could not be read: ${marks.error}`
          ) : index.failed.length > 0 && !index.error ? (
            <>
              Not read just now:{" "}
              {index.failed.map((k) => objectKind(k).plural.toLowerCase()).join(", ")}.{" "}
              <button
                type="button"
                onClick={index.refresh}
                className="text-primary hover:underline"
              >
                Try again
              </button>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function Chip(props: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition",
        props.active
          ? "border-primary/40 bg-primary/10 font-medium text-foreground"
          : "border-border/70 text-muted-foreground hover:border-primary/30 hover:text-foreground",
      )}
    >
      {props.label}
      <span className="tabular-nums opacity-70">{props.count}</span>
    </button>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border bg-card px-5 py-8 text-sm">{children}</div>;
}

/** When, in this tab's own terms: opened, changed, or starred. */
function whenLabel(e: WorkEntry, tab: MyWorkTab): string {
  if (tab === "recent") {
    const ago = agoLabel(e.touchedAt);
    return ago ? `${e.touched === "opened" ? "Opened" : "Changed"} ${ago}` : "";
  }
  const ago = agoLabel(e.updatedAt);
  return ago ? `Changed ${ago}` : "";
}

function WorkList({ entries, tab }: { entries: WorkEntry[]; tab: MyWorkTab }) {
  return (
    <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border bg-card">
      {entries.map((e) => (
        <ObjectRow key={`${e.kind}:${e.id}`} entry={e} when={whenLabel(e, tab)} />
      ))}
    </ul>
  );
}
