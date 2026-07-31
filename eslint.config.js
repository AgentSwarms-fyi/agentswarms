import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
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
  eslintPluginPrettier,
);
