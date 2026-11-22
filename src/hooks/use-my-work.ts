// What My work and the search palette read: every name you may see, each with
// what you have done with it.
//
// Two stores it does not own, the search index and your marks, and one extra
// read: a favourite older than the newest few hundred of its kind is not in
// the index, so its name is asked for by id.
import { useEffect, useMemo, useRef, useState } from "react";

import { useObjectIndex } from "@/hooks/use-object-index";
import { useObjectMarks } from "@/hooks/use-object-marks";
import type { ObjectEntry } from "@/lib/objectKinds";
import { marksToLookUp, withMarks } from "@/lib/objectMarks";
import { mergeEntries } from "@/lib/objectSearch";
import { objectsByIds } from "@/utils/objectSearch.functions";

export function useMyWork(active: boolean) {
  const index = useObjectIndex(active);
  const marks = useObjectMarks(active);
  const [older, setOlder] = useState<ObjectEntry[]>([]);

  const wanted = useMemo(
    () => marksToLookUp(marks.marks, index.entries, index.capped),
    [marks.marks, index.entries, index.capped],
  );
  // The same ids in the same kinds are the same question, however the object
  // holding them was rebuilt.
  const key = useMemo(
    () =>
      Object.entries(wanted)
        .map(([kind, ids]) => `${kind}=${[...(ids ?? [])].sort().join(",")}`)
        .sort()
        .join(";"),
    [wanted],
  );
  const asked = useRef(wanted);
  asked.current = wanted;
  const latest = useRef(0);
  useEffect(() => {
    if (!active || !key) {
      setOlder([]);
      return;
    }
    const run = ++latest.current;
    objectsByIds({ data: { ids: asked.current as Record<string, string[]> } })
      .then((r) => {
        if (run === latest.current) setOlder(r.entries);
      })
      .catch(() => {
        if (run === latest.current) setOlder([]);
      });
  }, [active, key]);

  const entries = useMemo(() => mergeEntries(index.entries, older), [index.entries, older]);
  const work = useMemo(() => withMarks(entries, marks.marks), [entries, marks.marks]);
  return { index, marks, entries, work };
}
