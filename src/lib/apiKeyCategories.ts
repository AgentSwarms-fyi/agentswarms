// Every credential/key store in the app, besides swarm_api_keys (which
// ApiKeysSettingsPanel manages inline directly — Settings is its only home).
// Each category here gets a live-count card whose "Manage" button opens the
// exact same panel component its dedicated page renders, in a Dialog, so
// Settings offers real inline create/edit/revoke controls rather than a
// link out. One list, so "every type of API key in the app" actually means
// every one of them, not whichever the last person remembered to add.
//
// R385: that sentence was not yet true. Five kinds of key this instance
// issues (MCP app keys, notebook keys, lakehouse share tokens, workflow and
// ETL trigger tokens) plus SCIM tokens for superadmins had no card — so a key
// that could reach your data had nowhere to be seen or revoked from — and
// neither did the credentials for warehouses, catalog and Knowledge Base
// sources, Iceberg catalogs, app connectors, Slack/Teams apps, service
// integrations or an agent's n8n webhook. tests/unit/apiKeyCategories.test.ts
// now scans the migrations for key-bearing tables and fails when one is
// neither listed here nor excluded below with a reason.
//
// Deliberately excludes encryption_keys (supabase/migrations/
// 20260888000000_encryption_keys.sql): that table is the platform's own
// envelope-encryption config (which KMS wraps the data-encryption key) — an
// operator/deployment concern, not a credential any individual user holds.
import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  Blocks,
  BookOpenText,
  Boxes,
  Cloud,
  Code2,
  Database,
  HardDrive,
  KeyRound,
  Layers,
  MessagesSquare,
  NotebookPen,
  Plug,
  Puzzle,
  Server,
  Share2,
  UsersRound,
  Workflow,
  Zap,
} from "lucide-react";

export type ApiKeyCategoryId =
  // Keys and tokens this instance issues — whoever holds one reaches in.
  | "gateway"
  | "ml"
  | "embeds"
  | "mcp_app_keys"
  | "notebook_keys"
  | "share_tokens"
  | "workflow_triggers"
  | "etl_triggers"
  | "scim_tokens"
  // Credentials for other services that you have given this instance.
  | "providers"
  | "secrets"
  | "mcp"
  | "warehouses"
  | "catalog_sources"
  | "iceberg"
  | "saas"
  | "chat_apps"
  | "kb_connectors"
  | "integrations";

/**
 * A condition a row must meet to count. Plain data rather than a query-builder
 * callback, so it stays typeable and testable; countOps() turns it into the
 * PostgREST calls. `is_self` compares a column with the signed-in user's id —
 * needed where RLS also shows rows merely SHARED with you (catalog sources),
 * which are someone else's credentials, not yours.
 */
export type CountFilter =
  | { column: string; op: "eq" | "neq"; value: string | boolean }
  | { column: string; op: "in"; value: string[] }
  | { column: string; op: "is_null" | "not_null" }
  | { column: string; op: "is_self" };

/** One table a category's count reads. A category's count is the sum of its sources. */
export type CountSource = {
  /** Table to count (RLS scopes it to the caller, as every direct read here). */
  table: string;
  filters?: CountFilter[];
  /**
   * The column holding the key's expiry. A key past it is refused at use time
   * but keeps `is_active = true` (only revoking flips that), so without this
   * an "active" count includes keys that no longer work.
   */
  expiresColumn?: string;
};

export type ApiKeyCategory = {
  id: ApiKeyCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Where this category's dedicated full page lives (still useful as a
   * "open as a page" escape hatch from inside its Settings dialog). */
  route: string;
  /** "issued": keys this instance mints. "stored": other services' credentials. */
  group: "issued" | "stored";
  sources: CountSource[];
  /** The table's RLS shows rows to superadmins only, so nobody else gets the card. */
  superadminOnly?: boolean;
};

const ACTIVE = { column: "is_active", op: "eq", value: true } as const;

