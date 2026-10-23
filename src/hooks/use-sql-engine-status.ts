import { useEffect, useState } from "react";
import { browserEngineStatus, onBrowserEngineStatus } from "@/lib/browserDuckdb";
import type { EngineStatus } from "@/lib/browserDuckdb";

/** Subscribe a component to engine status. */
export function useSqlEngineStatus(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>(browserEngineStatus);
  useEffect(() => onBrowserEngineStatus(setStatus), []);
  return status;
}
