// The grid's side of formulas over table sheets. A cell that reads
// Orders[amount] through SUMIFS or XLOOKUP asks here; the first time, the
// answer is pending (the cell shows #BUSY!) while the call joins a batch sent
// to the server a moment later; when the answers arrive, the cells that asked
// are recalculated. Answers are kept until the table changes.

import type { TableResolver } from "./engine";
import { PENDING, type TableCallRequest } from "./formula/evaluate";
import { err, type Value } from "./formula/values";
import { tablesOf } from "./sql/tableCalls";

export type WireAnswer = { v: string | number | boolean | null } | { e: string; d?: string };

const BATCH_MS = 40;
const BATCH_MAX = 200;

export class GridTableResolver implements TableResolver {
  private cache = new Map<string, Value>();
  private inFlight = new Set<string>();
  private queue = new Map<string, TableCallRequest>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by invalidate(), so an answer to an older question is dropped. */
  private epoch = 0;

  constructor(
    private opts: {
      isTable: (name: string) => boolean;
      fetch: (
        calls: { key: string; req: TableCallRequest }[],
      ) => Promise<Record<string, WireAnswer>>;
      /** Answers arrived for these tables (lowercased): recalculate their readers. */
      onAnswers: (tables: string[]) => void;
      onError: (message: string) => void;
    },
  ) {}

  isTable(name: string): boolean {
    return this.opts.isTable(name);
  }

  resolve(node: { table?: string; column: string }): Value {
    // A whole column read directly (=Orders[amount], =UNIQUE(Orders[region]))
    // would bring every row to the browser.
    return err(
      "#VALUE!",
      `${node.table ?? ""}[${node.column}] is a whole table column. Use it inside SUM, SUMIFS, COUNTIFS, AVERAGEIFS, XLOOKUP, VLOOKUP or INDEX/MATCH, which the lakehouse computes; for a list of values, add a pivot or a filter on the table sheet.`,
    );
  }

  call(req: TableCallRequest): Value | typeof PENDING {
    const key = JSON.stringify(req);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (!this.inFlight.has(key)) {
      this.queue.set(key, req);
      if (!this.timer) this.timer = setTimeout(() => void this.flush(), BATCH_MS);
    }
    return PENDING;
  }

  /** Forget answers that read `table` (or all), e.g. after its formulas or data changed. */
  invalidate(table?: string): void {
    this.epoch++;
    if (!table) {
      this.cache.clear();
      return;
    }
    const t = table.toLowerCase();
    for (const key of [...this.cache.keys()]) {
      if (tablesOf(JSON.parse(key) as TableCallRequest).includes(t)) this.cache.delete(key);
    }
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const batch = [...this.queue.entries()].slice(0, BATCH_MAX);
    for (const [key] of batch) {
      this.queue.delete(key);
      this.inFlight.add(key);
    }
    if (this.queue.size && !this.timer) this.timer = setTimeout(() => void this.flush(), 0);
    if (!batch.length) return;
    const epoch = this.epoch;
    const tables = new Set<string>();
    for (const [, req] of batch) tablesOf(req).forEach((t) => tables.add(t));
    try {
      const answers = await this.opts.fetch(batch.map(([key, req]) => ({ key, req })));
      if (epoch !== this.epoch) {
        // The tables changed while this was asked; ask again.
        for (const [key, req] of batch) this.queue.set(key, req);
        if (!this.timer) this.timer = setTimeout(() => void this.flush(), 0);
        return;
      }
      for (const [key] of batch) {
        const a = answers[key];
        this.cache.set(
          key,
          !a
            ? err("#VALUE!", "No answer came back")
            : "e" in a
              ? err(a.e as Parameters<typeof err>[0], a.d)
              : a.v,
        );
      }
    } catch (e) {
      const message = (e as Error).message;
      // Keep the cells answerable: an error now, asked again after a change.
      for (const [key] of batch)
        this.cache.set(key, err("#VALUE!", `Could not ask the lakehouse: ${message}`));
      this.opts.onError(message);
    } finally {
      for (const [key] of batch) this.inFlight.delete(key);
    }
    this.opts.onAnswers([...tables]);
  }
}
