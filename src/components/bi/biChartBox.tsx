// The size a chart is drawn at.
//
// In the browser a chart fills its card: recharts' ResponsiveContainer
// measures the card and redraws when it changes. A scheduled report renders
// the same chart components on the server (R509), where there is nothing to
// measure, and a container that cannot measure draws nothing at all.
//
// So the BI charts take their ResponsiveContainer from here. Under a
// FixedChartSize (biChartSize) it starts at that size, which is the size the
// server render keeps; without one it is recharts' own, measuring as before.
import { useContext, type ComponentProps } from "react";
import { ResponsiveContainer as RechartsResponsiveContainer } from "recharts";

import { FixedChartSize } from "@/components/bi/biChartSize";

export function ResponsiveContainer(props: ComponentProps<typeof RechartsResponsiveContainer>) {
  const fixed = useContext(FixedChartSize);
  return (
    <RechartsResponsiveContainer {...props} initialDimension={fixed ?? props.initialDimension} />
  );
}
