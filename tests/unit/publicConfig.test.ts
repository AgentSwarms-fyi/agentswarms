// R464: the browser's settings are read when the server starts, not when the
// image is built. One image then serves any environment: the server renders
// PUBLIC_* into the page, and the browser reads them over the build-time
// VITE_* values (src/lib/publicConfig.ts).
//
// What must hold, and is driven here:
// - each PUBLIC_* is read, checked, and wins over its VITE_* counterpart;
//   VITE_* in the server's environment is read too, below PUBLIC_*;
// - a bad value is ignored (the build-time one applies) with a warning that
//   names the variable and never prints the value;
// - a service-role or secret key is refused, because the block is sent to
//   every visitor;
// - nothing in a value can close the <script> element it is rendered into;
// - what the server renders is exactly what the browser reads back, so both
//   sides of a setting (the BI row cap) agree;
// - no file but publicConfig.ts reads import.meta.env.VITE_*, so no browser
//   setting exists that only a rebuild can change.
import { readFileSync, readdirSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WIDGET_ROW_CAP_DEFAULT, widgetRowCap } from "@/lib/biDashboards";
import {
  PUBLIC_CONFIG_ELEMENT_ID,
  PUBLIC_CONFIG_VARS,
  assertSafeBuildEnv,
  buildTimePublicConfig,
  mergePublicConfig,
  parsePublicConfig,
  publicConfig,
  publicConfigScriptText,
  rejectPublicValue,
  resetPublicConfigForTests,
  runtimePublicConfig,
  serializePublicConfig,
} from "@/lib/publicConfig";

const jwt = (payload: object) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");

const ANON = jwt({ iss: "supabase", role: "anon" });
const SERVICE = jwt({ iss: "supabase", role: "service_role" });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPublicConfigForTests();
});

/** A browser as publicConfig sees one: a window, and a page holding `text` in the block. */
function asBrowser(text: string | null) {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    getElementById: (id: string) =>
      id === PUBLIC_CONFIG_ELEMENT_ID && text !== null ? { textContent: text } : null,
  });
  resetPublicConfigForTests();
}

