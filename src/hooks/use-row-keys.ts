import { useRef } from "react";

/**
 * Stable React keys for a list of rows edited in place. Keyed by index, a
 * row's own state (a header's value source, say) would pass to the row below
 * it when a row above was removed; these keys follow the rows instead.
 */
export function useRowKeys(length: number): {
  keys: readonly string[];
  /** Call just before removing row `i`. */
  removeAt: (i: number) => void;
} {
  const keys = useRef<string[]>([]);
  const next = useRef(0);
  while (keys.current.length < length) keys.current.push(`row-${next.current++}`);
  if (keys.current.length > length) keys.current.length = length;
  return {
    keys: keys.current,
    removeAt: (i: number) => {
      keys.current.splice(i, 1);
    },
  };
}
