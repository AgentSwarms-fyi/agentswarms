// Readable sentences for a provider-credential form that failed its schema.
//
// The server functions in credentials.functions.ts used to validate with
// `schema.parse(input)`. A ZodError's message is the serialised issue array,
// and that is what reached the reader: saving an OCI key pasted short put
// `[{"origin":"string","code":"too_small","minimum":40,"path":["oci_genai",
// "privateKeyPem"],...}]` in both the toast and the dialog. The field to fix is
// in there, under a name the dialog never uses. This turns each failing field
// into one sentence that names the field as the dialog labels it and says what
// to do about it.
//
// Client-safe — zod types only — because credentials.functions.ts is imported
// by client routes.
import type { z } from "zod";

export type FieldText = {
  /** The field's label in the Configure dialog, without "(optional)". */
  label: string;
  /** What to do when it is too short: usually, a value pasted only in part. */
  tooShort?: string;
  /** What a well-formed value looks like, for a URL or pattern mismatch. */
  shape?: string;
};

type Issue = z.core.$ZodIssue;
type FieldNamer = (path: readonly PropertyKey[], input: unknown) => FieldText | undefined;

const PASTED_PART = "check that you pasted all of it";
const ocid = (kind: string) => `paste the whole OCID, which starts ocid1.${kind}`;

/**
 * The save schema's fields, keyed by schema path, labelled as the dialog
 * labels them (LLM_PROVIDERS and the Network section in
 * ProviderCredentialsPanel.tsx). `label` and `style` are set by the dialog, not
 * typed, so they have plain names in case one ever fails.
 */
export const SAVE_FIELD_TEXT: Record<string, FieldText> = {
  provider: { label: "Provider" },
  label: { label: "Label" },
  defaultModel: { label: "Deployment Name" },
  "bedrock.region": { label: "AWS Region" },
  "bedrock.accessKeyId": { label: "Access Key ID", tooShort: PASTED_PART },
  "bedrock.secretAccessKey": { label: "Secret Access Key", tooShort: PASTED_PART },
  "bedrock.sessionToken": { label: "Session Token" },
  "vertex.projectId": { label: "GCP Project ID" },
  "vertex.location": { label: "Region" },
  "vertex.serviceAccountJson": {
    label: "Service Account Key (JSON)",
    tooShort: "paste the whole JSON key file",
  },
  "anthropic.apiKey": { label: "API Key", tooShort: PASTED_PART },
  "azure_openai.endpoint": {
    label: "Azure Endpoint URL",
    shape: "enter the full address, such as https://myresource.openai.azure.com",
  },
  "azure_openai.apiKey": { label: "API Key", tooShort: PASTED_PART },
  "azure_openai.apiVersion": { label: "API Version" },
  "oci_genai.region": { label: "Region" },
  "oci_genai.compartmentId": { label: "Compartment OCID", tooShort: ocid("compartment") },
  "oci_genai.tenancyOcid": { label: "Tenancy OCID", tooShort: ocid("tenancy") },
  "oci_genai.userOcid": { label: "User OCID", tooShort: ocid("user") },
  "oci_genai.fingerprint": {
    label: "API Key Fingerprint",
    tooShort: "paste all 16 colon-separated pairs",
  },
  "oci_genai.privateKeyPem": {
    label: "Private Key (PEM)",
    tooShort: "paste the whole PEM file, from its -----BEGIN line to its -----END line",
  },
  "oci_genai.style": { label: "Style" },
  "qwen.apiKey": { label: "API Key", tooShort: PASTED_PART },
  "qwen.baseUrl": {
    label: "Custom Base URL",
    shape: "enter the full address, such as https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
  "claude_aws.region": { label: "AWS Region" },
  "claude_aws.workspaceId": {
    label: "Workspace ID",
    shape: "it looks like wrkspc_01AbCdEf23GhIj",
  },
  "claude_aws.apiKey": { label: "API Key" },
  "claude_aws.accessKeyId": { label: "Access Key ID" },
  "claude_aws.secretAccessKey": { label: "Secret Access Key" },
  "claude_aws.sessionToken": { label: "Session Token" },
};

// Fields every cloud provider's dialog shows the same way, in its Network section.
const NETWORK_FIELD_TEXT: Record<string, FieldText> = {
  endpoint: { label: "Private endpoint URL", shape: "enter an https address with no path" },
  requirePrivate: { label: "Require a private network path" },
};

/** Names a field of saveProviderCredential's input. */
export const saveFieldText: FieldNamer = (path) =>
  SAVE_FIELD_TEXT[path.join(".")] ??
  (path.length === 2 ? NETWORK_FIELD_TEXT[String(path[1])] : undefined);

/**
 * Names a field of checkProviderNetworkPath's input, which carries only the
 * region and endpoint — labelled as the provider's own dialog labels them.
 */
export const networkPathFieldText: FieldNamer = (path, input) => {
  const provider = (input as { provider?: unknown } | null)?.provider;
  if (path[0] === "provider" || typeof provider !== "string") return saveFieldText(path, input);
  const saved = path[0] === "region" && provider === "vertex" ? "location" : path[0];
  return saveFieldText([provider, saved], input);
};

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let v = input;
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<PropertyKey, unknown>)[k];
  }
  return v;
}

function sentence(issue: Issue, field: FieldText, value: unknown): string {
  const { label } = field;
  const missing =
    value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  switch (issue.code) {
    case "invalid_type":
      if (missing) return `${label} is required.`;
      if (issue.expected === "boolean") return `${label} must be on or off.`;
      if (issue.expected === "string") return `${label} must be text.`;
      return `${label} is not valid.`;
    case "too_small":
      if (missing) return `${label} is required.`;
      if (field.tooShort) return `${label} is too short — ${field.tooShort}.`;
      return issue.origin === "string"
        ? `${label} is too short — it needs at least ${issue.minimum} characters.`
        : `${label} is too small.`;
    case "too_big":
      return issue.origin === "string"
        ? `${label} is too long — it can be at most ${issue.maximum} characters.`
        : `${label} is too large.`;
    case "invalid_format":
      if (field.shape) return `${label} is not in the right form — ${field.shape}.`;
      return issue.format === "url"
        ? `${label} must be a full address, starting https://.`
        : `${label} is not in the right form.`;
    case "invalid_value":
      return `${label} must be one of: ${issue.values.map(String).join(", ")}.`;
    default:
      return `${label} is not valid.`;
  }
}

/**
 * One sentence per failing field, in the order the schema reported them. A
 * field with several problems gets the first: a required field left empty is
 * also "too short", and saying both reads as two things to fix.
 */
export function explainIssues(
  issues: readonly Issue[],
  input: unknown,
  fieldFor: FieldNamer,
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const issue of issues) {
    const key = issue.path.map(String).join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    const last = issue.path[issue.path.length - 1];
    const field = fieldFor(issue.path, input) ?? {
      label: last === undefined ? "The request" : `The ${String(last)} field`,
    };
    out.push(sentence(issue, field, valueAt(input, issue.path)));
  }
  return out.join(" ") || "That input is not valid.";
}

/** `schema.parse(input)`, except a failure throws readable sentences, not the issue JSON. */
export function parseOrExplain<S extends z.ZodType>(
  schema: S,
  input: unknown,
  fieldFor: FieldNamer,
): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new Error(explainIssues(r.error.issues, input, fieldFor));
}
