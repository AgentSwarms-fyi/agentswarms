// OCI request signing, version 1: draft-cavage-http-signatures-08 with
// RSA-SHA256, as every Oracle Cloud API takes it
// (https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm).
// One signer for every OCI call the app makes as itself or for a user: Vault
// (kms/oci.server), the identity federation that turns an instance's
// certificate into a session token (oci/credentials.server), and Generative AI
// (providers/adapters/oci). Proved against the OCI Go SDK's own test vectors
// (tests/unit/ociSigner.test.ts): RSA PKCS#1 v1.5 is deterministic, so an equal
// signature means a byte-identical signing string.
//
// Signed, in this order (the Go SDK's): date, (request-target), host; and for
// a request with a body, content-length, content-type and x-content-sha256.
// OCI requires the body headers on every POST and PUT, even with an empty
// body. The host is the one fetch sends: URL.host, the port only when it is
// not the scheme's default.
//
// Host and content-length are signed but not returned: fetch sets both, the
// length from the body (0 for a POST or PUT without one, as the Fetch standard
// says). FOUND BY THE EMULATOR TEST (R437): a content-length given as a header
// as well made Node's fetch refuse the request ("invalid content-length
// header") whenever it ran through an undici dispatcher, which providerFetch
// always gives it, so the Generative AI adapter's signed POSTs, which set it
// by hand, could not have been sent.
import { createHash, createPublicKey, createSign, type KeyObject } from "node:crypto";

export type OciSigningKey = {
  /**
   * `<tenancy OCID>/<user OCID>/<fingerprint>` for an API key,
   * `ST$<token>` for a session token (instance or resource principal),
   * `<tenancy OCID>/fed-x509-sha256/<fingerprint>` for the federation call.
   */
  keyId: string;
  privateKey: KeyObject;
};

const GENERIC = ["date", "(request-target)", "host"] as const;
const BODY = ["content-length", "content-type", "x-content-sha256"] as const;

/**
 * The headers that sign one request. `date` is now unless given (tests); OCI
 * refuses a date more than five minutes from its own clock.
 */
export function signOciRequest(args: {
  method: string;
  url: string | URL;
  key: OciSigningKey;
  /** The exact string that will be sent, as fetch's body. Its presence decides the body headers. */
  body?: string;
  contentType?: string;
  date?: string;
}): Record<string, string> {
  const url = typeof args.url === "string" ? new URL(args.url) : args.url;
  const method = args.method.toLowerCase();
  const withBody = args.body !== undefined || method === "post" || method === "put";
  const headers: Record<string, string> = {
    date: args.date ?? new Date().toUTCString(),
    host: url.host,
  };
  if (withBody) {
    const body = args.body ?? "";
    headers["content-length"] = String(Buffer.byteLength(body));
    headers["content-type"] = args.contentType ?? "application/json";
    headers["x-content-sha256"] = createHash("sha256").update(body).digest("base64");
  }
  const names = withBody ? [...GENERIC, ...BODY] : [...GENERIC];
  const signingString = names
    .map((n) =>
      n === "(request-target)"
        ? `(request-target): ${method} ${url.pathname}${url.search}`
        : `${n}: ${headers[n]}`,
    )
    .join("\n");
  const signature = createSign("RSA-SHA256")
    .update(signingString)
    .sign(args.key.privateKey, "base64");
  const { host: _host, "content-length": _length, ...out } = headers;
  return {
    ...out,
    // The Go SDK's order, so a header compares equal to its tests'.
    authorization:
      `Signature version="1",headers="${names.join(" ")}",keyId="${args.key.keyId}",` +
      `algorithm="rsa-sha256",signature="${signature}"`,
  };
}

/**
 * An API key's fingerprint as OCI shows it: the MD5 of the DER public key,
 * colon-separated (`openssl rsa -pubout -outform DER | openssl md5 -c`).
 */
export function ociKeyFingerprint(key: KeyObject): string {
  const pub = key.type === "public" ? key : createPublicKey(key);
  const der = pub.export({ type: "spki", format: "der" });
  return createHash("md5").update(der).digest("hex").match(/../g)!.join(":");
}
