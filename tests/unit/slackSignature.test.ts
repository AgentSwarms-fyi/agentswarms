// Verifying that a request really came from Slack.
//
// This is the entire security boundary for the inbound integration: the
// endpoint is public because Slack has to call it, so a verifier that can be
// talked past lets anyone who learns the URL ask the analyst anything, as
// anyone.
//
// So these tests are mostly attacks. Each one is a way a plausible
// implementation gets it wrong.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  SLACK_REPLAY_WINDOW_SECONDS,
  isSlackResponseUrl,
  parseSlashCommand,
  verifySlackRequest,
} from "@/utils/slack/signature.server";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = 1_755_000_000;
const BODY = "command=%2Fask&text=what+is+revenue&response_url=https%3A%2F%2Fhooks.slack.com%2Fx";

const sign = (body: string, ts: number, secret = SECRET) =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

const verify = (over: Partial<Parameters<typeof verifySlackRequest>[0]> = {}) =>
  verifySlackRequest({
    rawBody: BODY,
    timestamp: String(NOW),
    signature: sign(BODY, NOW),
    signingSecret: SECRET,
    nowSeconds: NOW,
    ...over,
  });

describe("a genuine Slack request", () => {
  it("passes", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("passes at the edge of the replay window", () => {
    expect(verify({ nowSeconds: NOW + SLACK_REPLAY_WINDOW_SECONDS })).toEqual({ ok: true });
  });
});

describe("forgery", () => {
  it("rejects a signature made with a different secret", () => {
    expect(verify({ signature: sign(BODY, NOW, "wrong-secret") }).ok).toBe(false);
  });

  it("rejects a body that changed after signing", () => {
    // The whole point: the signature covers the bytes, so tampering with the
    // question must invalidate it.
    expect(verify({ rawBody: BODY.replace("revenue", "salaries") }).ok).toBe(false);
  });

  it("rejects a timestamp that changed after signing", () => {
    // Moving the timestamp forward is how a captured request is kept alive;
    // the timestamp is inside the signed string, so it cannot be.
    expect(verify({ timestamp: String(NOW + 10) }).ok).toBe(false);
  });

  it("rejects a signature of the right length but wrong content", () => {
    const real = sign(BODY, NOW);
    const flipped = real.slice(0, -1) + (real.endsWith("a") ? "b" : "a");
    expect(verify({ signature: flipped }).ok).toBe(false);
  });
});

describe("replay", () => {
  it("rejects a request older than the window", () => {
    // A signature never expires on its own. Without this, one captured request
    // works for ever.
    const r = verify({ nowSeconds: NOW + SLACK_REPLAY_WINDOW_SECONDS + 1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/replay window/);
  });

  it("rejects a request dated in the FUTURE by more than the window", () => {
    // A one-sided check (now - ts > window) accepts a request dated next year.
    const r = verify({ nowSeconds: NOW - SLACK_REPLAY_WINDOW_SECONDS - 1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/replay window/);
  });
});

describe("it fails closed", () => {
  it("rejects a missing timestamp header", () => {
    expect(verify({ timestamp: null }).ok).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verify({ signature: null }).ok).toBe(false);
  });

  it("rejects when no signing secret is configured, even against a matching forgery", () => {
    // The dangerous default: an unconfigured integration that accepts
    // everything because there is nothing to compare against.
    //
    // SIGNED WITH THE EMPTY SECRET. Asserting only that a
    // SECRET-signed request fails passes for the wrong reason — the HMAC
    // simply differs — and a mutation removing the guard survived it. An
    // attacker who knows the workspace is unconfigured computes
    // HMAC("", ...) and is let straight in.
    expect(verify({ signingSecret: "", signature: sign(BODY, NOW, "") }).ok).toBe(false);
    expect(verify({ signingSecret: "" }).ok).toBe(false);
  });

  it("rejects a non-numeric timestamp instead of coercing it", () => {
    expect(verify({ timestamp: "abc" }).ok).toBe(false);
    expect(verify({ timestamp: "" }).ok).toBe(false);
    // Number("  12  ") is 12; the string must be digits, not merely numeric.
    expect(verify({ timestamp: " 1755000000 " }).ok).toBe(false);
  });

  it("rejects an empty signature without throwing", () => {
    // timingSafeEqual throws on a length mismatch — a crash here would be a
    // 500 on every malformed probe, and a coarse oracle.
    expect(() => verify({ signature: "" })).not.toThrow();
    expect(verify({ signature: "" }).ok).toBe(false);
  });
});

describe("the raw body is what is signed", () => {
  it("fails when the body was re-serialized rather than passed through", () => {
    // JSON.stringify(JSON.parse(x)) is not x. A verifier that hashes a
    // re-serialized body rejects valid requests, and the usual "fix" for that
    // is to stop verifying.
    const json = '{"a":1, "b":"x"}';
    const sig = sign(json, NOW);
    expect(
      verifySlackRequest({
        rawBody: json,
        timestamp: String(NOW),
        signature: sig,
        signingSecret: SECRET,
        nowSeconds: NOW,
      }).ok,
    ).toBe(true);
    const reserialized = JSON.stringify(JSON.parse(json));
    expect(
      verifySlackRequest({
        rawBody: reserialized,
        timestamp: String(NOW),
        signature: sig,
        signingSecret: SECRET,
        nowSeconds: NOW,
      }).ok,
    ).toBe(false);
  });
});

describe("parsing a slash command", () => {
  it("reads the fields the handler needs", () => {
    const c = parseSlashCommand(
      "command=%2Fask&text=monthly+revenue&team_id=T1&channel_id=C1&user_id=U1&user_name=ana&response_url=https%3A%2F%2Fhooks.slack.com%2Fa%2Fb",
    );
    expect(c).toMatchObject({
      command: "/ask",
      text: "monthly revenue",
      teamId: "T1",
      userName: "ana",
      responseUrl: "https://hooks.slack.com/a/b",
    });
  });

  it("returns null without a response_url, since there is nowhere to answer", () => {
    expect(parseSlashCommand("command=%2Fask&text=hi")).toBeNull();
  });

  it("returns null without a command", () => {
    expect(parseSlashCommand("text=hi&response_url=https%3A%2F%2Fhooks.slack.com%2Fa")).toBeNull();
  });

  it("treats an empty question as empty rather than missing", () => {
    const c = parseSlashCommand("command=%2Fask&response_url=https%3A%2F%2Fhooks.slack.com%2Fa");
    expect(c?.text).toBe("");
  });
});

describe("the response_url is not trusted blindly", () => {
  it("accepts Slack's own hosts", () => {
    expect(isSlackResponseUrl("https://hooks.slack.com/commands/T1/1/a")).toBe(true);
    expect(isSlackResponseUrl("https://acme.slack.com/x")).toBe(true);
  });

  it("refuses anywhere else", () => {
    // The URL arrives in the request BODY. Posting to whatever it says would
    // make this an open relay the moment the signing secret leaked.
    expect(isSlackResponseUrl("https://evil.example.com/collect")).toBe(false);
    expect(isSlackResponseUrl("http://hooks.slack.com/x")).toBe(false);
    expect(isSlackResponseUrl("https://hooks.slack.com.evil.com/x")).toBe(false);
    expect(isSlackResponseUrl("not a url")).toBe(false);
  });
});
