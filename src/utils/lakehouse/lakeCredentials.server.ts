// The lakehouse store's credentials: fixed keys, or the AWS credential chain
// (R465).
//
// Until R465 the lake read LAKEHOUSE_S3_KEY_ID and LAKEHOUSE_S3_SECRET and
// nothing else. On AWS that means an IAM user's long-lived keys in the
// environment, which is what a task role (ECS), IRSA or Pod Identity (EKS) or
// an instance profile exists to avoid. Now, with no keys set, an AWS store is
// reached as the app's own AWS identity: the chain in utils/aws/credentials
// (the one AWS KMS already uses), whose credentials are temporary and carry a
// session token.
//
// Which credentials, decided by the environment:
//
//   LAKEHOUSE_S3_KEY_ID + LAKEHOUSE_S3_SECRET  the keys, as before (MinIO, SILO,
//                                              R2, an IAM user on AWS)
//   LAKEHOUSE_S3_CREDENTIALS=chain             the AWS chain, for any endpoint
//   neither, and the store is AWS S3           the AWS chain
//   neither, any other store                   no credentials, as before
//
// Setting only one of the two keys, or the keys AND `chain`, is refused: either
// would sign as something the operator did not mean.
//
// Temporary credentials expire. Everything that signs with them asks this
// module first (`lakeCredentials()`): the chain hands back its cached answer
// until five minutes before expiry and fetches new ones after, so a caller
// never holds a credential about to lapse. The engine's DuckDB secret is the
// one long-lived holder; core.server rebuilds it when the stamp changes.
import { createAwsCredentialChain, type AwsCredentialChain } from "@/utils/aws/credentials.server";
import { isAwsEndpoint } from "@/utils/lakehouse/customerKeyFiles";
import { providerFetch } from "@/utils/ssrfGuard.server";

type Env = Record<string, string | undefined>;

export type LakeCredentialMode = "keys" | "chain" | "none";

export type LakeCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials (the chain, or keys an operator gave with one). */
  sessionToken?: string;
  /** Epoch ms, or null for keys that do not expire. */
  expiresAt: number | null;
  mode: LakeCredentialMode;
  /** Where they came from, for logs and the settings card: never a secret. */
  source: string;
};

export class LakeCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LakeCredentialsError";
  }
}

const v = (env: Env, name: string) => (env[name] ?? "").trim();

/** Which credentials the environment selects, without fetching anything. */
export function lakeCredentialMode(env: Env = process.env): LakeCredentialMode {
  const keyId = v(env, "LAKEHOUSE_S3_KEY_ID");
  const secret = v(env, "LAKEHOUSE_S3_SECRET");
  const asked = v(env, "LAKEHOUSE_S3_CREDENTIALS").toLowerCase();
  if (asked && asked !== "chain" && asked !== "keys") {
    throw new LakeCredentialsError(
      `LAKEHOUSE_S3_CREDENTIALS must be "chain" or "keys", not "${asked}"`,
    );
  }
  if (keyId || secret) {
    if (!keyId || !secret) {
      throw new LakeCredentialsError(
        `${keyId ? "LAKEHOUSE_S3_KEY_ID" : "LAKEHOUSE_S3_SECRET"} is set without ` +
          `${keyId ? "LAKEHOUSE_S3_SECRET" : "LAKEHOUSE_S3_KEY_ID"}; set both, or neither to use ` +
          `the AWS credential chain`,
      );
    }
    if (asked === "chain") {
      throw new LakeCredentialsError(
        "LAKEHOUSE_S3_CREDENTIALS=chain is set together with LAKEHOUSE_S3_KEY_ID and " +
          "LAKEHOUSE_S3_SECRET; remove the keys to use the chain, or the setting to use the keys",
      );
    }
    return "keys";
  }
  if (asked === "keys") {
    throw new LakeCredentialsError(
      "LAKEHOUSE_S3_CREDENTIALS=keys, but LAKEHOUSE_S3_KEY_ID and LAKEHOUSE_S3_SECRET are not set",
    );
  }
  if (asked === "chain") return "chain";
  const endpoint = v(env, "LAKEHOUSE_S3_ENDPOINT") || undefined;
  return isAwsEndpoint(endpoint) ? "chain" : "none";
}

