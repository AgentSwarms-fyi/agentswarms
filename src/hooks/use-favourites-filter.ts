// "Favourites" as a filter on a list page: which of the page's things are
// starred, and whether the list is narrowed to them right now.
//
// The chip that shows it is src/components/FavouritesFilter.tsx. A list is
// never left empty by this filter: it is only on while something on the page
// is starred, and taking the last star off turns it off for good.
import { useEffect, useState } from "react";

import { useObjectMarks } from "@/hooks/use-object-marks";
import type { ObjectKindId } from "@/lib/objectKinds";
import { starredAmong } from "@/lib/objectMarks";

export type FavouritesFilterState = {
  /** The list is narrowed to favourites right now. */
  on: boolean;
  /** How many of the ids handed in are favourites. */
  count: number;
  toggle: () => void;
  /** Should the item with this id be listed? Always true while the filter is off. */
  keep: (id: string) => boolean;
};

/**
 * The filter for one list: `ids` are the ids of everything the page could
 * list (before its own search box narrows them), so the chip's number is how
 * many favourites the page holds, not how many match what was typed.
 */
export function useFavouritesFilter(
  kind: ObjectKindId,
  ids: readonly string[],
): FavouritesFilterState {
  const { marks } = useObjectMarks();
  const [wanted, setWanted] = useState(false);
  const starred = starredAmong(marks, kind, ids);
  const on = wanted && starred.size > 0;
  // With the last star gone the filter is off for good, not waiting: starring
  // something later must not narrow the list by surprise.
  const none = starred.size === 0;
  useEffect(() => {
    if (wanted && none) setWanted(false);
  }, [wanted, none]);
  return {
    on,
    count: starred.size,
    toggle: () => setWanted(!on),
    keep: (id) => !on || starred.has(id),
  };
}
