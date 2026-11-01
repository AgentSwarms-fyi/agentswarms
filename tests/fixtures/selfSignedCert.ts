// A throwaway self-signed X.509 certificate, made at test time with
// node:crypto and a few lines of DER. No key is committed to the repository,
// and no openssl binary is needed.
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let x = n >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

const utcTime = (d: Date) =>
  tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
const sha256WithRsa = seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));

/** An RSA key and a self-signed certificate for it, both as PEM. */
export function selfSignedCert(cn = "agentswarms-test"): {
  keyPem: string;
  certPem: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, Buffer.from([0x01, 0x23, 0x45])),
    sha256WithRsa,
    name(cn),
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))),
    name(cn),
    publicKey.export({ type: "spki", format: "der" }),
  );
  const sig = createSign("RSA-SHA256").update(tbs).sign(privateKey);
  const der = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.from([0]), sig));
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certPem: `-----BEGIN CERTIFICATE-----\n${b64.trim()}\n-----END CERTIFICATE-----\n`,
    privateKey,
    publicKey,
  };
}
