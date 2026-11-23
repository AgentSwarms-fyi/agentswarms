// Connector templates (R528): a starting point per API, one JSON file each in
// src/connectors/. Adding a source is adding a file there and its recorded
// responses in tests/fixtures/connectors/; tests/unit/connectorTemplates.test.ts
// checks every file, and runs each stream against its fixtures through the
// same engine a sync uses. No code, no provider, no migration.
//
// A template is never trusted as written. Its inputs are filled with values
// that cannot change the host or leave a path segment, and the result goes
// through checkConnectorSpec like a spec a person typed. Each says how it was
// checked: "live" means it was run against a real account here; "reference"
// means it follows the API's published reference and its own fixtures, and
// has not been run against a real account yet.
import type { ConnectorTemplate } from "@/lib/connectorTemplate";

export { applyTemplate, INPUT_VALUE } from "@/lib/connectorTemplate";
export type { ConnectorTemplate, TemplateInput } from "@/lib/connectorTemplate";

const FILES = import.meta.glob<ConnectorTemplate>("/src/connectors/*.json", {
  eager: true,
  import: "default",
});

/** Every template, by label. */
export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = Object.values(FILES).sort((a, b) =>
  a.label.localeCompare(b.label),
);

export const templateById = (id: string): ConnectorTemplate | undefined =>
  CONNECTOR_TEMPLATES.find((t) => t.id === id);