/** The region the chain's STS calls go to (web identity needs one). */
export function lakeRegion(env: Env = process.env): string {
  return (
    v(env, "LAKEHOUSE_S3_REGION") ||
    v(env, "AWS_REGION") ||
    v(env, "AWS_DEFAULT_REGION") ||
    "us-east-1"
  );
}

export type LakeCredentialResolver = {
  readonly mode: LakeCredentialMode;
  get(): Promise<LakeCredentials>;
};

/** A resolver for one environment. Tests give it their own chain. */
export function createLakeCredentialResolver(args: {
  env?: Env;
  chain?: AwsCredentialChain;
}): LakeCredentialResolver {
  const env = args.env ?? process.env;
  const mode = lakeCredentialMode(env);
  if (mode === "keys" || mode === "none") {
    const creds: LakeCredentials = {
      accessKeyId: v(env, "LAKEHOUSE_S3_KEY_ID"),
      secretAccessKey: v(env, "LAKEHOUSE_S3_SECRET"),
      expiresAt: null,
      mode,
      source: mode === "keys" ? "LAKEHOUSE_S3_KEY_ID" : "no credentials",
    };
    return { mode, get: () => Promise.resolve(creds) };
  }
  // The STS exchange (web identity) goes the way the KMS calls go: the
  // provider fetch, with its proxy and SSRF rules. The metadata endpoints are
  // reached directly by the chain itself.
  const chain =
    args.chain ??
    createAwsCredentialChain({
      region: lakeRegion(env),
      env,
      stsFetch: (url, init) => providerFetch(url, init),
    });
  return {
    mode,
    async get() {
      const r = await chain.get();
      return {
        accessKeyId: r.accessKeyId,
        secretAccessKey: r.secretAccessKey,
        ...(r.sessionToken ? { sessionToken: r.sessionToken } : {}),
        expiresAt: r.expiresAt,
        mode,
        source: `AWS ${r.source}: ${r.identity}`,
      };
    },
  };
}

// ── The process's resolver ─────────────────────────────────────────────────

let resolver: LakeCredentialResolver | null = null;
let resolverKey = "";
/** Every secret value this process has handed out, for redaction. */
const seenSecrets = new Set<string>();

function envKey(env: Env): string {
  return [
    "LAKEHOUSE_S3_KEY_ID",
    "LAKEHOUSE_S3_SECRET",
    "LAKEHOUSE_S3_CREDENTIALS",
    "LAKEHOUSE_S3_ENDPOINT",
    "LAKEHOUSE_S3_REGION",
  ]
    .map((n) => v(env, n))
    .join("\u0000");
}

/**
 * The lake's credentials now. Fixed keys come straight back; the chain's are
 * cached until five minutes before they expire. Every signer awaits this
 * rather than keeping a copy.
 */
export async function lakeCredentials(): Promise<LakeCredentials> {
  const key = envKey(process.env);
  if (!resolver || key !== resolverKey) {
    resolver = createLakeCredentialResolver({});
    resolverKey = key;
  }
  const creds = await resolver.get();
  if (creds.secretAccessKey) seenSecrets.add(creds.secretAccessKey);
  if (creds.sessionToken) seenSecrets.add(creds.sessionToken);
  return creds;
}

/**
 * Changes whenever the credentials do: what a holder (the engine's secret)
 * compares to decide it must be rebuilt. Never contains a secret.
 */
export function credentialStamp(c: LakeCredentials): string {
  return `${c.mode}:${c.accessKeyId}:${c.expiresAt ?? "never"}:${c.sessionToken ? c.sessionToken.length : 0}`;
}

/** The lake's secret values this process knows of, for scrubbing error text. */
export function knownLakeSecrets(): string[] {
  const out = new Set(seenSecrets);
  const fixed = (process.env.LAKEHOUSE_S3_SECRET ?? "").trim();
  if (fixed) out.add(fixed);
  return [...out];
}

/** For tests: forget the resolver and what it handed out. */
export function resetLakeCredentialsForTests(): void {
  resolver = null;
  resolverKey = "";
  seenSecrets.clear();
}
