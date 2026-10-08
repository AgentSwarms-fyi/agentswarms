import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `.claude` holds agent worktrees — full checkouts of older commits. It is
  // gitignored, so CI never sees it, but eslint's flat config does not read
  // .gitignore and walked in anyway. The result was a local `npm run lint`
  // reporting DOUBLE the real errors, half of them phantom copies at
  // line numbers that did not match the working tree. That is worse than
  // noise: it teaches you to skim the output, which is how four genuine
  // errors sat in the tracked source failing CI without being noticed.
  // Local lint must mean what CI's lint means.
  //
  // `public/vendor` holds the document parsers the build copies from
  // node_modules (R321): minified third-party code. Linted, Prettier spent
  // half an hour on pdf.js's 1.4 MB worker. CI lints before it builds, so it
  // never saw them; a local `npm run check` after a build did.
  { ignores: ["dist", ".output", ".vinxi", ".claude", "public/vendor"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // Deliberately a warning, not an error, so `npm run lint` can GATE on
      // real errors instead of being permanently red and therefore ignored.
      //
      // The ~140 remaining uses sit at untyped external boundaries — LLM
      // provider responses, the MCP protocol, AlaSQL's UMD surface, Supabase
      // Json. Replacing them with `unknown` plus narrowing is worth doing and
      // is its own project; pretending they are errors while nobody can fix
      // them in one pass just trains people to skip the lint output.
      //
      // Tracked debt: the count should go down, never up.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // A route file exports `Route = createFileRoute(...)({ component })` and
    // keeps its page component local. TanStack Router's plugin, not React
    // Refresh, handles those files' hot reload. eslint-plugin-react-refresh
    // 0.5 began flagging the page component in every one of them (338
    // warnings, none actionable), so the rule stays on everywhere else.
    files: ["src/routes/**/*.{ts,tsx}"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // Two more kinds of file where the rule asks for something it cannot have
    // (R346, which moved every other non-component export out of a component
    // file):
    //
    // - Email templates are rendered to HTML on the server by React Email
    //   (/api/contact, /api/email/send, the budget alert). No browser loads
    //   them, so there is nothing to hot-reload, and each one's `template`
    //   entry (subject, preview data) belongs beside its component.
    // - Six shadcn/ui files export a variants helper or hook beside their
    //   components (buttonVariants, useSidebar…), as the shadcn CLI writes
    //   them. Splitting them would make every `npx shadcn add` a merge.
    files: [
      "src/lib/email-templates/**/*.tsx",
      "src/components/ui/{badge,button,form,navigation-menu,sidebar,toggle}.tsx",
    ],
    rules: { "react-refresh/only-export-components": "off" },
  },
  eslintPluginPrettier,
);
