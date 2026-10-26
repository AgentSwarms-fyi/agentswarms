// Every credential/key store in the app, besides swarm_api_keys (which
// ApiKeysSettingsPanel manages inline directly — Settings is its only home).
// Each category here gets a live-count card whose "Manage" button opens the
// exact same panel component its dedicated page renders, in a Dialog, so
// Settings offers real inline create/edit/revoke controls rather than a
// link out. One list, so "every type of API key in the app" actually means
// every one of them, not whichever the last person remembered to add.
//
// Deliberately excludes encryption_keys (supabase/migrations/
// 20260888000000_encryption_keys.sql): that table is the platform's own
// envelope-encryption config (which KMS wraps the data-encryption key) — an
// operator/deployment concern, not a credential any individual user holds.
import type { LucideIcon } from "lucide-react";
import { Boxes, Cloud, KeyRound, Code2, Plug, Server } from "lucide-react";

export type ApiKeyCategoryId = "providers" | "gateway" | "ml" | "secrets" | "embeds" | "mcp";

export type ApiKeyCategory = {
  id: ApiKeyCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Where this category's dedicated full page lives (still useful as a
   * "open as a page" escape hatch from inside its Settings dialog). */
  route: string;
  /** Table this category's live count is read from (RLS already scopes it
   * to the caller, same as every other direct-query table in this app). */
  table: string;
  /** Narrows the count to rows that represent an active credential — e.g.
   * skip revoked keys, or MCP servers with no auth configured at all. Kept
   * as plain data (column/operator/value), not a query-builder callback, so
   * it stays trivially typeable instead of fighting Supabase's generics. */
  filter?: { column: string; op: "eq" | "neq"; value: string | boolean };
};

export const API_KEY_CATEGORIES: ApiKeyCategory[] = [
  {
    id: "providers",
    label: "LLM Provider Keys",
    description: "OpenAI, Anthropic, Gemini and other model providers — BYOK, per-provider.",
    icon: Cloud,
    route: "/integrations",
    table: "provider_credentials",
    filter: { column: "is_active", op: "eq", value: true },
  },
  {
    id: "gateway",
    label: "LLM Gateway Keys",
    description: "Keys for calling into this instance's own LLM gateway from outside it.",
    icon: Server,
    route: "/integrations",
    table: "gateway_keys",
    filter: { column: "is_active", op: "eq", value: true },
  },
  {
    id: "ml",
    label: "ML Model API Keys",
    description: "Serve predictions from a trained model you've published.",
    icon: Boxes,
    route: "/ml",
    table: "ml_api_keys",
    filter: { column: "is_active", op: "eq", value: true },
  },
  {
    id: "secrets",
    label: "Secrets",
    description: "Generic named secrets, referenced as {{secret:NAME}} in connection forms.",
    icon: KeyRound,
    route: "/secrets",
    table: "user_secrets",
  },
  {
    id: "embeds",
    label: "Web Embed Keys",
    description: "Capability tokens that authorize an agent, swarm or dashboard iframe embed.",
    icon: Code2,
    route: "/embeds",
    table: "embed_keys",
    filter: { column: "is_active", op: "eq", value: true },
  },
  {
    id: "mcp",
    label: "MCP Server Credentials",
    description: "Auth tokens stored for the external MCP servers you've connected.",
    icon: Plug,
    route: "/mcp",
    table: "mcp_servers",
    filter: { column: "auth_type", op: "neq", value: "none" },
  },
];
