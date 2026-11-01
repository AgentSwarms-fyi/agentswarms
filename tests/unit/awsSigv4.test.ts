// The shared SigV4 signer against the AWS Signature Version 4 test suite (the
// copy botocore ships under tests/unit/auth/aws4_testsuite): same credentials,
// time, region and service, and the Authorization header each case publishes.
// A signer that only matches itself proves nothing; these are AWS's answers.
import { describe, expect, it } from "vitest";

import { awsUriEncode, signAwsRequest } from "@/utils/aws/sigv4";

const SUITE = {
  service: "service",
  region: "us-east-1",
  now: new Date("2015-08-30T12:36:00Z"),
  credentials: {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  },
};
const SCOPE = "AKIDEXAMPLE/20150830/us-east-1/service/aws4_request";

// post-sts-token/post-sts-header-before: the token is signed.
const STS_TOKEN =
  "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwA" +
  "eMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8p" +
  "hUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT" +
  "38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabI" +
  "Qwj2ICCR/oLxBA==";

describe("signAwsRequest matches the AWS SigV4 test suite", () => {
  it("get-vanilla", async () => {
    const h = await signAwsRequest({
      ...SUITE,
      method: "GET",
      url: "https://example.amazonaws.com/",
    });
    expect(h.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${SCOPE}, SignedHeaders=host;x-amz-date, ` +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    expect(h).not.toHaveProperty("x-amz-security-token");
  });

  it("get-vanilla-query-order-key-case (the query is sorted)", async () => {
    const h = await signAwsRequest({
      ...SUITE,
      method: "GET",
      url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
    });
    expect(h.authorization).toMatch(
      /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/,
    );
  });

  it("post-x-www-form-urlencoded (a body, and a header that is signed)", async () => {
    const h = await signAwsRequest({
      ...SUITE,
      method: "POST",
      url: "https://example.amazonaws.com/",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "Param1=value1",
    });
    expect(h.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${SCOPE}, SignedHeaders=content-type;host;x-amz-date, ` +
        "Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
    );
    expect(h["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("post-sts-header-before (a session token, signed)", async () => {
    const h = await signAwsRequest({
      ...SUITE,
      credentials: { ...SUITE.credentials, sessionToken: STS_TOKEN },
      method: "POST",
      url: "https://example.amazonaws.com/",
    });
    expect(h.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${SCOPE}, ` +
        "SignedHeaders=host;x-amz-date;x-amz-security-token, " +
        "Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead",
    );
    expect(h["x-amz-security-token"]).toBe(STS_TOKEN);
  });
});

describe("signAwsRequest details the suite does not pin", () => {
  it("signs a non-default port as part of host", async () => {
    const a = await signAwsRequest({ ...SUITE, method: "GET", url: "http://localhost:4566/" });
    const b = await signAwsRequest({ ...SUITE, method: "GET", url: "http://localhost:4567/" });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it("never signs a Host or Authorization header handed in", async () => {
    const plain = await signAwsRequest({
      ...SUITE,
      method: "GET",
      url: "https://example.amazonaws.com/",
    });
    const odd = await signAwsRequest({
      ...SUITE,
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: { Host: "elsewhere.test", Authorization: "x" },
    });
    expect(odd.authorization).toBe(plain.authorization);
  });

  it("encodes the characters encodeURIComponent leaves alone", () => {
    expect(awsUriEncode("a!b'c(d)e*f ~")).toBe("a%21b%27c%28d%29e%2Af%20~");
  });
});
