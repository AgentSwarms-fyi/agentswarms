// Verify that a request really came from Slack.
//
// This is the whole security boundary for the inbound Slack integration. The
// endpoint is public — it has to be, Slack calls it — so without this anyone
// who learns the URL can POST a slash command claiming to be any user in the
// workspace and read whatever the analyst can read.
//
// Slack signs each request: `v0=` + HMAC-SHA256 of `v0:{timestamp}:{rawBody}`
// under the app's signing secret. Three things have to be right, and each of
// them is a real vulnerability on its own:
//
//   1. The RAW body. Re-serializing JSON changes bytes — key order, spacing,
//      unicode escaping — and the signature is over bytes. A verifier that
//      hashes `JSON.stringify(parsed)` fails valid requests, and the usual
//      "fix" is to stop verifying.
//   2. A TIMING-SAFE compare. `===` on a hex string leaks how many leading
//      characters matched, which is enough to forge one byte at a time.
//   3. A REPLAY WINDOW. A signature stays valid for ever, so a captured
//      request could be replayed indefinitely. Slack's guidance is five
//      minutes.
//
// Everything here fails CLOSED. A missing header, an unparseable timestamp, a
// secret that was never configured — all rejected. There is no path through
// this file that returns "ok" because something was absent.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_SIGNATURE_VERSION = "v0";

/** Slack's own recommendation, and the value their SDKs use. */
export const SLACK_REPLAY_WINDOW_SECONDS = 60 * 5;

export type SlackVerifyResult =
  | { ok: true }
  /** `reason` is for the server log — never for the HTTP response, which
   *  should say nothing that helps someone probe the endpoint. */
  | { ok: false; reason: string };

/**
 * Verify a Slack request.
 *
 * `rawBody` MUST be the exact bytes received. Read it with `await
 * request.text()` before any parsing, and parse that same string afterwards.
 */
export function verifySlackRequest(args: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string;
  /** Seconds since epoch. A parameter so this is testable and so one request
   *  is judged against one instant. */
  nowSeconds: number;
  replayWindowSeconds?: number;
}): SlackVerifyResult {
  const { rawBody, timestamp, signature, signingSecret, nowSeconds } = args;
  const window = args.replayWindowSeconds ?? SLACK_REPLAY_WINDOW_SECONDS;

  if (!signingSecret) return { ok: false, reason: "No Slack signing secret is configured." };
  if (!timestamp) return { ok: false, reason: "Missing X-Slack-Request-Timestamp." };
  if (!signature) return { ok: false, reason: "Missing X-Slack-Signature." };

  // Number() on "" is 0, and on "abc" is NaN — both must be rejected, and a
  // bare `!ts` would let 0 through as falsy-but-parsed.
  //
  // NOT trimmed. HTTP parsers strip header whitespace long before this, so a
  // padded value means something unusual happened upstream — and normalising
  // untrusted input before a security comparison is where parser-differential
  // bugs come from. Slack sends digits; anything else is rejected.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || !/^\d+$/.test(timestamp)) {
    return { ok: false, reason: "Timestamp is not an integer." };
  }

  // Absolute difference: a timestamp far in the FUTURE is as suspicious as an
  // old one, and comparing one-sided would accept a request dated next year.
  if (Math.abs(nowSeconds - ts) > window) {
    return { ok: false, reason: `Timestamp is outside the ${window}s replay window.` };
  }

  const expected = `${SLACK_SIGNATURE_VERSION}=${createHmac("sha256", signingSecret)
    .update(`${SLACK_SIGNATURE_VERSION}:${ts}:${rawBody}`)
    .digest("hex")}`;

  // timingSafeEqual throws on a length mismatch, which would itself be a
  // (coarse) oracle and a crash. Compare lengths first, then bytes.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "Signature length mismatch." };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "Signature does not match." };

  return { ok: true };
}

/**
 * Parse a slash-command body (`application/x-www-form-urlencoded`).
 *
 * Verify FIRST, then parse. Parsing before verifying means untrusted input has
 * already been through a decoder on a path that has not yet established the
 * caller is Slack.
 */
export type SlackCommand = {
  command: string;
  text: string;
  teamId: string;
  channelId: string;
  userId: string;
  userName: string;
  /** Where the real answer is posted, since the ack must be immediate. */
  responseUrl: string;
};

export function parseSlashCommand(rawBody: string): SlackCommand | null {
  const p = new URLSearchParams(rawBody);
  const command = p.get("command");
  const responseUrl = p.get("response_url");
  // Without a command there is nothing to run, and without a response_url
  // there is nowhere to put the answer — neither is recoverable.
  if (!command || !responseUrl) return null;
  return {
    command,
    text: (p.get("text") ?? "").trim(),
    teamId: p.get("team_id") ?? "",
    channelId: p.get("channel_id") ?? "",
    userId: p.get("user_id") ?? "",
    userName: p.get("user_name") ?? "",
    responseUrl,
  };
}

/**
 * Slack only accepts `response_url` posts to its own domain.
 *
 * The URL arrives in the request body. Verified or not, posting to whatever it
 * says would turn this endpoint into an open relay the moment the signing
 * secret leaked — so the destination is checked against Slack's host too.
 */
export function isSlackResponseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname === "hooks.slack.com" || u.hostname.endsWith(".slack.com"))
    );
  } catch {
    return false;
  }
}
