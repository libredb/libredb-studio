import { fixupConfigRules } from "@eslint/compat";
import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

// ESLint 10 removed the deprecated rule-context methods (`context.getFilename()`
// and friends). eslint-config-next 16.3.1 still depends on eslint-plugin-react
// ^7.37.0, whose newest release (7.37.5, April 2025) calls them - so loading any
// of its rules under ESLint 10 throws
// `TypeError: contextOrFilename.getFilename is not a function`
// before a single file is linted. eslint-config-next's own peerDependency range
// (`eslint: >=9.0.0`) does not reflect this; the transitive plugin is the real
// constraint.
//
// `fixupConfigRules` is ESLint's own sanctioned shim (@eslint/compat, maintained
// by the ESLint team) for exactly this case: it wraps each rule so the removed
// context methods resolve against the modern SourceCode API. It is a no-op for
// rules that already use the new API, so it stays harmless as plugins catch up.
//
// Remove this wrapper once eslint-config-next depends on an eslint-plugin-react
// that declares `eslint: ^10` - at that point these two lines can go back to a
// bare spread. Tracked in docs/BACKLOG.md.
const eslintConfig = defineConfig([
  ...fixupConfigRules(nextCoreWebVitals),
  ...fixupConfigRules(nextTypescript),
  // snap-payload/ is the local snap-build scratch dir (see snap/snapcraft.yaml);
  // desktop/src-tauri/{payload,target,bin}/ are the same kind of scratch for the
  // desktop AppImage build (scripts/build-desktop-appimage.sh stages the whole
  // standalone payload, node_modules included, in there);
  // .claude/ holds agent worktrees whose checkouts (and .next build output)
  // must not be linted from this checkout, and .loop/ is the same kind of
  // gitignored agent scratch (maintainer-loop live state and its archives);
  // public/monaco/** is the Monaco AMD bundle staged from node_modules by
  // scripts/copy-monaco.mjs (issue #247) — 16 MB of minified vendor JS that
  // exhausts ESLint's heap, and it only appears once something has built
  globalIgnores([
    ".next/**",
    "public/monaco/**",
    "out/**",
    "build/**",
    "dist/**",
    "snap-payload/**",
    "desktop/src-tauri/payload/**",
    "desktop/src-tauri/target/**",
    "desktop/src-tauri/bin/**",
    ".claude/**",
    ".loop/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "prefer-const": "warn",
      "react/no-unescaped-entities": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/incompatible-library": "warn",
      // dangerouslySetInnerHTML is an XSS sink: the security hotfix branch removed the two that
      // existed (LLM markdown now renders through src/components/rich-text.tsx's React-node
      // renderer instead), and this rule is what keeps a third one from being added silently.
      // Enforced here (ESLint / eslint-config-next), not in oxlint's .oxlintrc.json: this
      // project's convention is that eslint-config-next owns React/JSX-semantics rules (see the
      // "Strategy A" note below, and .oxlintrc.json's react/react-in-jsx-scope and
      // react-hooks/exhaustive-deps entries, which are explicitly turned off there so they are
      // not double-reported). oxlint's react plugin implements react/no-danger too, but leaves it
      // off by default (it sits outside oxlint's correctness/suspicious categories, which are the
      // only ones this project enables), so there is nothing to disable on that side — ESLint is
      // already the sole enforcer.
      "react/no-danger": "error",
    },
  },
  // Narrow type-aware safety net for the async-heavy code paths (API routes,
  // DB providers, and the storage layer). These rules need the real TypeScript
  // type checker (projectService), so they are scoped to keep lint fast and to
  // catch unhandled-promise bugs where they matter most. Strategy A:
  // eslint-config-next still owns all React/Next/hooks linting above; this
  // only adds promise safety. src/lib/storage/** joined this list in Phase 3
  // (0.10.0): the credential-encryption decorator wraps async provider
  // methods, which is exactly the shape this layer exists to catch.
  ...tseslint.config({
    files: ["src/app/api/**/*.ts", "src/lib/db/**/*.ts", "src/lib/storage/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  }),
]);

export default eslintConfig;
