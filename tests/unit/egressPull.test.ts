// The egress allow-list, pulled by the proxy instead of written for it (R478).
//
// On ECS and EKS the app cannot write the proxy's files or restart it, so
// docker/egress-proxy fetches allowed_domains and allowed_ips from the app.
// What it fetches must be exactly what Compose writes; only the proxy may
// fetch it; and a list that could not be read must not arrive as an empty one.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const settings = vi.fn();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => settings() }) }) }),
  },
}));

import {
  EGRESS_PULL_TOKEN_MIN,
  applyEgressAllowlist,
  egressFiles,
  egressPullMode,
  egressPullTokenMatches,
  ensurePlatformEgress,
} from "@/utils/notebookRuntime/egressApply.server";
import { renderEgressAllowlist, renderEgressIpAllowlist } from "@/utils/notebookRuntime/egress";

type Get = (a: { request: Request; params: { file: string } }) => Promise<Response>;
let GET: Get;
beforeAll(async () => {
  const { Route } = (await import("@/routes/api/notebook.runtime.egress.$file")) as unknown as {
    Route: { options: { server: { handlers: { GET: Get } } } };
  };
  GET = Route.options.server.handlers.GET;
}, 120_000);

const TOKEN = "t".repeat(EGRESS_PULL_TOKEN_MIN);
const saved = { ...process.env };
beforeEach(() => {
  settings.mockReset();
  settings.mockResolvedValue({
    data: { egress_allowlist: ["github.com", "192.168.1.85"] },
    error: null,
  });
  process.env.LAKEHOUSE_S3_ENDPOINT = "http://10.40.0.9:9000";
});
afterEach(() => {
  process.env = { ...saved };
});

const get = (file: string, auth?: string) =>
  GET({
    request: new Request(`http://app/api/notebook/runtime/egress/${file}`, {
      headers: auth ? { Authorization: auth } : {},
    }),
    params: { file },
  });

describe("who may pull it", () => {
  it("is off until a long enough token is set", () => {
    expect(egressPullTokenMatches(`Bearer ${TOKEN}`, {})).toBe(false);
    const short = "s".repeat(EGRESS_PULL_TOKEN_MIN - 1);
    expect(egressPullTokenMatches(`Bearer ${short}`, { NOTEBOOK_EGRESS_PULL_TOKEN: short })).toBe(
      false,
    );
  });

  it("answers the proxy's token and nothing else", () => {
    const env = { NOTEBOOK_EGRESS_PULL_TOKEN: TOKEN };
    expect(egressPullTokenMatches(`Bearer ${TOKEN}`, env)).toBe(true);
    expect(egressPullTokenMatches(`Bearer ${TOKEN}x`, env)).toBe(false);
    expect(egressPullTokenMatches(TOKEN, env)).toBe(false);
    expect(egressPullTokenMatches(null, env)).toBe(false);
  });

  it("is a 404 to anyone else, as if it were not there", async () => {
    process.env.NOTEBOOK_EGRESS_PULL_TOKEN = TOKEN;
    expect((await get("allowed_domains")).status).toBe(404);
    expect((await get("allowed_domains", "Bearer wrong")).status).toBe(404);
    expect(settings).not.toHaveBeenCalled();
  });

  it("is off entirely without a token, even to a caller that guesses one", async () => {
    delete process.env.NOTEBOOK_EGRESS_PULL_TOKEN;
    expect((await get("allowed_domains", "Bearer ")).status).toBe(404);
  });
});

describe("what it hands over", () => {
  it("is the two files Compose writes, with the platform's own hosts", async () => {
    process.env.NOTEBOOK_EGRESS_PULL_TOKEN = TOKEN;
    const all = ["github.com", "192.168.1.85", "http://10.40.0.9:9000"];
    const domains = await get("allowed_domains", `Bearer ${TOKEN}`);
    expect(domains.status).toBe(200);
    expect(domains.headers.get("cache-control")).toBe("no-store");
    expect(await domains.text()).toBe(renderEgressAllowlist(all));
    const ips = await get("allowed_ips", `Bearer ${TOKEN}`);
    expect(await ips.text()).toBe(renderEgressIpAllowlist(all));
    expect(renderEgressIpAllowlist(all)).toContain("10.40.0.9");
  });

  it("names nothing but those two files", async () => {
    process.env.NOTEBOOK_EGRESS_PULL_TOKEN = TOKEN;
    expect((await get("..%2Fsquid.conf", `Bearer ${TOKEN}`)).status).toBe(404);
    expect((await get("allowed_hosts", `Bearer ${TOKEN}`)).status).toBe(404);
  });

  it("answers 503, not an empty list, when the saved list cannot be read", async () => {
    process.env.NOTEBOOK_EGRESS_PULL_TOKEN = TOKEN;
    settings.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get("allowed_domains", `Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    await expect(egressFiles()).rejects.toThrow(/connection reset/);
  });
});

describe("saving the list in pull mode", () => {
  it("writes nothing and restarts nothing, and says the proxy will pick it up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-pull-"));
    process.env.NOTEBOOK_EGRESS_ALLOWLIST_PATH = join(dir, "allowed_domains");
    process.env.NOTEBOOK_EGRESS_MODE = "pull";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await applyEgressAllowlist(["github.com"]);
    expect(r).toMatchObject({ applied: true, pulled: true });
    expect(existsSync(join(dir, "allowed_domains"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await ensurePlatformEgress()).toMatchObject({ applied: true, pulled: true });
    fetchSpy.mockRestore();
  });

  it("is only pull mode when asked for", () => {
    expect(egressPullMode({})).toBe(false);
    expect(egressPullMode({ NOTEBOOK_EGRESS_MODE: "Pull " })).toBe(true);
    expect(egressPullMode({ NOTEBOOK_EGRESS_MODE: "write" })).toBe(false);
  });
});

describe("the proxy's side", () => {
  const conf = readFileSync("docker/egress-proxy/squid.conf", "utf8");
  const rules = conf
    .split("\n")
    .filter((l) => l.startsWith("http_access"))
    .map((l) => l.trim());
  const sh = readFileSync("docker/egress-proxy/egress-proxy.sh", "utf8");

  it("refuses metadata first, lets listed IPs through, then refuses every other private address", () => {
    expect(rules).toEqual([
      "http_access deny CONNECT !SSL_ports",
      "http_access deny !Safe_ports",
      "http_access deny blocked_dst",
      "http_access allow allowed_ips",
      "http_access deny private_dst",
      "http_access allow allowed_domains",
      "http_access deny all",
    ]);
    expect(conf).toMatch(/acl blocked_dst dst 127\.0\.0\.0\/8 169\.254\.0\.0\/16/);
    expect(conf).toMatch(
      /acl private_dst dst 10\.0\.0\.0\/8 172\.16\.0\.0\/12 192\.168\.0\.0\/16 100\.64\.0\.0\/10/,
    );
  });

  it("fetches both lists before moving either, and keeps what it has on a failure", () => {
    const pull = sh.slice(sh.indexOf("pull() {"), sh.indexOf("\n}\n", sh.indexOf("pull() {")));
    expect(pull.indexOf('if ! fetch "$name"')).toBeLessThan(pull.indexOf("mv -f"));
    expect(pull).toContain("return 2");
    expect(sh).toContain("squid -k reconfigure");
    // Straight to the app, never through a proxy of its own.
    expect(sh).toContain("--noproxy '*'");
  });

  it("starts with an empty list, which refuses everything", () => {
    expect(sh).toContain(': >"$LISTS/allowed_domains"');
    expect(sh).toContain(': >"$LISTS/allowed_ips"');
  });
});
