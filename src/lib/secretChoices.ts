// Which secrets a field may offer, and what to say about each (R493).
//
// The server's rules, read where the picker can apply them before a run does:
//   - a secret the caller OWNS resolves wherever it is used;
//   - a secret SHARED with them resolves only where the call names its
//     destination, and only when its owner allowed every one of those hosts
//     (src/utils/secrets.server.ts, R419);
//   - a few sinks name no destination at all (a sandbox's environment, a
//     webhook URL) and so take only the caller's own.
// A field that offered a secret the run would then refuse would be a picker
// that lies, so an owned-only field lists owned secrets only, and a shared
// secret is shown with where its owner lets it go.
//
// PURE: no server or React imports.
import { hostAllowed, hostOf, sharedUseNote } from "./secretHosts";

/** The fields of a listed secret this module reads (a SecretSummary). */
export type SecretListing = {
  id: string;
  name: string;
  description?: string | null;
  user_id: string;
  allowed_hosts?: readonly string[] | null;
  owner_email?: string | null;
};

/** Whether the caller owns this secret. */
export const ownsSecret = (s: Pick<SecretListing, "user_id">, me: string | null | undefined) =>
  !!me && s.user_id === me;

/**
 * The secrets a field may offer: every one the caller can use, or only their
 * own where the resolver takes nothing else. Before the listing has said who
 * the caller is, an owned-only field offers nothing rather than guessing.
 */
export function usableSecrets<T extends SecretListing>(
  secrets: readonly T[],
  me: string | null | undefined,
  opts: { ownedOnly?: boolean } = {},
): T[] {
  if (!opts.ownedOnly) return [...secrets];
  return secrets.filter((s) => ownsSecret(s, me));
}

/** The hosts of a field's destinations, or null when any one cannot be read as a host. */
export function destinationHosts(
  destinations: readonly string[] | null | undefined,
): string[] | null {
  const list = (destinations ?? []).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return null;
  const hosts = list.map((s) => hostOf(s));
  if (hosts.some((h) => h === null)) return null;
  return [...new Set(hosts as string[])];
}

export type SharedSecretProblem =
  /** The field's destination is not known yet (blank, or a template), so the server would refuse a shared secret. */
  | { kind: "no-destination" }
  /** Its owner has not allowed these hosts. */
  | { kind: "host-not-allowed"; hosts: string[]; allowed: string[] };

/**
 * Why a run would refuse this secret here, or null when it would resolve.
 * An owned secret always resolves. A shared one needs every destination host
 * on its owner's list.
 */
export function sharedSecretProblem(
  secret: SecretListing,
  me: string | null | undefined,
  destinations: readonly string[] | null | undefined,
): SharedSecretProblem | null {
  if (ownsSecret(secret, me)) return null;
  const hosts = destinationHosts(destinations);
  if (!hosts) return { kind: "no-destination" };
  const allowed = [...(secret.allowed_hosts ?? [])];
  const refused = hosts.filter((h) => !hostAllowed(h, allowed));
  return refused.length ? { kind: "host-not-allowed", hosts: refused, allowed } : null;
}

/** The problem in a sentence, naming the secret. */
export function sharedSecretProblemText(name: string, problem: SharedSecretProblem): string {
  if (problem.kind === "no-destination") {
    return (
      `${name} is shared with you, and a shared secret is only sent to hosts its owner ` +
      `allowed. This field's destination is not set yet, so it cannot be checked.`
    );
  }
  const where =
    problem.allowed.length > 0
      ? `its owner allows only ${problem.allowed.join(", ")}`
      : "its owner has not allowed any host yet";
  return (
    `${name} is shared with you, but ${where}, and this field sends it to ` +
    `${problem.hosts.join(", ")}. The run will refuse it until its owner adds that host ` +
    `(Secrets → ${name} → Allowed hosts).`
  );
}

/** Who owns a shared secret and where it may go, for its row in a picker. */
export function sharedSecretNote(secret: SecretListing): string {
  const by = secret.owner_email ? `Shared by ${secret.owner_email}` : "Shared with you";
  return `${by} · ${sharedUseNote(secret.allowed_hosts ?? [])}`;
}
