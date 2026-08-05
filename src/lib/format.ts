// Shared display formatters. One rule per format, used everywhere the value
// appears, so the dashboard and the trace views never disagree about how a
// duration reads.

/**
 * Durations: milliseconds are the honest unit under a second; above it a
 * five-digit millisecond count ("35045ms") makes the reader do the division,
 * so switch to one-decimal seconds.
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
