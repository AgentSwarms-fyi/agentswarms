// A dataset's rows through the server, for the page's SQL engine. Used only for
// datasets marked `rows_sealed`, and when saving for a user under a customer key:
// the browser holds no key for those. Everyone else's rows are read and written
// directly, as they always were. Errors throw, because a failed read here must
// not register a table with some of its rows, and the callers already say so.
import { withToken } from "@/lib/chatHistory";
import {
  datasetRowsGoThroughServer,
  readDatasetWindow,
  readSharedDataset,
  writeDatasetBatch,
} from "@/utils/datasetRows.functions";

type Row = Record<string, unknown>;

/** One window of a dataset the signed-in user owns. */
export async function datasetWindow(tableId: string, from: number, size: number): Promise<Row[]> {
  const r = await withToken((t) =>
    readDatasetWindow({ data: { access_token: t, table_id: tableId, from, size } }),
  );
  if (r.error) throw new Error(r.error.message);
  return (r.data?.rows ?? []) as Row[];
}

/** A dataset shared with the signed-in user, as their grant lets them see it. */
export async function sharedDatasetRows(tableId: string): Promise<Row[]> {
  const r = await withToken((t) =>
    readSharedDataset({ data: { access_token: t, table_id: tableId } }),
  );
  if (r.error) throw new Error(r.error.message);
  return (r.data?.rows ?? []) as Row[];
}

/** Add a batch of rows to a dataset the signed-in user owns. */
export async function writeRowsThroughServer(tableId: string, rows: Row[]): Promise<void> {
  const r = await withToken(async (t) => {
    const res = await writeDatasetBatch({ data: { access_token: t, table_id: tableId, rows } });
    return res.ok ? { ok: true as const, wrote: true } : res;
  });
  if (r.error) throw new Error(r.error.message);
}

/**
 * Whether what the signed-in user saves goes through the server. An answer that
 * cannot be had counts as yes: the server path works for anyone, and the other
 * way a customer's rows would be written where the browser put them.
 */
export async function savesGoThroughServer(): Promise<boolean> {
  const r = await withToken((t) => datasetRowsGoThroughServer({ data: { access_token: t } }));
  return r.error ? true : (r.data?.through ?? true);
}