export const API_KEY_CATEGORIES: ApiKeyCategory[] = [
  // ── Keys this instance issues ─────────────────────────────────────────────
  {
    id: "gateway",
    label: "LLM Gateway Keys",
    description: "Keys for calling into this instance's own LLM gateway from outside it.",
    icon: Server,
    route: "/integrations",
    group: "issued",
    sources: [{ table: "gateway_keys", filters: [ACTIVE], expiresColumn: "expires_at" }],
  },
  {
    id: "ml",
    label: "ML Model API Keys",
    description: "Serve predictions from a trained model you've published.",
    icon: Boxes,
    route: "/ml",
    group: "issued",
    sources: [{ table: "ml_api_keys", filters: [ACTIVE], expiresColumn: "expires_at" }],
  },
  {
    id: "embeds",
    label: "Web Embed Keys",
    description: "Capability tokens that authorize an agent, swarm or dashboard iframe embed.",
    icon: Code2,
    route: "/embeds",
    group: "issued",
    sources: [{ table: "embed_keys", filters: [ACTIVE], expiresColumn: "expires_at" }],
  },
  {
    id: "mcp_app_keys",
    label: "MCP App Keys",
    description: "Keys that call the MCP servers you built in MCP Builder.",
    icon: Blocks,
    route: "/mcp-builder",
    group: "issued",
    sources: [
      {
        table: "mcp_app_keys",
        // The internal key is the platform's own, used by your agents; it is
        // not one you issued, and revoking it would break them.
        filters: [ACTIVE, { column: "is_internal", op: "eq", value: false }],
        expiresColumn: "expires_at",
      },
    ],
  },
  {
    id: "notebook_keys",
    label: "Notebook API Keys",
    description: "Keys that run your Python notebooks from outside the app.",
    icon: NotebookPen,
    route: "/notebooks",
    group: "issued",
    sources: [{ table: "notebook_api_keys", filters: [ACTIVE], expiresColumn: "expires_at" }],
  },
  {
    id: "share_tokens",
    label: "Lakehouse Share Tokens",
    description:
      "Delta Sharing tokens given to recipients OUTSIDE this instance — each reads the tables its share holds.",
    icon: Share2,
    route: "/lakehouse",
    group: "issued",
    sources: [
      {
        table: "lakehouse_share_tokens",
        filters: [{ column: "revoked_at", op: "is_null" }],
        expiresColumn: "expires_at",
      },
    ],
  },
  {
    id: "workflow_triggers",
    label: "Workflow Trigger Tokens",
    description: "Tokens that start one of your workflows over HTTP.",
    icon: Workflow,
    route: "/workflows",
    group: "issued",
    sources: [{ table: "workflows", filters: [{ column: "trigger_token_hash", op: "not_null" }] }],
  },
  {
    id: "etl_triggers",
    label: "ETL Trigger Tokens",
    description: "Tokens that start or feed one of your ETL pipelines over HTTP.",
    icon: Zap,
    route: "/etl",
    group: "issued",
    sources: [
      { table: "etl_pipelines", filters: [{ column: "trigger_token_hash", op: "not_null" }] },
    ],
  },
  {
    id: "scim_tokens",
    label: "SCIM Provisioning Tokens",
    description: "Tokens your identity provider uses to create and remove users here.",
    icon: UsersRound,
    route: "/admin/iam",
    group: "issued",
    superadminOnly: true,
    sources: [{ table: "iam_scim_tokens", filters: [{ column: "revoked_at", op: "is_null" }] }],
  },
  // ── Credentials for other services ────────────────────────────────────────
  {
    id: "providers",
    label: "LLM Provider Keys",
    description: "OpenAI, Anthropic, Gemini and other model providers — BYOK, per-provider.",
    icon: Cloud,
    route: "/integrations",
    group: "stored",
    // Two stores, by provider: encrypted providers live in provider_credentials,
    // OpenAI-compatible ones in integrations. The panel merges both, so the
    // count must too — counting one table showed "0" over two connected keys.
    sources: [
      { table: "provider_credentials", filters: [ACTIVE] },
      {
        table: "integrations",
        filters: [{ column: "type", op: "eq", value: "llm_provider" }, ACTIVE],
      },
    ],
  },
  {
    id: "secrets",
    label: "Secrets",
    description: "Generic named secrets, referenced as {{secret:NAME}} in connection forms.",
    icon: KeyRound,
    route: "/secrets",
    group: "stored",
    sources: [{ table: "user_secrets" }],
  },
  {
    id: "mcp",
    label: "MCP Server Credentials",
    description: "Auth tokens stored for the external MCP servers you've connected.",
    icon: Plug,
    route: "/mcp",
    group: "stored",
    sources: [
      { table: "mcp_servers", filters: [{ column: "auth_type", op: "neq", value: "none" }] },
    ],
  },
  {
    id: "warehouses",
    label: "Warehouse Connections",
    description: "Logins for the databases and warehouses you query.",
    icon: Database,
    route: "/integrations",
    group: "stored",
    sources: [{ table: "data_warehouse_connections" }],
  },
  {
    id: "catalog_sources",
    label: "Catalog & Storage Sources",
    description: "Access keys for the object stores and databases the Data Catalog crawls.",
    icon: HardDrive,
    route: "/data-sql",
    group: "stored",
    // Sources shared with you are visible too, but those keys are their owner's.
    sources: [{ table: "catalog_sources", filters: [{ column: "user_id", op: "is_self" }] }],
  },
  {
    id: "iceberg",
    label: "Iceberg Catalogs",
    description: "Credentials for the Iceberg REST catalogs mounted in the lakehouse.",
    icon: Layers,
    route: "/lakehouse",
    group: "stored",
    sources: [{ table: "iceberg_catalogs" }],
  },
  {
    id: "saas",
    label: "App Connectors",
    description: "Access to the SaaS apps whose data you sync, such as Salesforce.",
    icon: AppWindow,
    route: "/integrations",
    group: "stored",
    sources: [{ table: "saas_connections" }],
  },
  {
    id: "chat_apps",
    label: "Slack & Teams Apps",
    description: "Signing secrets and bot passwords for the chat apps your agents answer in.",
    icon: MessagesSquare,
    route: "/integrations",
    group: "stored",
    sources: [{ table: "slack_workspaces" }, { table: "teams_bots" }],
  },
  {
    id: "kb_connectors",
    label: "Knowledge Base Connectors",
    description:
      "Credentials the Knowledge Base uses to sync Google Drive, Confluence and similar.",
    icon: BookOpenText,
    route: "/knowledge",
    group: "stored",
    sources: [
      {
        table: "kb_sources",
        // RLS also shows sample sources and ones shared with you; neither is a
        // credential you hold. A website source has no credential at all, yet
        // its column is NOT null -- the save path encrypts an empty object for
        // every connector marked `credentialless` -- so the kind is excluded.
        filters: [
          { column: "user_id", op: "is_self" },
          { column: "credentials", op: "not_null" },
          { column: "kind", op: "neq", value: "web" },
        ],
      },
    ],
  },
  {
    id: "integrations",
    label: "Service Integrations",
    description: "Keys for an upstream LLM gateway, Firecrawl, n8n and notification webhooks.",
    icon: Puzzle,
    route: "/integrations",
    group: "stored",
    sources: [
      {
        table: "integrations",
        filters: [
          { column: "type", op: "in", value: ["llm_gateway", "n8n", "firecrawl", "notification"] },
        ],
      },
      // An agent's own n8n webhook: a capability URL into your n8n. The form
      // saves "" when the switch is on but the box is empty -- not a webhook.
      {
        table: "agents",
        filters: [
          { column: "user_id", op: "is_self" },
          { column: "n8n_webhook_url", op: "not_null" },
          { column: "n8n_webhook_url", op: "neq", value: "" },
        ],
      },
    ],
  },
];

