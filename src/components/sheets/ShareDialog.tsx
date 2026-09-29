// Share a workbook: with people (by the email they sign in with) or IAM
// groups, to view or to edit. A viewer's share can leave sheets out and keep
// only some rows of a sheet; the server sends them nothing else. "View as"
// opens the workbook exactly as a share sees it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useTokenRef } from "@/hooks/use-token-ref";
import { Eye, Loader2, Pencil, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmAsk } from "@/components/ui/confirm-dialog";
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
import { cn } from "@/lib/utils";
import { colLetters } from "@/lib/sheets/a1";
import { describeRowFilter, ROLE_LABEL, type RowFilter } from "@/lib/sheets/share";
import type { TableConfig } from "@/lib/sheets/sql/tableQuery";
import { sheetsTableValues } from "@/utils/sheetsTables.functions";
import {
  sheetsShareGroups,
  sheetsShareRemove,
  sheetsShareSet,
  sheetsSharesList,
  type ShareRow,
} from "@/utils/sheetsShares.functions";
import type { useWorkbook } from "./useWorkbook";

type Workbook = ReturnType<typeof useWorkbook>;

type Draft = {
  editing: string | null;
  who: "person" | "group";
  email: string;
  groupId: string;
  role: "viewer" | "editor";
  /** Lower-case names of the sheets left out. */
  hidden: Set<string>;
  /** Lower-case sheet name → its filter. */
  filters: Record<string, RowFilter>;
};

const empty = (): Draft => ({
  editing: null,
  who: "person",
  email: "",
  groupId: "",
  role: "viewer",
  hidden: new Set(),
  filters: {},
});

