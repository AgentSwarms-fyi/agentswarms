// Which secrets a key field offers, and what it says about each (R493).
//
// The ETL pipeline pickers and the MCP builder listed every secret the user
// could see, their own and those shared with them, while their resolvers take
// only the owner's own (a run's environment is readable by the code it runs,
// so a shared secret there could be printed: VA-2026-10-25-28/-29). Picking a
// shared one looked fine and failed at run start. Owned-only fields now offer
// owned secrets only, and a shared secret elsewhere is flagged when its owner
// has not allowed the host the field sends it to — the server's rule, applied
// where it can still be acted on.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  destinationHosts,
  ownsSecret,
  sharedSecretNote,
  sharedSecretProblem,
  sharedSecretProblemText,
  usableSecrets,
} from "@/lib/secretChoices";

const ME = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

const mine = { id: "1", name: "MY_KEY", user_id: ME, allowed_hosts: [] };
const shared = {
  id: "2",
  name: "TEAM_KEY",
  user_id: OTHER,
  allowed_hosts: ["api.openai.com", "*.snowflakecomputing.com"],
  owner_email: "owner@example.test",
};
const sharedNowhere = { id: "3", name: "LOCKED", user_id: OTHER, allowed_hosts: [] };
const ALL = [mine, shared, sharedNowhere];

describe("an owned-only field", () => {
  it("offers only the caller's own secrets", () => {
    expect(usableSecrets(ALL, ME, { ownedOnly: true }).map((s) => s.name)).toEqual(["MY_KEY"]);
  });

  it("offers nothing before the listing has said who the caller is", () => {
    expect(usableSecrets(ALL, null, { ownedOnly: true })).toEqual([]);
    expect(usableSecrets(ALL, undefined, { ownedOnly: true })).toEqual([]);
  });

  it("is what every owned-only resolver's picker asks for", () => {
    // The ETL source pickers, the pipeline's bindings, the MCP builder's bind
    // row and a notification webhook URL resolve owner-only on the server.
    const pickers = readFileSync("src/components/etl/SourcePickers.tsx", "utf8");
    const secretPicker = pickers.slice(pickers.indexOf("export function SecretPicker"));
    expect(secretPicker.slice(0, secretPicker.indexOf("\n}\n"))).toMatch(
      /<SecretSelect[^>]*ownedOnly/,
    );
    const bindings = readFileSync("src/components/etl/SecretBindingsEditor.tsx", "utf8");
    expect(bindings).toMatch(/<SecretSelect[^>]*ownedOnly/);
    const mcp = readFileSync("src/routes/_authenticated/mcp-builder_.$appId.tsx", "utf8");
    expect(mcp).toMatch(/<SecretSelect[^>]*format="name"[^>]*ownedOnly/);
    expect(mcp).toContain("usableSecrets(owned.secrets, owned.me, { ownedOnly: true })");
    const integrations = readFileSync("src/routes/_authenticated/integrations.tsx", "utf8");
    const webhook = integrations.slice(integrations.indexOf("id={`notif-webhook-${ch.kind}`}"));
    expect(webhook.slice(0, 400)).toContain("ownedOnly");
  });
});

describe("a field that takes shared secrets", () => {
  it("offers every secret the caller can use", () => {
    expect(usableSecrets(ALL, ME).map((s) => s.name)).toEqual(["MY_KEY", "TEAM_KEY", "LOCKED"]);
  });

  it("never flags the caller's own secret, wherever it goes", () => {
    expect(ownsSecret(mine, ME)).toBe(true);
    expect(sharedSecretProblem(mine, ME, ["https://anywhere.example"])).toBeNull();
    expect(sharedSecretProblem(mine, ME, [])).toBeNull();
  });

  it("accepts a shared secret toward a host its owner allowed", () => {
    expect(sharedSecretProblem(shared, ME, ["https://api.openai.com/v1"])).toBeNull();
    expect(sharedSecretProblem(shared, ME, ["acme.snowflakecomputing.com"])).toBeNull();
  });

  it("flags a shared secret toward a host its owner did not allow", () => {
    const p = sharedSecretProblem(shared, ME, ["https://evil.example/v1", "api.openai.com"]);
    expect(p).toEqual({
      kind: "host-not-allowed",
      hosts: ["evil.example"],
      allowed: ["api.openai.com", "*.snowflakecomputing.com"],
    });
    expect(sharedSecretProblemText("TEAM_KEY", p!)).toMatch(
      /its owner allows only api\.openai\.com, \*\.snowflakecomputing\.com, and this field sends it to evil\.example/,
    );
    const none = sharedSecretProblem(sharedNowhere, ME, ["api.openai.com"]);
    expect(sharedSecretProblemText("LOCKED", none!)).toMatch(/has not allowed any host yet/);
  });

  it("cannot vouch for a shared secret while the destination is unknown", () => {
    // The server refuses a shared secret with no destination, or one it
    // cannot read as a host (a template in the host part, say).
    expect(sharedSecretProblem(shared, ME, undefined)).toEqual({ kind: "no-destination" });
    expect(sharedSecretProblem(shared, ME, [""])).toEqual({ kind: "no-destination" });
    expect(sharedSecretProblem(shared, ME, ["https://{{host}}/x"])).toEqual({
      kind: "no-destination",
    });
    expect(destinationHosts(["https://API.openai.com:443/v1", "api.openai.com"])).toEqual([
      "api.openai.com",
    ]);
  });

  it("says whose a shared secret is and where it may go", () => {
    expect(sharedSecretNote(shared)).toBe(
      "Shared by owner@example.test · May be sent to api.openai.com, *.snowflakecomputing.com",
    );
    expect(sharedSecretNote(sharedNowhere)).toBe(
      "Shared with you · Allows no host yet, so people it is shared with cannot use it",
    );
  });
});