/** One PostgREST filter call, as data — what CategoryCard replays on the query. */
export type QueryOp =
  | { method: "eq" | "neq"; args: [string, string | boolean] }
  | { method: "in"; args: [string, string[]] }
  | { method: "is"; args: [string, null] }
  | { method: "not"; args: [string, "is", null] }
  | { method: "or"; args: [string] };

/**
 * The filter calls that count one source's live credentials. Pure, so the
 * rules are tested without a database (tests/unit/apiKeyCategories.test.ts).
 */
export function countOps(source: CountSource, ctx: { userId: string; now: Date }): QueryOp[] {
  const ops: QueryOp[] = [];
  for (const f of source.filters ?? []) {
    switch (f.op) {
      case "eq":
      case "neq":
        ops.push({ method: f.op, args: [f.column, f.value] });
        break;
      case "in":
        ops.push({ method: "in", args: [f.column, f.value] });
        break;
      case "is_null":
        ops.push({ method: "is", args: [f.column, null] });
        break;
      case "not_null":
        ops.push({ method: "not", args: [f.column, "is", null] });
        break;
      case "is_self":
        ops.push({ method: "eq", args: [f.column, ctx.userId] });
        break;
    }
  }
  if (source.expiresColumn) {
    const c = source.expiresColumn;
    // PostgREST reserves , . : ( ) inside or() values, so the timestamp is quoted.
    ops.push({ method: "or", args: [`${c}.is.null,${c}.gt."${ctx.now.toISOString()}"`] });
  }
  return ops;
}

/** Whether any of a category's sources needs the signed-in user's id. */
export function needsUserId(category: ApiKeyCategory): boolean {
  return category.sources.some((s) => (s.filters ?? []).some((f) => f.op === "is_self"));
}

/**
 * Key-bearing tables that are deliberately NOT categories, each with why. The
 * registry test fails on any key-bearing table that is in neither list.
 */
export const EXCLUDED_CREDENTIAL_TABLES: Record<string, string> = {
  // encryption_keys is not here: no column of it reads as a credential to the
  // scan (it holds wrapped key material), so it needs no exclusion — see the
  // header for why it is not a card either.
  swarm_api_keys: "Managed inline at the top of the API Keys settings section, not as a card.",
  notebook_runtime_secrets: "The runtime's own signing secret, minted and rotated by the platform.",
};
