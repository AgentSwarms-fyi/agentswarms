/**
 * Waiting on a Lakehouse query that runs on Spark: poll its row until it ends.
 *
 * FOUND IN R222: the editor polled every two seconds and treated a `null`
 * reply as "The query is gone — it may have been cancelled elsewhere." But the
 * server returned `null` for a row it failed to READ as well as for one that
 * was absent, and a cancelled query keeps its row with status `cancelled`. So
 * one failed read in a run of minutes stopped the wait on a query that was
 * still running (it finished, and only History showed it), and the message
 * named a cancellation nobody made. The server now throws on a failed read;
 * here a failed poll is retried, and what is said names only what is known.
 */

export type SparkPollView<R> = {
  status: string;
  result: R | null;
  error: string | null;
  logs: string | null;
};

/** Consecutive failed polls tolerated before giving up on watching a query. */
export const SPARK_POLL_MAX_FAILURES = 5;

export async function pollSparkQuery<R>(
  poll: () => Promise<SparkPollView<R> | null>,
  onUpdate: (q: SparkPollView<R>) => void,
  wait: () => Promise<void> = () => new Promise((r) => setTimeout(r, 2000)),
): Promise<R | null> {
  let failures = 0;
  for (;;) {
    await wait();
    let q: SparkPollView<R> | null;
    try {
      q = await poll();
      failures = 0;
    } catch (e) {
      failures += 1;
      if (failures < SPARK_POLL_MAX_FAILURES) continue;
      throw new Error(
        `Could not check on the query (${(e as Error).message}). It may still be running; History shows it when it ends.`,
      );
    }
    if (!q) throw new Error("The server has no record of this query.");
    onUpdate(q);
    if (q.status === "succeeded") return q.result;
    if (q.status === "cancelled") return null;
    if (q.status === "failed") {
      const tail = (q.logs ?? "").trim().split("\n").slice(-6).join("\n");
      throw new Error((q.error ?? "The query failed on Spark.") + (tail ? `\n\n${tail}` : ""));
    }
  }
}
