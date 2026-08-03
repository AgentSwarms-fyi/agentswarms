// Exposing a swarm: minting a key, and the human-approval gate.
//
// These are the controls that decide who can run someone's swarm and whether an
// unattended caller can walk past a step a human was meant to sign off. Nothing
// here was found broken — it is written down so it stays that way, because each
// one fails silently and in the safe-looking direction.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "@/utils/swarmDeploy.functions";
import { generateWebhookSecret } from "@/utils/swarmWebhook.server";

describe("the key hash is what gets stored", () => {
  it("is a stable 64-character hex digest", async () => {
    const h = await sha256Hex("sk_swarm_deadbeef");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("sk_swarm_deadbeef")).toBe(h);
  });

  it("changes completely for a one-character difference", async () => {
    const a = await sha256Hex("sk_swarm_aaaa");
    const b = await sha256Hex("sk_swarm_aaab");
    expect(a).not.toBe(b);
    // Not a prefix relationship — a truncated compare must not match.
    expect(a.startsWith(b.slice(0, 16))).toBe(false);
  });

  it("does not contain the input", async () => {
    expect(await sha256Hex("sk_swarm_secret")).not.toContain("secret");
  });
});

describe("secrets are generated, not derived from anything guessable", () => {
  it("mints a distinct webhook secret every time", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateWebhookSecret()));
    expect(seen.size).toBe(200);
  });

  it("carries enough entropy to be unguessable", () => {
    // 24 random bytes as hex = 48 characters after the prefix. Anything much
    // shorter would be brute-forceable against a signature check.
    const s = generateWebhookSecret();
    expect(s).toMatch(/^whsec_[0-9a-f]{48}$/);
  });

  it("uses the CSPRNG rather than Math.random", () => {
    const src = readFileSync("src/utils/swarmWebhook.server.ts", "utf8");
    const fn = src.slice(src.indexOf("export function generateWebhookSecret"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("crypto.getRandomValues");
    expect(body).not.toContain("Math.random");
  });
});

describe("minting a key is owner-only", () => {
  const src = readFileSync("src/utils/swarmDeploy.functions.ts", "utf8");

  it("stores only the hash and a display prefix, never the key", () => {
    expect(src).toContain("key_hash");
    expect(src, "the raw key is persisted").not.toMatch(/raw_key:\s*raw[,\s]*\n\s*key_hash/);
    expect(src).toContain("const key_prefix = raw.slice(0, 16)");
  });

  it("checks the swarm belongs to the caller before minting", () => {
    const create = src.slice(src.indexOf("const userId = await userFromToken"));
    expect(create).toMatch(/swarm\.user_id !== userId/);
  });

  it("checks a rotation source belongs to the caller AND the same swarm", () => {
    // Without the second half, `rotated_from` could point at another swarm's
    // key row — the file says so itself.
    expect(src).toMatch(/prev\.user_id !== userId \|\| prev\.swarm_id !== data\.swarm_id/);
  });

  it("defaults an unattended key to refusing approval steps", () => {
    // The safe direction: a headless caller must not walk past a gate a human
    // was meant to decide.
    //
    // A MUTATION SURVIVED HERE. The default was written out twice — once for
    // the insert and once for the audit entry — and String.replace only
    // rewrote the first, so flipping the value the key is actually CREATED
    // with left the audit copy for the assertion to find. Resolved once now,
    // and the test names the variable rather than the literal.
    expect(src).toMatch(/const rejectApprovals = data\.reject_approvals \?\? true;/);
    expect(src, "the insert re-derives its own default").toContain(
      "reject_approvals: rejectApprovals",
    );
  });

  it("audits the policy the key was created with, not a second guess at it", () => {
    // An audit trail that disagrees with the row it describes is worse than
    // none: it is the thing you consult when working out what happened.
    const detail = src.slice(
      src.indexOf("detail: {"),
      src.indexOf("});", src.indexOf("detail: {")),
    );
    expect(detail).toContain("reject_approvals: rejectApprovals");
    expect(detail).toContain("scopes,");
    expect(detail, "the audit entry recomputes a default").not.toMatch(/\?\?/);
  });
});

describe("the human-approval gate cannot be walked past", () => {
  const exec = readFileSync("src/utils/swarmExecute.server.ts", "utf8");
  const gate = exec.slice(exec.indexOf('if (kind === "approval")'));
  const body = gate.slice(0, gate.indexOf('if (kind === "subswarm")'));

  it("stops the run rather than approving itself when nobody is watching", () => {
    // The failure mode this guards against is an unattended run treating
    // "no approver" as "approved".
    expect(body).toMatch(/if \(opts\.rejectApprovals\)[\s\S]{0,400}throw new Error/);
    expect(body, "auto-approves when unattended").not.toMatch(
      /if \(opts\.rejectApprovals\)[\s\S]{0,200}write\(/,
    );
  });

  it("proceeds only on an explicit approval decision", () => {
    expect(body).toMatch(/decision\.approved/);
  });

  it("carries the same policy into nested swarms", () => {
    // A sub-swarm inheriting a laxer policy would be the way around it.
    expect(exec).toContain("rejectApprovals: opts.rejectApprovals");
  });

  it("is refused for public embeds entirely", () => {
    // An anonymous visitor is never an approver, so the embed refuses the
    // swarm up front instead of parking a run nobody can release.
    const embed = readFileSync("src/routes/api/embed.ts", "utf8");
    expect(embed).toMatch(/kind === "approval"/);
    expect(embed).toMatch(/cannot run in an embed/);
  });
});
