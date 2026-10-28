// What every tab of the ontology workspace shares: which ontology, the
// caller's part in it, the model as they work with it, and the way to change
// it. The owner edits a draft (saved automatically, revision-checked); a
// grantee reads the published version and changes it only by proposing.
import { createContext, useContext } from "react";
import type { OntologyDetail } from "@/utils/ontology.functions";
import type { OntologySpec } from "@/lib/ontology/spec";

export type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

export type OntologyCtx = {
  id: string;
  detail: OntologyDetail;
  spec: OntologySpec;
  /** Owner only: replace the draft (saved after a short pause). */
  setSpec: (next: OntologySpec | ((prev: OntologySpec) => OntologySpec)) => void;
  canEdit: boolean;
  saveState: SaveState;
  tokenRef: { current: string };
  /** Reload everything from the server (after publish, restore, merge). */
  reload: () => Promise<void>;
  /** Jump to another tab, optionally with something selected there. */
  go: (tab: WorkspaceTab, focus?: Focus) => void;
  focus: Focus | null;
};

export type WorkspaceTab =
  | "overview"
  | "model"
  | "explore"
  | "graph"
  | "metrics"
  | "rules"
  | "ask"
  | "actions"
  | "history"
  | "export";

export type Focus =
  | { kind: "type"; name: string }
  | { kind: "link"; from: string; name: string }
  | { kind: "object"; objectType: string; key: Record<string, unknown> }
  | { kind: "rule"; id: string };

export const OntologyContext = createContext<OntologyCtx | null>(null);

export function useOntology(): OntologyCtx {
  const c = useContext(OntologyContext);
  if (!c) throw new Error("useOntology outside the ontology workspace");
  return c;
}
