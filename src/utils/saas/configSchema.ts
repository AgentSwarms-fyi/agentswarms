// The shape a SaaS config must have, per provider.
//
// Its own module rather than a const inside saas.functions.ts so that it can
// be TESTED: that file reaches for crypto, audit and a service-role Supabase
// client the moment it is imported, and the thing worth testing here is
// whether every provider the app offers is actually accepted.

import { z } from "zod";

import { SAAS_CARDS } from "./catalog";
import { SAAS_PROVIDERS } from "./types";
import type { SaasConfig, SaasProvider } from "./types";

/**
 * What a config must contain, per provider — built from the card table rather
 * than written out here.
 *
 * FOUND FROM THE UI. The hand-written version listed five providers while the
 * app offered seventeen, so twelve connectors showed a form, took a key, and
 * were refused at this boundary with "Invalid discriminator value" naming
 * five providers the person had not picked. It had been wrong since the sixth
 * connector shipped. Generating the union over SAAS_PROVIDERS means a
 * provider that exists cannot be absent from it.
 */
const configMember = <P extends SaasProvider>(provider: P) =>
  z.object({
    provider: z.literal(provider),
    ...Object.fromEntries(
      SAAS_CARDS[provider].fields.map((f) => [
        f.key,
        // Optional means blank is allowed. The form posts every field it
        // renders, so this is about the VALUE, not the key being absent.
        f.optional ? z.string().optional() : z.string().min(1),
      ]),
    ),
  });

const CONFIG_MEMBERS = SAAS_PROVIDERS.map((p) => configMember(p));
export const SaasConfigSchema = z
  .discriminatedUnion("provider", [CONFIG_MEMBERS[0]!, ...CONFIG_MEMBERS.slice(1)])
  // A generated union infers as `{ provider: SaasProvider }` — the field
  // shapes are built at runtime, so the compiler cannot see them. The cast is
  // the one place that gap is bridged, and it is sound because the catalog
  // types every field key against that provider's own SaasConfig variant: a
  // key SaasConfig does not have will not compile there.
  .transform((c) => c as SaasConfig);
