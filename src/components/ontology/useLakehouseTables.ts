// The lakehouse tables the caller can read, for binding pickers. Read once
// per workspace visit; the list rarely changes while someone is modelling.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ontologyTables } from "@/utils/ontology.functions";

export type LakeTable = { table: string; columns: { name: string; type: string }[] };

let cache: { at: number; tables: LakeTable[] } | null = null;

export function useLakehouseTables(tokenRef: { current: string }, enabled = true) {
  const fn = useServerFn(ontologyTables);
  const [tables, setTables] = useState<LakeTable[] | null>(cache?.tables ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (cache && Date.now() - cache.at < 60_000) {
      setTables(cache.tables);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const res = await fn({ data: { access_token: tokenRef.current } });
        if (!live) return;
        if (!res.ok) setError(res.error);
        else if (!res.enabled) setError("The lakehouse is not configured on this instance.");
        else {
          cache = { at: Date.now(), tables: res.tables };
          setTables(res.tables);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, fn, tokenRef]);
  return { tables, error };
}
