// What the INSTANCE provides, as opposed to what this user has connected.
//
// WHY THIS EXISTS. An operator can set one instance-wide OPENROUTER_API_KEY so
// everyone on the deployment can use models without connecting anything —
// that is the documented zero-setup path, and agent chat and swarms already
// honour it. The BI pickers did not: they built their provider list purely
// from the `integrations` and `provider_credentials` tables, so on an instance
// configured that way they reported "Connect a model provider in Integrations"
// while every other surface in the app was happily calling OpenRouter.
//
// The key itself is server-side and must stay there, so the client cannot read
// it — it can only ask whether one exists. That is all this returns: a boolean
// and the default model id, never the key.
import { createServerFn } from "@tanstack/react-start";
import { instanceDefaultModel } from "@/utils/providers/defaultModel.server";

export type InstanceProviderStatus = {
  /** True when the deployment has an instance-wide OpenRouter key set. */
  openrouter: boolean;
  /**
   * The instance default model every surface falls back to (Admin ->
   * Developer runtime -> AI services -> Default model; the built-in one until it is set).
   */
  defaultModel: { provider: string; model: string; spec: string; source: "admin" | "built-in" };
};

/**
 * Deliberately unauthenticated: it discloses only whether the operator
 * configured a key, which the app already reveals by letting anyone call a
 * model. It carries no secret and no per-user data, so gating it behind auth
 * would only mean pickers cannot render before the session resolves.
 */
export const getInstanceProviderStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<InstanceProviderStatus> => {
    const d = await instanceDefaultModel();
    return {
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      defaultModel: { provider: d.provider, model: d.model, spec: d.spec, source: d.source },
    };
  },
);
