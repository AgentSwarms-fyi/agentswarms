// Keeps the workbook's thumbnail on the Sheets page true to what the editor
// shows: a little after the cells settle, the corner of the first grid sheet
// is drawn as it reads (computed values, not formulas) and, if that differs
// from the thumbnail kept, sent to be kept instead.

import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { WorkbookPreview } from "@/lib/sheets/preview";
import { previewOfSheet } from "@/lib/sheets/previewOfSheet";
import type { useWorkbook } from "@/components/sheets/useWorkbook";
import { sheetsSetPreview } from "@/utils/sheets.functions";

const SETTLE_MS = 2500;

export function useWorkbookPreview({
  wb,
  token,
  workbookId,
  stored,
}: {
  wb: ReturnType<typeof useWorkbook>;
  token: string | undefined;
  workbookId: string;
  /** The thumbnail kept now (undefined until the workbook has loaded). */
  stored: WorkbookPreview | null | undefined;
}) {
  const setFn = useServerFn(sheetsSetPreview);
  // Read when needed, not watched: a session refresh must not redraw it.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const last = useRef<string | null | undefined>(undefined);
  if (last.current === undefined && stored !== undefined)
    last.current = stored ? JSON.stringify(stored) : null;

  const { engine, rev, tabs } = wb;
  useEffect(() => {
    if (!engine || stored === undefined) return;
    const timer = setTimeout(() => {
      const token = tokenRef.current;
      const first = [...tabs]
        .sort((a, b) => a.position - b.position)
        .find((t) => t.kind === "grid");
      const grid = first ? engine.sheet(first.id)?.grid : undefined;
      if (!token || !first || !grid) return;
      const preview = previewOfSheet(engine, first.id, first.name, grid);
      const text = JSON.stringify(preview);
      if (text === last.current) return;
      last.current = text;
      setFn({ data: { access_token: token, workbook_id: workbookId, preview } })
        .then((r) => {
          if (!r.ok) last.current = null;
        })
        .catch(() => {
          last.current = null; // tried again after the next change
        });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [engine, rev, tabs, stored, workbookId, setFn]);
}
