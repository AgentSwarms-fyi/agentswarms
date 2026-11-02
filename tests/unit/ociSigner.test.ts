// R437: one OCI request signer (src/utils/oci/signer.ts) for Vault, the
// identity federation and Generative AI, proved against Oracle's own vectors.
//
// The key, the request, the date and the expected Authorization headers are the
// OCI Go SDK's signer tests (github.com/oracle/oci-go-sdk, common/http_signer_test.go,
// UPL 1.0 or Apache 2.0). RSA PKCS#1 v1.5 is deterministic: an equal signature
// means the signing string was byte-identical to the SDK's, so the header order,
// the request target with its query and the body hash are all as OCI expects.
import { createPrivateKey, createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Agent } from "undici";
import { describe, expect, it } from "vitest";

import { ociKeyFingerprint, signOciRequest } from "@/utils/oci/signer";

const TEST_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIICXgIBAAKBgQDCFENGw33yGihy92pDjZQhl0C36rPJj+CvfSC8+q28hxA161QF
NUd13wuCTUcq0Qd2qsBe/2hFyc2DCJJg0h1L78+6Z4UMR7EOcpfdUE9Hf3m/hs+F
UR45uBJeDK1HSFHD8bHKD6kv8FPGfJTotc+2xjJwoYi+1hqp1fIekaxsyQIDAQAB
AoGBAJR8ZkCUvx5kzv+utdl7T5MnordT1TvoXXJGXK7ZZ+UuvMNUCdN2QPc4sBiA
QWvLw1cSKt5DsKZ8UETpYPy8pPYnnDEz2dDYiaew9+xEpubyeW2oH4Zx71wqBtOK
kqwrXa/pzdpiucRRjk6vE6YY7EBBs/g7uanVpGibOVAEsqH1AkEA7DkjVH28WDUg
f1nqvfn2Kj6CT7nIcE3jGJsZZ7zlZmBmHFDONMLUrXR/Zm3pR5m0tCmBqa5RK95u
412jt1dPIwJBANJT3v8pnkth48bQo/fKel6uEYyboRtA5/uHuHkZ6FQF7OUkGogc
mSJluOdc5t6hI1VsLn0QZEjQZMEOWr+wKSMCQQCC4kXJEsHAve77oP6HtG/IiEn7
kpyUXRNvFsDE0czpJJBvL/aRFUJxuRK91jhjC68sA7NsKMGg5OXb5I5Jj36xAkEA
gIT7aFOYBFwGgQAQkWNKLvySgKbAZRTeLBacpHMuQdl1DfdntvAyqpAZ0lY0RKmW
G6aFKaqQfOXKCyWoUiVknQJAXrlgySFci/2ueKlIE1QqIiLSZ8V8OlpFLRnb1pzI
7U1yQXnTAEFYM560yJlzUpOb1V4cScGd365tiSMvxLOvTA==
-----END RSA PRIVATE KEY-----`;

const KEY_ID =
  "ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f15p2b2m2yt2j6rx32uzr4h25vqstifsfdsq/" +
  "ocid1.user.oc1..aaaaaaaat5nvwcna5j6aqzjcaty5eqbb6qt2jvpkanghtgdaqedqw3rynjq/" +
  "20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34";
const DATE = "Thu, 05 Jan 2014 21:31:40 GMT";
const key = { keyId: KEY_ID, privateKey: createPrivateKey(TEST_KEY) };

const GET_URL =
  "https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances" +
  "?availabilityDomain=Pjwf%3A%20PHX-AD-1&" +
  "compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa" +
  "&displayName=TeamXInstances&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q";
const POST_URL = "https://iaas.us-phoenix-1.oraclecloud.com/20160918/volumeAttachments";
const POST_BODY = `{
    "compartmentId": "ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa",
    "instanceId": "ocid1.instance.oc1.phx.abuw4ljrlsfiqw6vzzxb43vyypt4pkodawglp3wqxjqofakrwvou52gb6s5a",
    "volumeId": "ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q"
}`;

describe("the OCI Go SDK's vectors", () => {
  it("signs its GET: date, (request-target) with the query, host", () => {
    const h = signOciRequest({ method: "GET", url: GET_URL, key, date: DATE });
    expect(h).toEqual({
      date: DATE,
      authorization:
        `Signature version="1",headers="date (request-target) host",keyId="${KEY_ID}",algorithm="rsa-sha256",` +
        `signature="GBas7grhyrhSKHP6AVIj/h5/Vp8bd/peM79H9Wv8kjoaCivujVXlpbKLjMPeDUhxkFIWtTtLBj3sUzaFj34XE6YZAHc9r2DmE4pMwOAy/kiITcZxa1oHPOeRheC0jP2dqbTll8fmTZVwKZOKHYPtrLJIJQHJjNvxFWeHQjMaR7M="`,
    });
  });

  it("signs its POST: the body's length (316, sent by fetch), type and SHA-256 too", () => {
    const h = signOciRequest({ method: "POST", url: POST_URL, key, body: POST_BODY, date: DATE });
    expect(Buffer.byteLength(POST_BODY)).toBe(316);
    expect(h).toEqual({
      date: DATE,
      "content-type": "application/json",
      "x-content-sha256": "V9Z20UJTvkvpJ50flBzKE32+6m2zJjweHpDMX/U4Uy0=",
      authorization:
        `Signature version="1",headers="date (request-target) host content-length content-type x-content-sha256",` +
        `keyId="${KEY_ID}",algorithm="rsa-sha256",` +
        `signature="Mje8vIDPlwIHmD/cTDwRxE7HaAvBg16JnVcsuqaNRim23fFPgQfLoOOxae6WqKb1uPjYEl0qIdazWaBy/Ml8DRhqlocMwoSXv0fbukP8J5N80LCmzT/FFBvIvTB91XuXI3hYfP9Zt1l7S6ieVadHUfqBedWH0itrtPJBgKmrWso="`,
    });
  });
});

describe("beyond the vectors", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const verifies = (signing: string, auth: string) =>
    createVerify("RSA-SHA256")
      .update(signing)
      .verify(publicKey, /signature="([^"]+)"/.exec(auth)![1], "base64");

  it("a POST with no body still signs the body headers, as OCI requires: length 0", () => {
    const h = signOciRequest({
      method: "POST",
      url: "https://kms.example.test/20180608/keys/x/actions/disable",
      key: { keyId: "k", privateKey },
      date: DATE,
    });
    expect(h["x-content-sha256"]).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    expect(
      verifies(
        `date: ${DATE}\n(request-target): post /20180608/keys/x/actions/disable\nhost: kms.example.test\n` +
          `content-length: 0\ncontent-type: application/json\nx-content-sha256: 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=`,
        h.authorization,
      ),
    ).toBe(true);
  });

  it("signs the host fetch sends: a port only when it is not the default", () => {
    const at = (url: string) =>
      signOciRequest({ method: "GET", url, key: { keyId: "k", privateKey }, date: DATE });
    const sig = (host: string) => `date: ${DATE}\n(request-target): get /x\nhost: ${host}`;
    expect(
      verifies(sig("vault.example.test"), at("https://vault.example.test:443/x").authorization),
    ).toBe(true);
    expect(
      verifies(sig("r437-floci-oci:4599"), at("http://r437-floci-oci:4599/x").authorization),
    ).toBe(true);
    // fetch sets Host itself; a host header from here would be dropped or doubled.
    expect(at("https://vault.example.test/x")).not.toHaveProperty("host");
  });

  // FOUND BY THE EMULATOR TEST: Node's fetch refused a content-length given as
  // a header whenever an undici dispatcher carried the request, and
  // providerFetch always gives it one. Sent for real, through one, to a local
  // server: the request goes, and what arrives verifies, length included.
  it("its headers go through an undici dispatcher, and what arrives verifies", async () => {
    const seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers as Record<string, string>,
        });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const dispatcher = new Agent();
    try {
      for (const body of [JSON.stringify({ keyId: "k", plaintext: "AAAA" }), undefined]) {
        const url = `http://127.0.0.1:${port}/20180608/encrypt`;
        const headers = signOciRequest({
          method: "POST",
          url,
          key: { keyId: "k", privateKey },
          body,
        });
        const res = await fetch(url, { method: "POST", headers, body, dispatcher } as RequestInit);
        expect(res.status).toBe(200);
        const got = seen.at(-1)!;
        expect(got.headers["content-length"]).toBe(String(Buffer.byteLength(body ?? "")));
        const names = /headers="([^"]+)"/.exec(got.headers.authorization)![1].split(" ");
        const signing = names
          .map((n) =>
            n === "(request-target)"
              ? `(request-target): ${got.method.toLowerCase()} ${got.url}`
              : `${n}: ${got.headers[n]}`,
          )
          .join("\n");
        expect(verifies(signing, got.headers.authorization)).toBe(true);
      }
    } finally {
      await dispatcher.close();
      server.close();
    }
  });

  it("an API key's fingerprint is what OCI and openssl show for it", () => {
    // openssl rsa -pubout -outform DER -in key.pem | openssl md5 -c, as Oracle's docs give it.
    expect(ociKeyFingerprint(createPrivateKey(TEST_KEY))).toBe(
      "73:61:a2:21:67:e0:df:be:7e:4b:93:1e:15:98:a5:b7",
    );
    expect(ociKeyFingerprint(createPublicKey(TEST_KEY))).toBe(
      "73:61:a2:21:67:e0:df:be:7e:4b:93:1e:15:98:a5:b7",
    );
  });
});

describe("the Generative AI adapter", () => {
  it("signs with the shared signer, so a PKCS#1 key works as well as PKCS#8", () => {
    const src = readFileSync("src/utils/providers/adapters/oci.server.ts", "utf8");
    expect(src).toContain('import { signOciRequest } from "@/utils/oci/signer";');
    expect(src).toContain(
      'signOciRequest({ method: "POST", url, body, key: { keyId, privateKey } })',
    );
    expect(src).not.toMatch(/crypto\.subtle|buildSignedHeaders/);
  });
});
