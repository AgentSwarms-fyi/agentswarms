// The document parsers this app serves from its own origin (R321).
//
// FOUND IN THE GAP REVIEW. pdf.js and mammoth were imported from esm.sh and
// jsdelivr at runtime. An install without internet access could not read a
// PDF or DOCX upload; code from a third party ran inside the signed-in app;
// and the versions fetched (pdf.js 4.7.76, mammoth 1.8.0) were not the ones
// the lockfile pins and `npm audit` checks.
//
// The build now copies each file below from node_modules into public/vendor
// (the plugin in vite.config.ts), and the parsers load them from there. The
// paths are stable rather than content-hashed, which keeps what the CDN was
// chosen for: a tab opened before a redeploy still finds them. The version in
// the query string is the installed package's, so a browser never pairs a
// cached pdf.js with a newer worker.
//
// Pure data: read by the client, the build and the tests. The import
// attribute is for Node, which loads vite.config.ts and refuses a JSON import
// without one; Vite, Vitest and tsc accept it as well.
import pdfjsPackage from "pdfjs-dist/package.json" with { type: "json" };
import mammothPackage from "mammoth/package.json" with { type: "json" };

export const VENDORED_PARSERS = [
  {
    from: "node_modules/pdfjs-dist/build/pdf.min.mjs",
    path: "vendor/pdfjs/pdf.min.mjs",
    version: pdfjsPackage.version,
  },
  {
    from: "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
    path: "vendor/pdfjs/pdf.worker.min.mjs",
    version: pdfjsPackage.version,
  },
  {
    from: "node_modules/mammoth/mammoth.browser.min.js",
    path: "vendor/mammoth/mammoth.browser.min.js",
    version: mammothPackage.version,
  },
] as const;

const urlOf = (i: number) => `/${VENDORED_PARSERS[i].path}?v=${VENDORED_PARSERS[i].version}`;

export const PDFJS_URL = urlOf(0);
export const PDFJS_WORKER_URL = urlOf(1);
export const MAMMOTH_URL = urlOf(2);
