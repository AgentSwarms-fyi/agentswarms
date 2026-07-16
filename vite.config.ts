// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const alasqlBrowserBuild = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "node_modules/alasql/dist/alasql.min.js",
);


function stripExternalCssFontImports() {
  return {
    name: "agentswarms-strip-external-css-font-imports",
    enforce: "pre" as const,
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

export default defineConfig({
  vite: {
    plugins: [stripExternalCssFontImports()],
    resolve: {
      alias: [
        // alasql's "main" points to alasql.fs.js, which imports react-native-fs
        // and contains Flow/TS syntax Rollup can't parse. Force the browser
        // build everywhere since we only use alasql in-browser.
        { find: /^alasql$/, replacement: alasqlBrowserBuild },
      ],
    },
  },
});
