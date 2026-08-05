// Default-deny model access, and the audit finding behind it.
//
// The IAM audit of resource access (knowledge bases, datasets, secrets,
// dashboards, agents, connections) found it already deny-by-default: owner-only
// RLS everywhere, IAM grants strictly ADDITIVE read-only SELECT policies, and
// every headless path mirroring the grants explicitly. The one genuine
// "explicit allow when no rules are set" was MODEL access: zero applicable
// iam_model_rules collapsed to null = unrestricted, by design.
//
// model_access_default makes that a policy choice. 'allow' preserves the
// historical behaviour byte-for-byte (and is the migration default, so
// applying it changes nothing); 'deny' means a user with no rules can call
// NOTHING until an admin allow-lists them — except superadmins, who administer
// the lists and therefore cannot be locked out by them.
//
// collapseModelPolicy is the single shared rule (server loader + browser
// hook), and it feeds isModelAllowed's existing fail-closed contract:
// null = unrestricted, [] = deny everything.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { collapseModelPolicy, isModelAllowed } from "@/lib/iamRules";

const IAM_SERVER = readFileSync("src/utils/iam.server.ts", "utf8");
const USE_IAM = readFileSync("src/hooks/use-iam.ts", "utf8");
const EMBED_CHAT = readFileSync("src/routes/api/embed.chat.ts", "utf8");
const IAM_FUNCTIONS = readFileSync("src/utils/iam.functions.ts", "utf8");
const ADMIN_UI = readFileSync("src/routes/_authenticated/admin.iam.tsx", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/20260784000000_iam_model_default_deny.sql",
  "utf8",
);

const RULE = { provider: "openrouter", model_pattern: "openai/*" };

describe("allow mode is the historical behaviour, byte for byte", () => {
  it("no applicable rules → null (unrestricted)", () => {
    expect(collapseModelPolicy({ mode: "allow", isSuperadmin: false, applicable: [] })).toBeNull();
  });

  it("rules apply as written — including to superadmins, as they always have", () => {
    expect(collapseModelPolicy({ mode: "allow", isSuperadmin: false, applicable: [RULE] })).toEqual(
      [RULE],
    );
    expect(collapseModelPolicy({ mode: "allow", isSuperadmin: true, applicable: [RULE] })).toEqual([
      RULE,
    ]);
  });
});

describe("deny mode fails closed for everyone but admins", () => {
  it("no applicable rules → [] — and [] genuinely allows nothing", () => {
    const collapsed = collapseModelPolicy({ mode: "deny", isSuperadmin: false, applicable: [] });
    expect(collapsed).toEqual([]);
    // The pairing that makes the sentinel real: isModelAllowed's documented
    // fail-closed contract on the empty list.
    expect(isModelAllowed(collapsed, "openrouter", "openai/gpt-4o-mini")).toBe(false);
    expect(isModelAllowed(collapsed, "anything", "anything")).toBe(false);
  });

  it("rules still grant exactly what they say", () => {
    const collapsed = collapseModelPolicy({
      mode: "deny",
      isSuperadmin: false,
      applicable: [RULE],
    });
    expect(isModelAllowed(collapsed, "openrouter", "openai/gpt-4o-mini")).toBe(true);
    expect(isModelAllowed(collapsed, "openrouter", "anthropic/claude-3")).toBe(false);
  });

  it("superadmins bypass — the lock's administrator cannot be locked out", () => {
    expect(collapseModelPolicy({ mode: "deny", isSuperadmin: true, applicable: [] })).toBeNull();
    expect(
      collapseModelPolicy({ mode: "deny", isSuperadmin: true, applicable: [RULE] }),
    ).toBeNull();
  });
});

describe("one collapse, applied everywhere", () => {
  it("the server loader consults the instance setting and collapses", () => {
    expect(IAM_SERVER).toMatch(/settings\?\.model_access_default === "deny"/);
    expect(IAM_SERVER).toContain("collapseModelPolicy({");
    expect(IAM_SERVER).toMatch(/from\("iam_settings"\)/);
    expect(IAM_SERVER).toMatch(/from\("user_roles"\)/);
  });

  it("the browser hook runs the identical collapse, so pickers match the API", () => {
    expect(USE_IAM).toContain("collapseModelPolicy({");
    expect(USE_IAM).toMatch(/settings\?\.model_access_default === "deny"/);
  });

  it("a missing settings row reads as 'allow' — pre-migration schemas keep working", () => {
    // Both call sites use a ternary that only ever yields 'deny' on the exact
    // string; null/undefined/absent collapse to 'allow'.
    expect(IAM_SERVER).toMatch(/=== "deny" \? \("deny" as const\) : \("allow" as const\)/);
  });
});

describe("the embed gateway is no longer exempt", () => {
  it("embed.chat checks the owner's effective rules before running the model", () => {
    // This was the one LLM gateway with no rules check: it executes the
    // owner's stored model for anonymous strangers, indefinitely.
    expect(EMBED_CHAT).toContain("getEffectiveModelRules(supabaseAdmin, keyRow.user_id)");
    expect(EMBED_CHAT).toMatch(/isModelAllowed\(rules, cfg\.provider, cfg\.model\)/);
  });
});

describe("rollout cannot break an existing instance", () => {
  it("the migration defaults to 'allow' — applying it changes nothing", () => {
    expect(MIGRATION).toMatch(/model_access_default text NOT NULL DEFAULT 'allow'/);
    expect(MIGRATION).toMatch(/CHECK \(model_access_default IN \('allow', 'deny'\)\)/);
  });

  it("flipping to deny is a superadmin action in the admin UI", () => {
    expect(IAM_FUNCTIONS).toMatch(/model_access_default: z\.enum\(\["allow", "deny"\]\)/);
    expect(ADMIN_UI).toContain("Default model access");
    expect(ADMIN_UI).toContain("model_access_default: mode");
  });
});
