// The dashboard's parameters as Controls visuals read and set them (R501).
// Its own module so the control components' file exports only components.
import { createContext } from "react";

import type { BiParamConfig, BiParamValues } from "@/lib/biParams";

export type BiParamState = {
  params: BiParamConfig[];
  values: BiParamValues;
  setValue: (name: string, value: string) => void;
  /** Widgets re-running for a new value. */
  busy?: boolean;
};

export const BiParamContext = createContext<BiParamState | null>(null);
