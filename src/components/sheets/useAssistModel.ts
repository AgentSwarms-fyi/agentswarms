// The model the Sheets assistant and Fill with AI run on, as the person
// picked it in the panel (R158): remembered in this browser, or none for the
// admin's default. The admin's model is read once, to name the default.

import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { fetchConnectedIntegrations } from "@/components/bi/biModelPref";
import { isModelAllowedByRules, useMyModelRules } from "@/hooks/use-iam";
import { parseModelChoice } from "@/utils/providers/modelChoice";
import { sheetsAssistDefaults } from "@/utils/sheetsAssist.functions";

const KEY = "agentswarms.sheets_assist_model";

/**
 * The pick, remembered in this browser. A pick that is no longer the
 * person's to use (its provider disconnected, or an IAM model rule now
 * refusing it) goes back to the default, and says so, rather than naming a
 * model every question would be refused on.
 */
export function useAssistModel(): [string | null, (m: string | null) => void] {
  const [model, setModel] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(KEY) || null;
    } catch {
      return null;
    }
  });
  const update = (m: string | null) => {
    setModel(m);
    try {
      if (m) window.localStorage.setItem(KEY, m);
      else window.localStorage.removeItem(KEY);
    } catch {
      /* private mode: the pick lasts this session */
    }
  };
  const rules = useMyModelRules();
  useEffect(() => {
    const p = parseModelChoice(model);
    if (!p) return;
    const drop = () => {
      update(null);
      toast.info(
        `The assistant's model you picked (${p.provider}/${p.model}) is not available to you now; it uses the default.`,
      );
    };
    if (rules && !isModelAllowedByRules(rules, p.provider, p.model)) return drop();
    let cancelled = false;
    fetchConnectedIntegrations()
      .then((list) => {
        if (!cancelled && !list.some((i) => i.provider === p.provider)) drop();
      })
      .catch(() => {
        /* could not find out: keep the pick; the server still refuses a bad one */
      });
    return () => {
      cancelled = true;
    };
  }, [model, rules]);
  return [model, update];
}

let defaultCache: string | null = null;

/** The admin's model (SHEETS_ASSIST_MODEL), for "Default (…)". */
export function useAssistDefault(token: string | undefined): string | null {
  const fn = useServerFn(sheetsAssistDefaults);
  const [model, setModel] = useState<string | null>(defaultCache);
  useEffect(() => {
    if (defaultCache || !token) return;
    let cancelled = false;
    fn({ data: { access_token: token } })
      .then((r) => {
        if (!r.ok || cancelled) return;
        defaultCache = r.model;
        setModel(r.model);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fn, token]);
  return model;
}
