// Explicit Vite config for the open-source build.
// Replaces @lovable.dev/vite-tanstack-config with the same plugin stack:
//   tailwindcss + tsconfig paths + TanStack Start + React, and the
//   Cloudflare Workers plugin on `vite build` (skip with DEPLOY_TARGET=node).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type PluginOption } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const alasqlBrowserBuild = path.resolve(
  rootDir,
  "node_modules/alasql/dist/alasql.min.js",
);

function stripExternalCssFontImports(): PluginOption {
  return {
    name: "agentswarms-strip-external-css-font-imports",
    enforce: "pre",
    transform(code: string, id: string) {
      if (!id.includes("/src/") || !id.split("?")[0].endsWith(".css")) return null;

      const sanitized = code.replace(
        /^\s*@import\s+(?:url\(\s*)?['"]?https:\/\/fonts\.(?:googleapis|gstatic)\.com\/[^;\n]+;\s*$/gm,
        "",
      );

      return sanitized === code ? null : { code: sanitized, map: null };
    },
  };
}

export default defineConfig(async ({ command, mode }) => {
  const plugins: PluginOption[] = [
    stripExternalCssFontImports(),
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
  ];

  // Cloudflare Workers build (the default deploy target, via wrangler.jsonc).
  // Set DEPLOY_TARGET=node to produce a plain Node SSR build instead
  // (used by the Docker image).
  if (command === "build" && process.env.DEPLOY_TARGET !== "node") {
    try {
      const { cloudflare } = await import("@cloudflare/vite-plugin");
      plugins.push(cloudflare({ viteEnvironment: { name: "ssr" } }));
    } catch {
      // @cloudflare/vite-plugin not installed — fall through to the Node build.
    }
  }

  plugins.push(tanstackStart());
  plugins.push(viteReact());

  // Expose VITE_* vars to both the client and SSR bundles (the app reads
  // import.meta.env.VITE_SUPABASE_* in shared code paths).
  const envDefine: Record<string, string> = {};
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "VITE_"))) {
    envDefine[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  return {
    define: envDefine,
    plugins,
    resolve: {
      alias: [
        { find: "@", replacement: path.resolve(rootDir, "src") },
        // alasql's "main" points to alasql.fs.js, which imports react-native-fs
        // and contains Flow/TS syntax Rollup can't parse. Force the browser
        // build everywhere since we only use alasql in-browser.
        { find: /^alasql$/, replacement: alasqlBrowserBuild },
      ],
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    server: {
      host: "::",
      port: 8080,
      // Notebook kernels run in containers and call the app back at
      // http://host.docker.internal:8080 (dev mode). Vite's host check rejects
      // unknown Host headers with "Blocked request", which would break every
      // agentswarms.chat()/kb_search() call from a server kernel.
      allowedHosts: ["host.docker.internal"],
      watch: {
        awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
      },
    },
  };
});
