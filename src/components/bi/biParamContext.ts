// The dashboard's parameters as Controls visuals read and set them (R501),
// and what a page shows its reader (R503).
// Its own module so the control components' file exports only components.
import { createContext } from "react";

import type { TextTokenState } from "@/lib/biInteract";
import type { BiParamConfig, BiParamValues } from "@/lib/biParams";

export type BiParamState = {
  params: BiParamConfig[];
  values: BiParamValues;
  setValue: (name: string, value: string) => void;
  /** Widgets re-running for a new value. */
  busy?: boolean;
};

export const BiParamContext = createContext<BiParamState | null>(null);

/**
 * What a page shows a reader (R503), for every dashboard view — the editor, a
 * shared link, an embed: the values titles and text fill in, and the means to
 * follow a #page= link. Absent (an export, a thumbnail): titles fill in at the
 * defaults and page links do nothing.
 */
export type BiViewState = TextTokenState & {
  /** Opens the page a #page= link names; false when there is no such page. */
  openPage: (href: string) => boolean;
};

export const BiViewContext = createContext<BiViewState | null>(null);
