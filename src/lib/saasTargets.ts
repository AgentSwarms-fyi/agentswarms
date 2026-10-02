// Reverse ETL into a SaaS tool: push rows back into the CRM they came from.
//
// The platform already has an HTTP API target, and for a plain endpoint it is
// the right tool. It is the WRONG tool for a CRM, and for one specific reason
// that is worth stating before any of the code below makes sense.
//
// CRM WRITE APIS RETURN 200 WITH PER-RECORD FAILURES. HubSpot's batch upsert
// answers 207-style semantics inside a 200 body; Salesforce's composite
// sObjects endpoint returns 200 with an array where each element has its own
// `success` flag. The generic target calls raise_for_status(), sees 200, and
// reports every row loaded. So a run that pushed 5,000 contacts and had 4,000
// rejected for a missing required property is recorded in the run history as a
// complete success, and nobody finds out until someone asks the CRM why the
// numbers are wrong. That is the same shape of failure as training-serving
// skew: silent, no error, and invisible from the outside.
//
// So a named target is not sugar for a URL. It is the thing that reads the
// response the way the vendor actually writes it, and fails the run when
// records were rejected.
//
// The second reason is batch caps. Every one of these APIs has a hard limit
// per request (100 for HubSpot, 200 for Salesforce). Exceed it and the whole
// batch is rejected — so the cap belongs in the platform, not in a number a
// user has to look up and type into "rows per request".

export type SaasTargetVendor = "hubspot" | "salesforce";

export type SaasTargetObject = {
  /** What the vendor calls it in the URL. */
  id: string;
  label: string;
};

export type SaasTargetSpec = {
  vendor: SaasTargetVendor;
  label: string;
  /** Hard limit per request. Exceeding it fails the whole batch, not one row. */
  maxBatch: number;
  objects: SaasTargetObject[];
  /** What the identity column is called in this vendor's vocabulary. */
  idLabel: string;
  idHint: string;
};

export const SAAS_TARGETS: Record<SaasTargetVendor, SaasTargetSpec> = {
  hubspot: {
    vendor: "hubspot",
    label: "HubSpot",
    // POST /crm/v3/objects/<object>/batch/upsert takes at most 100 inputs.
    maxBatch: 100,
    objects: [
      { id: "contacts", label: "Contacts" },
      { id: "companies", label: "Companies" },
      { id: "deals", label: "Deals" },
      { id: "tickets", label: "Tickets" },
      { id: "products", label: "Products" },
    ],
    idLabel: "Unique property",
    idHint:
      "The HubSpot property that identifies a record — email for contacts, domain for companies, or any property marked unique. The column of the same name in your rows supplies the value.",
  },
  salesforce: {
    vendor: "salesforce",
    label: "Salesforce",
    // PATCH /composite/sobjects/<object>/<externalIdField> takes 200 records.
    maxBatch: 200,
    objects: [
      { id: "Account", label: "Accounts" },
      { id: "Contact", label: "Contacts" },
      { id: "Lead", label: "Leads" },
      { id: "Opportunity", label: "Opportunities" },
      { id: "Case", label: "Cases" },
      { id: "Campaign", label: "Campaigns" },
    ],
    idLabel: "External ID field",
    idHint:
      "A Salesforce field marked External ID. Upsert matches on it, so the same row twice updates rather than duplicates — which is the whole reason to use one.",
  },
};

export const SAAS_TARGET_VENDORS = Object.keys(SAAS_TARGETS) as SaasTargetVendor[];

/** Whether a connection's provider can be written to, not just read from. */
export function isWritableVendor(provider: string): provider is SaasTargetVendor {
  return Object.prototype.hasOwnProperty.call(SAAS_TARGETS, provider);
}

export type SaasTargetConfig = {
  type: "saas";
  /** The SaaS connection to write through — the same one that syncs rows in. */
  connection_id?: string;
  vendor?: SaasTargetVendor;
  object?: string;
  /** Column whose value identifies the record; also the vendor's id field. */
  id_column?: string;
  /** Columns to send as fields. Empty = every column except the id column. */
  columns?: string[];
  batch_size?: number;
};

/**
 * Why this target cannot run, or null.
 *
 * Checked when the pipeline is saved as well as at compile time, because a
 * reverse-ETL misconfiguration otherwise surfaces halfway through writing to
 * somebody's production CRM — the one place where "fail late" is worst.
 */
