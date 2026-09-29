// Find and Replace (Ctrl+F, Ctrl+H), as Excel's: a panel over the grid that
// leaves the grid usable. Find Next walks the matches from the active cell,
// Find All lists them, Replace changes the match that is selected and moves
// on, and Replace All changes every one as a single undoable step.

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { clickable } from "@/lib/clickable";
import { a1 } from "@/lib/sheets/a1";
import {
  nextHit,
  type FindHit,
  type FindMemory,
  type FindOptions,
  type FindWithin,
} from "@/lib/sheets/find";

const select = "h-7 rounded-md border border-input bg-background px-1.5 text-xs";
/** Find All lists this many; the count says how many there are. */
const LIST_MAX = 200;

export function FindPanel({
  mode,
  onModeChange,
  onClose,
  readOnly,
  search,
  activeCell,
  sheetOrder,
  onGo,
  onReplaceOne,
  onReplaceAll,
  initial,
  onRemember,
}: {
  mode: "find" | "replace";
  onModeChange: (m: "find" | "replace") => void;
  onClose: () => void;
  /** A viewer finds, and does not replace. */
  readOnly: boolean;
  search: (opts: FindOptions, within: FindWithin) => { hits: FindHit[]; more: boolean };
  activeCell: () => { sheetId: string; row: number; col: number };
  sheetOrder: string[];
  onGo: (hit: FindHit) => void;
  /** Replace in the one cell: done, nothing to replace, or a formula it would break. */
  onReplaceOne: (
    hit: FindHit,
    opts: FindOptions,
    replacement: string,
  ) => "done" | "none" | "broken";
  onReplaceAll: (
    hits: FindHit[],
    opts: FindOptions,
    replacement: string,
  ) => { replaced: number; broken: number };
  /** The last search, and where to keep this one when the panel closes. */
  initial: FindMemory;
  onRemember: (m: FindMemory) => void;
}) {
  const [text, setText] = useState(initial.text);
  const [replacement, setReplacement] = useState(initial.replacement);
  const [matchCase, setMatchCase] = useState(initial.matchCase);
  const [entireCell, setEntireCell] = useState(initial.entireCell);
  const [lookIn, setLookIn] = useState<"values" | "formulas" | "notes">(initial.lookIn);
  const [within, setWithin] = useState<FindWithin>(initial.within);
  useEffect(() => {
    onRemember({ text, replacement, matchCase, entireCell, lookIn, within });
  }, [text, replacement, matchCase, entireCell, lookIn, within, onRemember]);
  const [status, setStatus] = useState<{ text: string; tone?: "warn" } | null>(null);
  const [listed, setListed] = useState<{ hits: FindHit[]; more: boolean } | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);

  const replacing = mode === "replace" && !readOnly;
  // Replace changes what was typed, so it looks there, as Excel's does.
  const opts = (): FindOptions => ({
    text,
    matchCase,
    entireCell,
    lookIn: replacing ? "formulas" : lookIn,
  });

  useEffect(() => {
    findRef.current?.focus();
    findRef.current?.select();
  }, [mode]);

  const notFound = () =>
    setStatus({
      text: `Nothing matches "${text}" in ${within === "sheet" ? "this sheet" : "the workbook"}`,
      tone: "warn",
    });

  const findNext = (backwards = false): FindHit | null => {
    if (!text) return null;
    const { hits, more } = search(opts(), within);
    if (!hits.length) {
      notFound();
      return null;
    }
    const i = nextHit(hits, activeCell(), sheetOrder, backwards);
    onGo(hits[i]);
    setStatus({ text: `${i + 1} of ${hits.length.toLocaleString()}${more ? "+" : ""}` });
    return hits[i];
  };

  const findAll = () => {
    if (!text) return;
    const r = search(opts(), within);
    setListed(r);
    if (!r.hits.length) notFound();
    else
      setStatus({
        text: `${r.hits.length.toLocaleString()}${r.more ? "+" : ""} cell${r.hits.length === 1 ? "" : "s"} found`,
      });
  };

  const replaceOne = () => {
    if (!text) return;
    const { hits } = search(opts(), within);
    const at = activeCell();
    const here = hits.find((h) => h.sheetId === at.sheetId && h.row === at.row && h.col === at.col);
    // As Excel's: the first Replace selects a match; the next one replaces it.
    if (!here) {
      findNext();
      return;
    }
    const r = onReplaceOne(here, opts(), replacement);
    if (r === "broken") {
      setStatus({
        text: `${a1(here.row, here.col)} was left: the change would break its formula`,
        tone: "warn",
      });
      return;
    }
    const next = findNext();
    if (!next) setStatus({ text: "Replaced; no more matches" });
  };

  const replaceAll = () => {
    if (!text) return;
    const { hits } = search(opts(), within);
    if (!hits.length) {
      notFound();
      return;
    }
    const r = onReplaceAll(hits, opts(), replacement);
    setListed(null);
    setStatus({
      text:
        `Made ${r.replaced.toLocaleString()} replacement${r.replaced === 1 ? "" : "s"}` +
        (r.broken ? `; ${r.broken} left, as the change would break their formula` : "") +
        (r.replaced ? ". Undo (Ctrl+Z) takes them all back." : ""),
      tone: r.broken ? "warn" : undefined,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Find and replace"
      data-testid="find-panel"
      className="absolute right-3 top-2 z-40 flex max-h-[calc(100%-1rem)] w-[26rem] max-w-[calc(100%-1.5rem)] flex-col rounded-lg border border-border bg-popover p-3 text-sm shadow-lg"
      onKeyDown={onKeyDown}
    >
      <div className="mb-2 flex shrink-0 items-center gap-1">
        {(["find", "replace"] as const).map((m) =>
          m === "replace" && readOnly ? null : (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              className={cn(
                "rounded px-2 py-0.5 text-xs font-medium",
                mode === m
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
              onClick={() => onModeChange(m)}
            >
              {m === "find" ? "Find" : "Replace"}
            </button>
          ),
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          * any text · ? one character · ~* a real *
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {/* Within the grid's height: the list takes what is left, and scrolls. */}
      <div className="flex min-h-0 flex-col gap-2">
        <Input
          ref={findRef}
          aria-label="Find what"
          placeholder="Find what"
          className="h-8"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setListed(null);
            setStatus(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              findNext(e.shiftKey);
            }
          }}
        />
        {replacing && (
          <Input
            aria-label="Replace with"
            placeholder="Replace with"
            className="h-8"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                replaceOne();
              }
            }}
          />
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <label className="flex items-center gap-1">
            Within
            <select
              aria-label="Within"
              className={select}
              value={within}
              onChange={(e) => setWithin(e.target.value as FindWithin)}
            >
              <option value="sheet">Sheet</option>
              <option value="workbook">Workbook</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            Look in
            <select
              aria-label="Look in"
              className={select}
              value={replacing ? "formulas" : lookIn}
              disabled={replacing}
              title={replacing ? "Replace changes what was typed, as Excel's does" : undefined}
              onChange={(e) => setLookIn(e.target.value as "values" | "formulas" | "notes")}
            >
              <option value="values">Values</option>
              <option value="formulas">Formulas</option>
              <option value="notes">Notes</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(e) => setMatchCase(e.target.checked)}
            />
            Match case
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={entireCell}
              onChange={(e) => setEntireCell(e.target.checked)}
            />
            Entire cell
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {replacing ? (
            <>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={replaceAll}>
                Replace All
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={replaceOne}>
                Replace
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={findAll}>
            Find All
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7 text-xs"
            onClick={() => findNext(true)}
          >
            Find Previous
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={() => findNext()}>
            Find Next
          </Button>
        </div>
        {status && (
          <p
            role="status"
            data-testid="find-status"
            className={cn(
              "text-xs",
              status.tone === "warn"
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            {status.text}
          </p>
        )}
        {listed && listed.hits.length > 0 && (
          <div
            className="min-h-[4.5rem] flex-1 overflow-auto rounded border border-border"
            data-testid="find-results"
          >
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                <tr>
                  {within === "workbook" && <th className="px-2 py-1 font-medium">Sheet</th>}
                  <th className="px-2 py-1 font-medium">Cell</th>
                  <th className="px-2 py-1 font-medium">
                    {replacing || lookIn === "formulas"
                      ? "Contents"
                      : lookIn === "notes"
                        ? "Note"
                        : "Value"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {listed.hits.slice(0, LIST_MAX).map((h) => (
                  <tr
                    key={`${h.sheetId}:${h.row}:${h.col}`}
                    className="cursor-pointer border-t border-border hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    {...clickable(() => onGo(h), `Go to ${h.sheet}!${a1(h.row, h.col)}`)}
                  >
                    {within === "workbook" && <td className="px-2 py-1">{h.sheet}</td>}
                    <td className="px-2 py-1 font-mono">{a1(h.row, h.col)}</td>
                    <td className="max-w-[16rem] truncate px-2 py-1" title={h.text}>
                      {h.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(listed.hits.length > LIST_MAX || listed.more) && (
              <p className="border-t border-border px-2 py-1 text-[11px] text-muted-foreground">
                The first {LIST_MAX} are listed; Find Next walks them all.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
