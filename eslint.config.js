import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist", "**/node_modules", "**/coverage"] },

  // Base TypeScript config for all .ts files
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [js.configs.recommended, ...tseslint.configs.strict],
    linterOptions: {
      noInlineConfig: true,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },

  // Server: Node.js environment
  {
    files: ["server/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
    },
  },

  // Electron main + preload: Node.js environment
  {
    files: ["electron/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Bundled plugins: Node.js environment
  {
    files: ["plugins/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },

  // JS/MJS/CJS scripts: Node.js environment
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
    },
  },

  // Test files: relax rules for mocks/stubs
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // Client: React + browser environment
  {
    files: ["client/src/**/*.tsx", "client/src/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // Disable ESLint rules that conflict with Prettier — must be last
  prettier,
);