export function validateSaasTarget(c: SaasTargetConfig): string | null {
  if (!c.connection_id) return "Pick the SaaS connection to write through";
  if (!c.vendor || !SAAS_TARGETS[c.vendor]) return "Pick a destination the platform can write to";
  const spec = SAAS_TARGETS[c.vendor];
  if (!c.object) return `Pick which ${spec.label} object to write`;
  if (!spec.objects.some((o) => o.id === c.object)) {
    return `${spec.label} cannot be written as "${c.object}"`;
  }
  if (!c.id_column?.trim()) return `Name the ${spec.idLabel.toLowerCase()}`;
  if (!/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(c.id_column.trim())) {
    return `"${c.id_column}" is not a column name`;
  }
  if (c.columns?.includes(c.id_column.trim())) {
    // Not fatal for the API, but it means the identity is also being written
    // as a field, which is how an upsert key gets overwritten by a stale copy.
    return `${c.id_column} identifies the record; it cannot also be sent as a field`;
  }
  return null;
}

/** Rows per request: the vendor's cap, never more, whatever was configured. */
export function batchSizeFor(c: SaasTargetConfig): number {
  const spec = c.vendor ? SAAS_TARGETS[c.vendor] : null;
  const cap = spec?.maxBatch ?? 100;
  const wanted = Math.floor(c.batch_size ?? cap);
  return Math.max(1, Math.min(cap, wanted || cap));
}

/**
 * The path part of the endpoint. The host is the tenant's own and is resolved
 * server-side into the sandbox's environment, so it is never baked into code.
 */
export function endpointPath(c: SaasTargetConfig): string {
  if (c.vendor === "hubspot") return `/crm/v3/objects/${c.object}/batch/upsert`;
  return `/services/data/v61.0/composite/sobjects/${c.object}/${c.id_column}`;
}

/** POST or PATCH — Salesforce upserts by external id with PATCH. */
export function methodFor(c: SaasTargetConfig): "POST" | "PATCH" {
  return c.vendor === "salesforce" ? "PATCH" : "POST";
}

/**
 * How many records a response says failed, and why.
 *
 * This is the function the whole feature exists for. Both vendors answer 200
 * and then report per-record outcomes in the body, in different shapes:
 *
 *   HubSpot   { status, results: [...], errors?: [{message, context}],
 *               numErrors }
 *   Salesforce [ {id, success, errors: [{message, fields}]}, … ]
 *
 * Returns the count and up to a few messages, so a run's error names what to
 * fix rather than "some records failed".
 */
export function readFailures(
  vendor: SaasTargetVendor,
  body: unknown,
  sent: number,
): { failed: number; messages: string[] } {
  const messages: string[] = [];
  if (vendor === "salesforce") {
    const rows = Array.isArray(body) ? body : [];
    let failed = 0;
    for (const r of rows) {
      const rec = r as { success?: boolean; errors?: { message?: string; fields?: string[] }[] };
      if (rec?.success === true) continue;
      failed += 1;
      const e = rec?.errors?.[0];
      if (e && messages.length < 3) {
        messages.push(
          [e.message, e.fields?.length ? `(${e.fields.join(", ")})` : ""].join(" ").trim(),
        );
      }
    }
    // A response that is not an array at all means the request was rejected
    // wholesale; treat every record in the batch as failed rather than as
    // silently fine.
    if (!Array.isArray(body))
      return { failed: sent, messages: ["Salesforce did not return a per-record result"] };
    return { failed, messages };
  }

  const b = (body ?? {}) as {
    numErrors?: number;
    errors?: { message?: string; context?: Record<string, unknown> }[];
    results?: unknown[];
    status?: string;
  };
  const errs = Array.isArray(b.errors) ? b.errors : [];
  for (const e of errs.slice(0, 3)) if (e?.message) messages.push(e.message);
  // numErrors is authoritative when present; otherwise infer from how many
  // results came back for how many were sent, because a partial success with
  // no numErrors still lost rows.
  const failed =
    typeof b.numErrors === "number"
      ? b.numErrors
      : errs.length > 0
        ? errs.length
        : Array.isArray(b.results)
          ? Math.max(0, sent - b.results.length)
          : 0;
  return { failed, messages };
}

/** One line for the run log and the error, saying what was rejected. */
export function failureMessage(
  spec: SaasTargetSpec,
  failed: number,
  total: number,
  messages: string[],
): string {
  const head = `${spec.label} rejected ${failed} of ${total} record${total === 1 ? "" : "s"}`;
  const why = messages.filter(Boolean).slice(0, 3).join("; ");
  return why ? `${head}: ${why}` : head;
}