describe("the server reads PUBLIC_* from its environment", () => {
  it("reads every setting by its runtime name", () => {
    const env = {
      PUBLIC_SUPABASE_URL: " https://db.example.com ",
      PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON,
      PUBLIC_ADMIN_EMAIL: "ops@example.com",
      PUBLIC_BI_SNAPSHOT_ROWS_CAP: "2500",
      PUBLIC_GA_ID: "G-ABC123",
      PUBLIC_GTM_ID: "GTM-XYZ9",
      PUBLIC_NOTEBOOK_GATEWAY_PORT: "9443",
    };
    expect(runtimePublicConfig(env)).toEqual({
      supabaseUrl: "https://db.example.com",
      supabasePublishableKey: ANON,
      adminEmail: "ops@example.com",
      biSnapshotRowsCap: "2500",
      gaId: "G-ABC123",
      gtmId: "GTM-XYZ9",
      notebookGatewayPort: "9443",
    });
    // Each runtime name in the table is one the reader actually reads.
    for (const { runtime } of Object.values(PUBLIC_CONFIG_VARS)) {
      expect(Object.keys(env)).toContain(runtime);
    }
  });

  it("an environment with none of them renders an empty block", () => {
    expect(runtimePublicConfig({})).toEqual({});
    expect(serializePublicConfig(runtimePublicConfig({ PUBLIC_GA_ID: "  " }))).toBe("{}");
  });

  it("an environment made from an existing .env works unrenamed: VITE_* is read too", () => {
    // A Kubernetes Secret made from .env carries VITE_*, not PUBLIC_*; an image
    // built without VITE_ values must still get its settings from it.
    expect(
      runtimePublicConfig({ VITE_SUPABASE_URL: "https://db.example.com", VITE_GA_ID: "G-1" }),
    ).toEqual({ supabaseUrl: "https://db.example.com", gaId: "G-1" });
  });

  it("PUBLIC_* wins over VITE_* in the same environment, and a bad PUBLIC_ falls through", () => {
    const warn = vi.fn();
    expect(
      runtimePublicConfig(
        {
          PUBLIC_SUPABASE_URL: "https://public.example.com",
          VITE_SUPABASE_URL: "https://vite.example.com",
          PUBLIC_GA_ID: "bad id",
          VITE_GA_ID: "G-GOOD",
        },
        warn,
      ),
    ).toEqual({ supabaseUrl: "https://public.example.com", gaId: "G-GOOD" });
    expect(String(warn.mock.calls[0][0])).toMatch(/^PUBLIC_GA_ID /);
  });

  it("a quoted value (kubectl keeps .env's quotes) is refused, not used", () => {
    // deploy/k8s/app/agentswarms.yaml warns about this; the check catches it.
    const warn = vi.fn();
    expect(runtimePublicConfig({ VITE_SUPABASE_URL: '"https://db.example.com"' }, warn)).toEqual(
      {},
    );
    expect(String(warn.mock.calls[0][0])).toMatch(/^VITE_SUPABASE_URL is not a URL/);
  });

  it("ignores a value that fails its check, and says which variable without printing it", () => {
    const warn = vi.fn();
    const bad = {
      PUBLIC_SUPABASE_URL: "javascript:alert(1)",
      PUBLIC_ADMIN_EMAIL: "not an address",
      PUBLIC_BI_SNAPSHOT_ROWS_CAP: "lots",
      PUBLIC_GA_ID: "G-1');fetch('//evil",
      PUBLIC_GTM_ID: "GTM 1",
      PUBLIC_NOTEBOOK_GATEWAY_PORT: "70000",
    };
    expect(runtimePublicConfig(bad, warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(6);
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    for (const [name, value] of Object.entries(bad)) {
      expect(said).toContain(name);
      expect(said).not.toContain(value);
    }
  });

  it("checks each kind of value", () => {
    expect(rejectPublicValue("supabaseUrl", "https://x.supabase.co")).toBeNull();
    expect(rejectPublicValue("supabaseUrl", "http://localhost:54321")).toBeNull();
    expect(rejectPublicValue("supabaseUrl", "ftp://x")).not.toBeNull();
    expect(rejectPublicValue("supabaseUrl", "/relative")).not.toBeNull();
    expect(rejectPublicValue("notebookGatewayPort", "0")).not.toBeNull();
    expect(rejectPublicValue("notebookGatewayPort", "65535")).toBeNull();
    expect(rejectPublicValue("biSnapshotRowsCap", "1200.7")).toBeNull();
    expect(rejectPublicValue("biSnapshotRowsCap", "-5")).not.toBeNull();
    expect(rejectPublicValue("gaId", "UA-12345-1")).toBeNull();
  });
});

describe("a key that would hand over the database is refused", () => {
  it("refuses the service-role key itself", () => {
    const warn = vi.fn();
    const env = {
      SUPABASE_SERVICE_ROLE_KEY: "the-service-role-key-value",
      PUBLIC_SUPABASE_PUBLISHABLE_KEY: "the-service-role-key-value",
    };
    expect(runtimePublicConfig(env, warn).supabasePublishableKey).toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toMatch(/PUBLIC_SUPABASE_PUBLISHABLE_KEY.*service-role/);
    expect(String(warn.mock.calls[0][0])).not.toContain("the-service-role-key-value");
  });

  it("refuses any JWT whose role is service_role, and a secret-format key", () => {
    expect(rejectPublicValue("supabasePublishableKey", SERVICE)).toMatch(/service_role/);
    expect(rejectPublicValue("supabasePublishableKey", "sb_secret_abc123")).toMatch(/secret/);
  });

  it("accepts the anon key and the publishable-format key", () => {
    expect(rejectPublicValue("supabasePublishableKey", ANON)).toBeNull();
    expect(rejectPublicValue("supabasePublishableKey", "sb_publishable_abc123")).toBeNull();
  });

  it("refuses the same key in VITE_* at runtime", () => {
    expect(runtimePublicConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: SERVICE })).toEqual({});
  });

  it("the build refuses to inline one: no runtime check could take it back out", () => {
    expect(() => assertSafeBuildEnv({ VITE_SUPABASE_PUBLISHABLE_KEY: SERVICE })).toThrow(
      /Refusing to build/,
    );
    expect(() =>
      assertSafeBuildEnv({
        SUPABASE_SERVICE_ROLE_KEY: "k-123",
        VITE_SUPABASE_PUBLISHABLE_KEY: "k-123",
      }),
    ).toThrow(/service-role key/);
    expect(() => assertSafeBuildEnv({ VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_x" })).toThrow();
    // The normal cases build.
    expect(() => assertSafeBuildEnv({ VITE_SUPABASE_PUBLISHABLE_KEY: ANON })).not.toThrow();
    expect(() => assertSafeBuildEnv({})).not.toThrow();
    // A malformed key is not a security problem; the build does not fail on it.
    expect(() => assertSafeBuildEnv({ VITE_SUPABASE_PUBLISHABLE_KEY: "has space" })).not.toThrow();
    expect(readFileSync("vite.config.ts", "utf8")).toContain(
      'assertSafeBuildEnv({ ...process.env, ...loadEnv(mode, process.cwd(), "") })',
    );
  });
});

describe("precedence: runtime over build, per setting", () => {
  it("a runtime value replaces only its own setting", () => {
    expect(
      mergePublicConfig(
        { supabaseUrl: "https://runtime.example.com" },
        { supabaseUrl: "https://build.example.com", gaId: "G-BUILD" },
      ),
    ).toEqual({ supabaseUrl: "https://runtime.example.com", gaId: "G-BUILD" });
  });

  it("an empty runtime value does not blank a build-time one", () => {
    expect(mergePublicConfig({ gaId: "" }, { gaId: "G-BUILD" })).toEqual({ gaId: "G-BUILD" });
  });

  it("on the server, PUBLIC_* wins over the build-time value", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://build.example.com");
    vi.stubEnv("PUBLIC_SUPABASE_URL", "https://runtime.example.com");
    expect(publicConfig().supabaseUrl).toBe("https://runtime.example.com");
    vi.stubEnv("PUBLIC_SUPABASE_URL", "");
    expect(publicConfig().supabaseUrl).toBe("https://build.example.com");
  });
});

describe("the data block", () => {
  it("nothing in a value can close the element or open a comment", () => {
    const hostile = { supabaseUrl: 'https://x/</script><script>alert(1)</script><!--"' };
    const text = serializePublicConfig(hostile);
    expect(text).not.toContain("<");
    expect(parsePublicConfig(text)).toEqual(hostile);
  });

  it("reads back only known string settings", () => {
    expect(parsePublicConfig("not json")).toEqual({});
    expect(parsePublicConfig("[1,2]")).toEqual({});
    expect(parsePublicConfig("null")).toEqual({});
    expect(parsePublicConfig(null)).toEqual({});
    expect(
      parsePublicConfig(
        JSON.stringify({ gaId: "G-1", adminEmail: 42, serviceRoleKey: "x", constructor: "y" }),
      ),
    ).toEqual({ gaId: "G-1" });
  });
});

describe("the browser reads what the server rendered", () => {
  it("round trip: server text -> page -> browser config", () => {
    vi.stubEnv("PUBLIC_SUPABASE_URL", "https://runtime.example.com");
    vi.stubEnv("PUBLIC_ADMIN_EMAIL", "ops@example.com");
    const serverText = publicConfigScriptText();
    const serverView = publicConfig();
    vi.unstubAllEnvs();

    asBrowser(serverText);
    // Hydration renders back exactly the server's text, so React has nothing to patch.
    expect(publicConfigScriptText()).toBe(serverText);
    expect(publicConfig().supabaseUrl).toBe(serverView.supabaseUrl);
    expect(publicConfig().adminEmail).toBe("ops@example.com");
  });

  it("a page without the block (or a broken one) falls back to the build", () => {
    asBrowser(null);
    expect(publicConfig()).toEqual(buildTimePublicConfig());
    expect(publicConfigScriptText()).toBe("{}");
    asBrowser("{broken");
    expect(publicConfig()).toEqual(buildTimePublicConfig());
  });

  it("the browser reads the page, never process.env (which a browser does not have)", () => {
    vi.stubEnv("PUBLIC_SUPABASE_URL", "https://server-only.example.com");
    asBrowser(JSON.stringify({ supabaseUrl: "https://from-the-page.example.com" }));
    expect(publicConfig().supabaseUrl).toBe("https://from-the-page.example.com");
  });
});

describe("one setting, the same on both sides (the BI row cap)", () => {
  it("the server's PUBLIC_BI_SNAPSHOT_ROWS_CAP wins over the build-time cap", () => {
    vi.stubEnv("VITE_BI_SNAPSHOT_ROWS_CAP", "2500");
    vi.stubEnv("PUBLIC_BI_SNAPSHOT_ROWS_CAP", "3000");
    expect(widgetRowCap()).toBe(3000);
  });

  it("the browser, reading the page the server rendered, gets the same cap", () => {
    vi.stubEnv("PUBLIC_BI_SNAPSHOT_ROWS_CAP", "3000");
    const page = publicConfigScriptText();
    const serverCap = widgetRowCap();
    vi.unstubAllEnvs();
    asBrowser(page);
    expect(widgetRowCap()).toBe(serverCap);
    expect(serverCap).not.toBe(WIDGET_ROW_CAP_DEFAULT);
  });
});

describe("no browser setting that only a rebuild can change", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("only src/lib/publicConfig.ts reads import.meta.env.VITE_*", () => {
    const readers = walk("src").filter(
      (f) =>
        !f.endsWith("lib/publicConfig.ts") &&
        /import\.meta\.env\.VITE_/.test(readFileSync(f, "utf8")),
    );
    expect(readers, "read through publicConfig() so a PUBLIC_* value can override it").toEqual([]);
  });

  it("every setting is read at build time and at runtime by its literal name", () => {
    const src = readFileSync("src/lib/publicConfig.ts", "utf8");
    for (const { runtime, build } of Object.values(PUBLIC_CONFIG_VARS)) {
      expect(src, `${build} must be read in its literal form`).toContain(
        `import.meta.env.${build}`,
      );
      expect(src, `${runtime} must be read by name`).toContain(`env.${runtime}`);
    }
  });

  it("every runtime name is documented for operators", () => {
    const example = readFileSync(".env.example", "utf8");
    const deployment = readFileSync("docs/DEPLOYMENT.md", "utf8");
    for (const { runtime } of Object.values(PUBLIC_CONFIG_VARS)) {
      expect(example, `.env.example does not mention ${runtime}`).toContain(runtime);
      expect(deployment, `DEPLOYMENT.md does not mention ${runtime}`).toContain(runtime);
    }
  });

  it("the Kubernetes installer gives the browser its settings at runtime", () => {
    // setup-k8s.sh builds the image with no VITE_* (.dockerignore keeps .env
    // out of the build), so before R464 its page had no Supabase URL at all.
    const script = readFileSync("scripts/setup-k8s.sh", "utf8");
    expect(readFileSync(".dockerignore", "utf8")).toMatch(/^\.env$/m);
    expect(script).toMatch(/docker build -t "\$IMAGE" \.\s/);
    expect(script).toContain('--from-literal=PUBLIC_SUPABASE_URL="$PUBLIC_SUPABASE_URL"');
    expect(script).toContain('--from-literal=PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"');
    // The browser cannot reach the in-cluster gateway name the server uses.
    expect(script).toMatch(
      /PUBLIC_SUPABASE_URL="\$\{PUBLIC_SUPABASE_URL:-http:\/\/localhost:8000\}"/,
    );
    expect(script).toContain("port-forward svc/${KONG_SVC} 8000:8000");
  });

  it("the page renders the block, as data, from the server's text", () => {
    const root = readFileSync("src/routes/__root.tsx", "utf8");
    expect(root).toMatch(/id=\{PUBLIC_CONFIG_ELEMENT_ID\}\s+type="application\/json"/);
    expect(root).toContain("dangerouslySetInnerHTML={{ __html: publicConfigScriptText() }}");
  });
});
