// An app source's config as used (R494).
//
// The credential fields of a saved source (src/utils/saas/catalog.ts, marked
// `secret`) hold a `{{secret:NAME}}` picked from the owner's secrets, or a key
// typed in before. Every path that hands a config to a connector — a sync, a
// scheduled sync, the health check, a reverse-ETL write, the Connect form's
// discovery — passes it through here first. A reference resolves for the
// source's owner; a secret shared with the owner resolves only where its owner
// allowed every host the source sends credentials to (./origins.ts). The
// settings (instance, site URL…) decide those hosts, so a reference there
// resolves only from the owner's own secrets.
import { resolveCredentialConfig } from "@/utils/secrets.server";
import { saasSecretFields } from "./catalog";
import { saasCredentialHosts } from "./origins";
import type { SaasConfig } from "./types";

export async function resolveSaasConfig<T extends SaasConfig>(
  ownerUserId: string,
  cfg: T,
): Promise<T> {
  return resolveCredentialConfig(ownerUserId, cfg, saasSecretFields(cfg.provider), (resolved) =>
    saasCredentialHosts(resolved),
  );
}
