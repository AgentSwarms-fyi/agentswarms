// The SQL of a query sheet (R154), with a preview of what it returns: the
// first rows, read as the person writing it, before a sheet is made or its
// query changed. Ctrl+Enter runs the preview.

import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatGeneral } from "@/lib/sheets/formula/values";
import { queryVariables, type QueryParams } from "@/lib/sheets/sql/queryParams";
import { sheetsPreviewQuery } from "@/utils/sheetsTables.functions";

type Preview = {
  columns: { name: string; type: string }[];
  rows: (string | number | boolean | null)[][];
  more: boolean;
  duration_ms: number;
};

export function QueryEditor({
  token,
  workbookId,
  sql,
  onSql,
  tables,
  params,
}: {
  token: string;
  workbookId: string;
  sql: string;
  onSql: (sql: string) => void;
  /** Lakehouse tables the person can read; a click puts one in the query. */
  tables?: { schema: string; table: string }[];
  /** The workbook names' values, for {{variables}} (R155). */
  params?: QueryParams;
}) {
  const previewFn = useServerFn(sheetsPreviewQuery);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const vars = queryVariables(sql);

  const run = async () => {
    if (!sql.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const r = await previewFn({
        data: { access_token: token, workbook_id: workbookId, sql: sql.trim(), params },
      });
      if (!r.ok) {
        setPreview(null);
        setError(r.error);
      } else setPreview(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  /** A table's name at the cursor, or a whole query when the box is empty. */
  const insert = (t: { schema: string; table: string }) => {
    const name = `${t.schema}.${t.table}`;
    if (!sql.trim()) {
      onSql(`SELECT *\nFROM ${name}`);
      return;
    }
    const el = area.current;
    const at = el ? el.selectionStart : sql.length;
    const end = el ? el.selectionEnd : sql.length;
    onSql(sql.slice(0, at) + name + sql.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + name.length, at + name.length);
    });
  };

  return (
    <div className="grid gap-2">
      <div className={tables?.length ? "grid gap-2 sm:grid-cols-[1fr_12rem]" : "grid"}>
        <Textarea
          ref={area}
          aria-label="SQL"
          data-testid="query-sql"
          className="min-h-40 font-mono text-xs"
          spellCheck={false}
          placeholder={
            "SELECT region, sum(amount) AS revenue\nFROM analytics.orders\nGROUP BY region"
          }
          value={sql}
          onChange={(e) => onSql(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
        {tables && tables.length > 0 && (
          <div
            className="max-h-40 overflow-y-auto rounded-md border border-border text-xs"
            aria-label="Tables you can read"
            role="list"
          >
            {tables.map((t) => (
              <button
                key={`${t.schema}.${t.table}`}
                type="button"
                role="listitem"
                className="block w-full truncate px-2 py-1 text-left font-mono hover:bg-muted"
                title={`Put ${t.schema}.${t.table} in the query`}
                onClick={() => insert(t)}
              >
                {t.schema}.{t.table}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!sql.trim() || running}
          onClick={() => void run()}
          data-testid="query-preview"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}{" "}
          Preview
        </Button>
        <span className="text-xs text-muted-foreground">
          Ctrl+Enter. One SELECT (or WITH), read with your own lakehouse access.{" "}
          <code className="font-mono">{"{{Name}}"}</code> is the value of the workbook name Name
          (Data → Names).
        </span>
      </div>
      {vars.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="query-variables">
          Variables:{" "}
          {vars.map((v, i) => {
            const val =
              params?.[Object.keys(params).find((k) => k.toLowerCase() === v.toLowerCase()) ?? ""];
            return (
              <span key={v}>
                {i > 0 && ", "}
                <code className="font-mono">{v}</code> ={" "}
                {val === undefined ? (
                  <span className="text-destructive">no such name</span>
                ) : (
                  <span className="font-mono">{JSON.stringify(val)}</span>
                )}
              </span>
            );
          })}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert" data-testid="query-error">
          {error}
        </p>
      )}
      {preview && (
        <div className="grid gap-1" data-testid="query-result">
          <p className="text-xs text-muted-foreground">
            {preview.columns.length} column{preview.columns.length === 1 ? "" : "s"} ·{" "}
            {preview.more
              ? `the first ${preview.rows.length} rows`
              : `${preview.rows.length} row${preview.rows.length === 1 ? "" : "s"}`}{" "}
            · {preview.duration_ms} ms
          </p>
          <div className="max-h-48 overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {preview.columns.map((c) => (
                    <th
                      key={c.name}
                      className="whitespace-nowrap px-2 py-1 text-left font-medium"
                      title={c.type}
                    >
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {row.map((v, j) => (
                      <td key={j} className="whitespace-nowrap px-2 py-0.5">
                        {v === null ? "" : typeof v === "number" ? formatGeneral(v) : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
