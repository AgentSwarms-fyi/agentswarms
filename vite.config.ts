// Explicit Vite config for the open-source build.
// Replaces @lovable.dev/vite-tanstack-config with the same plugin stack:
//   tailwindcss + tsconfig paths + TanStack Start + React.
//
// Node is the only build target. A Cloudflare Workers build used to be the
// default, but workerd forbids `new Function()`, which the local SQL engine
// needs — so Data & BI features silently failed there. Supporting one runtime
// honestly beats advertising two and delivering one and a half.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type PluginOption, type UserConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const alasqlBrowserBuild = path.resolve(rootDir, "node_modules/alasql/dist/alasql.min.js");

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

  plugins.push(tanstackStart());
  plugins.push(viteReact());

  // Expose VITE_* vars to both the client and SSR bundles (the app reads
  // import.meta.env.VITE_SUPABASE_* in shared code paths).
  const envDefine: Record<string, string> = {};
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "VITE_"))) {
    envDefine[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  // Dev-only dependency optimization. Typed via UserConfig so the inline esbuild
  // plugin picks up its types without a direct esbuild import.
  //
  // `nodemailer` is server-only (email delivery) and its bare require('https')
  // breaks the browser dep scanner, so it stays excluded. The document-export
  // libs are the opposite: buildPptx/Docx/Xlsx import them dynamically IN THE
  // BROWSER, so they MUST be pre-bundled — otherwise the runtime dynamic import
  // fails with "Failed to fetch dynamically imported module" (they're CommonJS,
  // and pptxgenjs/image-size reference Node builtins on an image path we never
  // use). Force-include them and stub those builtins during the esbuild
  // pre-bundle so the browser gets a clean, loadable module.
  const serveOptimize: Pick<UserConfig, "optimizeDeps"> =
    command === "serve"
      ? {
          optimizeDeps: {
            // @duckdb/node-api resolves to a platform-specific `.node` binary.
            // esbuild has no loader for those, so leaving it in the optimizer
            // crashes `vite dev` outright — the production build already
            // externalises it, which is why this only ever broke dev.
            exclude: ["nodemailer", "@duckdb/node-api", "@duckdb/node-bindings"],
            include: ["pptxgenjs", "docx", "write-excel-file/browser"],
            esbuildOptions: {
              plugins: [
                {
                  name: "agentswarms-stub-docgen-node-deps",
                  setup(build) {
                    const BUILTINS = /^(node:)?(https?|os|fs|path|express)$/;
                    build.onResolve({ filter: BUILTINS }, (args) =>
                      /pptxgenjs|image-size/.test(args.importer)
                        ? { path: args.path, namespace: "agentswarms-docgen-empty" }
                        : undefined,
                    );
                    build.onLoad({ filter: /.*/, namespace: "agentswarms-docgen-empty" }, () => ({
                      contents: "module.exports = {};",
                      loader: "js",
                    }));
                  },
                },
              ],
            },
          },
        }
      : {};

  return {
    define: envDefine,
    plugins,
    ...serveOptimize,
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