export function ShareDialog({
  open,
  onOpenChange,
  token,
  workbookId,
  wb,
  onViewAs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  workbookId: string;
  wb: Workbook;
  onViewAs: (shareId: string) => void;
}) {
  const listFn = useServerFn(sheetsSharesList);
  const groupsFn = useServerFn(sheetsShareGroups);
  const setFn = useServerFn(sheetsShareSet);
  const removeFn = useServerFn(sheetsShareRemove);
  const [shares, setShares] = useState<ShareRow[] | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // The token through a ref: it changes on every session refresh (R125).
  const { tokenRef, signedIn } = useTokenRef(token);

  const load = useCallback(async () => {
    if (!signedIn) return;
    setLoadError(null);
    try {
      const [l, g] = await Promise.all([
        listFn({ data: { access_token: tokenRef.current, workbook_id: workbookId } }),
        groupsFn({ data: { access_token: tokenRef.current } }),
      ]);
      if (!l.ok) return setLoadError(l.error);
      setShares(l.shares);
      if (g.ok) setGroups(g.groups);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [listFn, groupsFn, tokenRef, signedIn, workbookId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const save = async () => {
    if (!draft) return;
    setProblem(null);
    setWarnings([]);
    const target =
      draft.who === "person" ? { email: draft.email.trim() } : { group_id: draft.groupId };
    if (draft.who === "person" && !draft.email.trim()) return setProblem("Enter their email");
    if (draft.who === "group" && !draft.groupId) return setProblem("Pick a group");
    if (draft.role === "viewer") {
      const empty = Object.entries(draft.filters).find(
        ([name, f]) => !draft.hidden.has(name) && !f.values.length,
      );
      if (empty) {
        return setProblem(
          `Pick at least one value to keep on ${sheetLabel(wb, empty[0])}, or show all its rows`,
        );
      }
    }
    setBusy(true);
    try {
      const viewer = draft.role === "viewer";
      const r = await setFn({
        data: {
          access_token: token,
          workbook_id: workbookId,
          target,
          role: draft.role,
          ...(viewer
            ? {
                row_filters: Object.fromEntries(
                  Object.entries(draft.filters).filter(([name]) => !draft.hidden.has(name)),
                ),
                hidden_sheets: [...draft.hidden],
              }
            : {}),
        },
      });
      if (!r.ok) return setProblem(r.error);
      setWarnings(r.warnings);
      toast.success(draft.editing ? "Share updated" : "Shared");
      setDraft(null);
      await load();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: ShareRow) => {
    if (
      !(await confirmAsk({
        title: `Stop sharing with ${s.label}?`,
        body: "They lose access at once, including anything they have open.",
        actionLabel: "Stop sharing",
      }))
    )
      return;
    try {
      const r = await removeFn({
        data: { access_token: token, workbook_id: workbookId, share_id: s.id },
      });
      if (!r.ok) return toast.error(r.error);
      toast.success(`No longer shared with ${s.label}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const kindOf = (lower: string) =>
    wb.tabs.find((t) => t.name.toLowerCase() === lower)?.kind ?? "table";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>Share this workbook</DialogTitle>
          <DialogDescription>
            People and groups you share with open it from their Sheets page. Someone who can view
            gets only the sheets and rows you choose; the rest never reaches their browser. Table
            sheets read the lakehouse as whoever opens them, with their own access.
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            Could not read who it is shared with: {loadError}
            <Button size="sm" variant="outline" className="ml-3" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : shares === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading who it is shared with…
          </div>
        ) : draft ? (
          <ShareForm
            draft={draft}
            setDraft={(d) => {
              // A change answers the last refusal; it no longer applies.
              setProblem(null);
              setDraft(d);
            }}
            groups={groups}
            wb={wb}
            token={token}
            problem={problem}
          />
        ) : (
          <div className="space-y-2" data-testid="share-list">
            {shares.length === 0 && (
              <p className="text-sm text-muted-foreground">Only you can open this workbook.</p>
            )}
            {shares.map((s) => {
              const filters = Object.entries(s.row_filters);
              return (
                <div
                  key={s.id}
                  className="flex items-start gap-3 rounded-md border border-border p-3"
                  data-testid="share-row"
                >
                  {s.principal_type === "group" ? (
                    <Users className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  ) : (
                    <UserPlus className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{s.label}</span>
                      {s.detail && <span className="text-muted-foreground">{s.detail}</span>}
                      <Badge variant={s.role === "editor" ? "default" : "secondary"}>
                        {ROLE_LABEL[s.role]}
                      </Badge>
                    </div>
                    {s.role === "viewer" && (filters.length > 0 || s.hidden_sheets.length > 0) && (
                      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        {filters.map(([sheet, f]) => (
                          <li key={sheet}>
                            {sheetLabel(wb, sheet)}: only rows where{" "}
                            {describeRowFilter(f, kindOf(sheet))}
                          </li>
                        ))}
                        {s.hidden_sheets.length > 0 && (
                          <li>
                            Leaves out {s.hidden_sheets.map((h) => sheetLabel(wb, h)).join(", ")}
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2"
                      title="Open the workbook as this share sees it"
                      onClick={() => onViewAs(s.id)}
                    >
                      <Eye className="h-3.5 w-3.5" /> View as
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Change the share with ${s.label}`}
                      onClick={() => {
                        setProblem(null);
                        setWarnings([]);
                        setDraft({
                          editing: s.id,
                          who: s.principal_type === "group" ? "group" : "person",
                          email: s.principal_type === "user" ? s.label : "",
                          groupId: s.principal_type === "group" ? s.principal_id : "",
                          role: s.role,
                          hidden: new Set(s.hidden_sheets),
                          filters: { ...s.row_filters },
                        });
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      aria-label={`Stop sharing with ${s.label}`}
                      onClick={() => void remove(s)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
            {warnings.length > 0 && (
              <div
                className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"
                data-testid="share-warnings"
              >
                {warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {draft ? (
            <>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                Back
              </Button>
              <Button onClick={() => void save()} disabled={busy} data-testid="share-save">
                {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {draft.editing ? "Save" : "Share"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setProblem(null);
                  setWarnings([]);
                  setDraft(empty());
                }}
                disabled={shares === null}
                data-testid="share-add"
              >
                <UserPlus className="mr-1 h-4 w-4" /> Share with…
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A sheet's name as the workbook spells it, from the lower-case one a share keeps. */
function sheetLabel(wb: Workbook, lower: string): string {
  return wb.tabs.find((t) => t.name.toLowerCase() === lower)?.name ?? lower;
}

function ShareForm({
  draft,
  setDraft,
  groups,
  wb,
  token,
  problem,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  groups: { id: string; name: string }[];
  wb: Workbook;
  token: string;
  problem: string | null;
}) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  return (
    <div className="space-y-4" data-testid="share-form">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-1">
          <div className="flex gap-3 text-sm" role="radiogroup" aria-label="Share with">
            {(["person", "group"] as const).map((w) => (
              <label key={w} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="share-who"
                  checked={draft.who === w}
                  disabled={!!draft.editing}
                  onChange={() => set({ who: w })}
                />
                {w === "person" ? "A person" : "A group"}
              </label>
            ))}
          </div>
          {draft.who === "person" ? (
            <Input
              aria-label="Their email"
              placeholder="the email they sign in with"
              value={draft.email}
              disabled={!!draft.editing}
              onChange={(e) => set({ email: e.target.value })}
            />
          ) : (
            <select
              aria-label="Group"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={draft.groupId}
              disabled={!!draft.editing}
              onChange={(e) => set({ groupId: e.target.value })}
            >
              <option value="">{groups.length ? "Pick a group…" : "No IAM groups yet"}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="grid gap-1">
          <Label htmlFor="share-role">They can</Label>
          <select
            id="share-role"
            aria-label="Role"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={draft.role}
            onChange={(e) => set({ role: e.target.value as Draft["role"] })}
          >
            <option value="viewer">View</option>
            <option value="editor">Edit</option>
          </select>
        </div>
      </div>

      {draft.role === "editor" ? (
        <p className="text-sm text-muted-foreground">
          Editors see every sheet and row and change cells, sheets and table settings. Deleting the
          workbook, importing data into it and sharing it stay yours.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium">What they see</p>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {wb.tabs.map((t) => (
              <SheetChoice
                key={t.id}
                tab={t}
                wb={wb}
                token={token}
                shown={!draft.hidden.has(t.name.toLowerCase())}
                filter={draft.filters[t.name.toLowerCase()] ?? null}
                onShown={(on) => {
                  const hidden = new Set(draft.hidden);
                  if (on) hidden.delete(t.name.toLowerCase());
                  else hidden.add(t.name.toLowerCase());
                  set({ hidden });
                }}
                onFilter={(f) => {
                  const filters = { ...draft.filters };
                  if (f) filters[t.name.toLowerCase()] = f;
                  else delete filters[t.name.toLowerCase()];
                  set({ filters });
                }}
              />
            ))}
          </div>
        </div>
      )}
      {problem && (
        <p className="text-sm text-destructive" role="alert" data-testid="share-problem">
          {problem}
        </p>
      )}
    </div>
  );
}

/** A grid column's distinct entries below the header rows, as the server compares them. */
function gridValues(wb: Workbook, tabId: string, col: number, header: number): string[] {
  const grid = wb.engine?.gridOf(tabId);
  if (!grid) return [];
  const seen = new Map<string, string>();
  for (const [k, cell] of Object.entries(grid.cells)) {
    const [r, c] = k.split(",").map(Number);
    if (c !== col || r < header) continue;
    const text = (cell.i ?? "").replace(/^'/, "").trim();
    if (text.startsWith("=")) continue;
    const key = text.toLowerCase();
    if (!seen.has(key)) seen.set(key, text);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function SheetChoice({
  tab,
  wb,
  token,
  shown,
  filter,
  onShown,
  onFilter,
}: {
  tab: Workbook["tabs"][number];
  wb: Workbook;
  token: string;
  shown: boolean;
  filter: RowFilter | null;
  onShown: (on: boolean) => void;
  onFilter: (f: RowFilter | null) => void;
}) {
  const valuesFn = useServerFn(sheetsTableValues);
  const config: TableConfig | undefined = wb.tableConfigs[tab.id];
  const [values, setValues] = useState<string[] | null>(null);
  const [valuesError, setValuesError] = useState<string | null>(null);

  // Columns to filter on: a table sheet's columns, or a grid sheet's letters
  // with the header row's text beside them.
  const columns = useMemo(() => {
    if (tab.kind === "table") {
      return (config?.columns ?? []).map((c) => ({ id: c.name, label: c.name }));
    }
    const grid = wb.engine?.gridOf(tab.id);
    let maxCol = 0;
    for (const k of Object.keys(grid?.cells ?? {}))
      maxCol = Math.max(maxCol, Number(k.split(",")[1]));
    const header = Math.max(0, (filter?.header ?? 1) - 1);
    return Array.from({ length: Math.min(maxCol + 1, 52) }, (_, c) => {
      const title = (grid?.cells[`${header},${c}`]?.i ?? "").replace(/^'/, "").trim();
      return { id: colLetters(c), label: title ? `${colLetters(c)} — ${title}` : colLetters(c) };
    });
  }, [tab, config, wb.engine, filter?.header]);

  // The chosen column's values: a table sheet's from the lakehouse (as you,
  // its owner, read it), a grid sheet's from its cells.
  useEffect(() => {
    if (!filter) return setValues(null);
    setValuesError(null);
    if (tab.kind === "grid") {
      const col = columns.findIndex((c) => c.id === filter.column.toUpperCase());
      setValues(col < 0 ? [] : gridValues(wb, tab.id, col, filter.header ?? 1));
      return;
    }
    if (!config) return;
    let cancelled = false;
    setValues(null);
    valuesFn({
      data: {
        access_token: token,
        tab_id: tab.id,
        config: { ...config, filters: [] },
        column: filter.column,
        params: wb.queryParams,
      },
    })
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) return setValuesError(r.error);
        setValues(r.values.map((v) => v.v ?? ""));
      })
      .catch((e) => !cancelled && setValuesError((e as Error).message));
    return () => {
      cancelled = true;
    };
    // The column and header decide the list, not the values picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter?.column, filter?.header, tab.id, tab.kind]);

  const kept = new Set((filter?.values ?? []).map((v) => v.toLowerCase()));
  return (
    <div
      className={cn("rounded-md border border-border p-2 text-sm", !shown && "opacity-60")}
      data-testid="share-sheet"
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 font-medium">
          <Checkbox
            checked={shown}
            onCheckedChange={(v) => onShown(v === true)}
            aria-label={`Show ${tab.name}`}
          />
          {tab.name}
          <span className="text-xs font-normal text-muted-foreground">
            {tab.kind === "table" ? "table sheet" : "grid sheet"}
          </span>
        </label>
        {shown && (
          <select
            aria-label={`Rows of ${tab.name}`}
            className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
            value={filter ? "some" : "all"}
            onChange={(e) =>
              onFilter(
                e.target.value === "all"
                  ? null
                  : {
                      column: columns[0]?.id ?? "A",
                      values: [],
                      ...(tab.kind === "grid" ? { header: 1 } : {}),
                    },
              )
            }
          >
            <option value="all">All rows</option>
            <option value="some">Only rows where…</option>
          </select>
        )}
      </div>
      {shown && filter && (
        <div className="mt-2 grid gap-2 pl-6">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              aria-label={`Filter column of ${tab.name}`}
              className="h-7 rounded-md border border-input bg-background px-1.5"
              value={tab.kind === "grid" ? filter.column.toUpperCase() : filter.column}
              onChange={(e) => onFilter({ ...filter, column: e.target.value, values: [] })}
            >
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground">is one of</span>
            {tab.kind === "grid" && (
              <label className="ml-auto flex items-center gap-1 text-muted-foreground">
                Header rows kept
                <Input
                  aria-label={`Header rows of ${tab.name}`}
                  type="number"
                  min={0}
                  max={100}
                  className="h-7 w-16 text-xs"
                  value={filter.header ?? 1}
                  onChange={(e) =>
                    onFilter({
                      ...filter,
                      header: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                      values: [],
                    })
                  }
                />
              </label>
            )}
          </div>
          {valuesError ? (
            <p className="text-xs text-destructive">{valuesError}</p>
          ) : values === null ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Reading its values…
            </p>
          ) : values.length === 0 ? (
            <p className="text-xs text-muted-foreground">That column has no values to pick.</p>
          ) : (
            <div
              className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto text-xs"
              data-testid="share-values"
            >
              {values.map((v) => (
                <label key={v} className="flex items-center gap-1.5">
                  <Checkbox
                    checked={kept.has(v.toLowerCase())}
                    aria-label={`Keep ${v || "(blank)"}`}
                    onCheckedChange={(on) => {
                      const next = (filter.values ?? []).filter(
                        (x) => x.toLowerCase() !== v.toLowerCase(),
                      );
                      if (on === true) next.push(v);
                      onFilter({ ...filter, values: next });
                    }}
                  />
                  {v || "(blank)"}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
