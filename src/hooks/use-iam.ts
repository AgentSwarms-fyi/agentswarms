// Client-side IAM state: whether the signed-in user is a superadmin, and the
// model rules that apply to them (null = unrestricted).
//
// Reads go through the browser Supabase client under RLS: users can see their
// own user_roles row, their own group memberships, and the model rules that
// apply to them. The VITE_ADMIN_EMAIL check is kept as a bootstrap fallback so
// the admin UI is reachable before the IAM migration has run.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL ?? "").toLowerCase();

export type MyModelRule = { provider: string; model_pattern: string };

type IamState = { isSuperadmin: boolean; modelRules: MyModelRule[] | null };

// Module-level cache: one fetch per signed-in user, shared by all consumers.
let cache: { userId: string; promise: Promise<IamState> } | null = null;

async function loadIamState(userId: string): Promise<IamState> {
  const [{ data: roles }, { data: memberships }, { data: rules }] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", userId),
    supabase.from("iam_group_members").select("group_id").eq("user_id", userId),
    supabase
      .from("iam_model_rules")
      .select("principal_type, principal_id, provider, model_pattern"),
  ]);
  const isSuperadmin = (roles ?? []).some((r) => r.role === "superadmin");
  const groupIds = new Set((memberships ?? []).map((m) => m.group_id));
  // Superadmins can read every rule via RLS, so re-filter to the ones that
  // actually apply to this user.
  const applicable = (rules ?? []).filter(
    (r) =>
      (r.principal_type === "user" && r.principal_id === userId) ||
      (r.principal_type === "group" && groupIds.has(r.principal_id)),
  );
  return {
    isSuperadmin,
    modelRules: applicable.length
      ? applicable.map((r) => ({ provider: r.provider, model_pattern: r.model_pattern }))
      : null,
  };
}

export function invalidateIamState() {
  cache = null;
}

export function useIamState(): IamState & { loading: boolean } {
  const { user } = useAuth();
  const [state, setState] = useState<IamState | null>(null);

  useEffect(() => {
    if (!user?.id) {
      setState(null);
      return;
    }
    let cancelled = false;
    if (!cache || cache.userId !== user.id) {
      cache = {
        userId: user.id,
        promise: loadIamState(user.id).catch(() => ({
          isSuperadmin: false,
          modelRules: null,
        })),
      };
    }
    cache.promise.then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const envAdmin = Boolean(ADMIN_EMAIL) && (user?.email ?? "").toLowerCase() === ADMIN_EMAIL;
  return {
    isSuperadmin: (state?.isSuperadmin ?? false) || envAdmin,
    modelRules: state?.modelRules ?? null,
    loading: state === null && Boolean(user),
  };
}

export function useIsSuperadmin(): boolean {
  return useIamState().isSuperadmin;
}

/** Model rules applying to the current user; null = unrestricted. */
export function useMyModelRules(): MyModelRule[] | null {
  return useIamState().modelRules;
}

/** Client-side mirror of the server-side rule matcher in iam.server.ts. */
export function isModelAllowedByRules(
  rules: MyModelRule[] | null,
  provider: string,
  model: string,
): boolean {
  if (!rules) return true;
  return rules.some((r) => {
    if (r.provider !== provider) return false;
    const p = r.model_pattern;
    if (p === "*" || p === model) return true;
    if (p.endsWith("*")) return model.startsWith(p.slice(0, -1));
    return false;
  });
}

/** Providers that have at least one allowed model for the current rules. */
export function allowedProviders(rules: MyModelRule[] | null): Set<string> | null {
  if (!rules) return null;
  return new Set(rules.map((r) => r.provider));
}

/**
 * Provider-agnostic match: does any rule's pattern cover this model id?
 * Used by catalog pickers where the calling provider isn't known yet.
 */
export function modelMatchesAnyRule(rules: MyModelRule[] | null, model: string): boolean {
  if (!rules) return true;
  return rules.some((r) => {
    const p = r.model_pattern;
    if (p === "*" || p === model) return true;
    if (p.endsWith("*")) return model.startsWith(p.slice(0, -1));
    return false;
  });
}
