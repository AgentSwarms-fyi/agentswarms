// A fixed size for every chart below it (R509). Set only by the server render
// of a report's charts, where there is nothing to measure; see biChartBox.
import { createContext } from "react";

export type FixedSize = { width: number; height: number };

export const FixedChartSize = createContext<FixedSize | null>(null);
