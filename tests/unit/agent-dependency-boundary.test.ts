import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

/**
 * The agent runtime's dependency bright line, made mechanical.
 *
 * Two rules are pinned here, both from the milestone's ratified inputs:
 *
 *  1. The agent runtime reaches the standalone build but NOT the published
 *     package. `@libredb/studio` is consumed by libredb-platform; declaring the
 *     workflow runtime as a production dependency would push its whole tree
 *     onto every npm consumer for a capability Phase 1 does not expose there.
 *  2. Only the ratified packages are installed, at exactly the ratified
 *     versions. Vendor model-provider packages are refused outright — the model
 *     bridges are first-party, so a new one appearing here means an iteration
 *     made a supply-chain choice it was not authorised to make.
 */

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest: PackageManifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
) as PackageManifest;

/** Exact versions ratified by the owner when the runtime spike closed. */
const RATIFIED_RUNTIME: Readonly<Record<string, string>> = {
  ai: "7.0.59",
  workflow: "4.8.1",
  "@workflow/world-local": "4.2.4",
  "@workflow/world-postgres": "4.3.3",
};

/** Every field npm installs on a consumer of the published package. */
const PUBLISHED_FIELDS: (keyof PackageManifest)[] = ["dependencies", "optionalDependencies", "peerDependencies"];

/**
 * AI-SDK packages that may legitimately be declared: the protocol/utility
 * packages the ratified `ai` release already resolves transitively. Anything
 * else under the scope is a vendor model provider.
 */
const ALLOWED_AI_SDK_PACKAGES = new Set(["@ai-sdk/provider", "@ai-sdk/provider-utils", "@ai-sdk/gateway"]);

/**
 * Vendor model-provider packages outside the `@ai-sdk` scope. Not exhaustive by
 * construction — the scope rule above catches the AI-SDK family — but it names
 * the ones a future task would most plausibly reach for.
 */
const REFUSED_VENDOR_PACKAGES = [
  "@anthropic-ai/sdk",
  "openai",
  "@mistralai/mistralai",
  "cohere-ai",
  "ollama",
  "@openrouter/ai-sdk-provider",
];

function declaredIn(field: keyof PackageManifest): Record<string, string> {
  return manifest[field] ?? {};
}

function allDeclaredNames(): string[] {
  return [
    ...Object.keys(declaredIn("dependencies")),
    ...Object.keys(declaredIn("devDependencies")),
    ...Object.keys(declaredIn("optionalDependencies")),
    ...Object.keys(declaredIn("peerDependencies")),
  ];
}

describe("agent runtime stays out of the published dependency set", () => {
  for (const field of PUBLISHED_FIELDS) {
    test(`${field} declares none of the agent runtime packages`, () => {
      const declared = Object.keys(declaredIn(field));
      for (const name of Object.keys(RATIFIED_RUNTIME)) {
        expect(declared).not.toContain(name);
      }
    });
  }

  test("no @workflow-scoped package is declared in the published dependency set", () => {
    for (const field of PUBLISHED_FIELDS) {
      const workflowScoped = Object.keys(declaredIn(field)).filter((name) => name.startsWith("@workflow/"));
      expect(workflowScoped).toEqual([]);
    }
  });
});

describe("agent runtime is installed at the ratified versions", () => {
  test.each(Object.entries(RATIFIED_RUNTIME))("declares %s at exactly %s", (name, version) => {
    expect(declaredIn("devDependencies")[name]).toBe(version);
  });
});

describe("the knip ignore list stays bounded", () => {
  /**
   * knip fails the gate on a declared-but-unused dependency, and the ratified
   * runtime is installed before any source file imports it, so the four names
   * are ignored there. Two of them are expected to leave that list once the run
   * loop imports them; `@workflow/world-postgres` is expected to stay, because
   * the runtime resolves it by module specifier from `WORKFLOW_TARGET_WORLD`
   * and no static import of it will ever exist. This test is what stops the
   * list from quietly becoming a place where unused dependencies hide.
   */
  const ALLOWED_IGNORED_DEPENDENCIES = new Set(["tailwindcss", ...Object.keys(RATIFIED_RUNTIME)]);

  test("ignores no dependency beyond tailwindcss and the ratified runtime", () => {
    const knip: { ignoreDependencies?: string[] } = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "knip.json"), "utf8"),
    ) as { ignoreDependencies?: string[] };
    // A subset assertion, deliberately: removing an entry once the run loop
    // imports the package is the desired direction of travel, and an equality
    // assertion would go red on exactly that and reward re-adding it.
    const unexpected = (knip.ignoreDependencies ?? []).filter((name) => !ALLOWED_IGNORED_DEPENDENCIES.has(name));
    expect(unexpected).toEqual([]);
  });
});

describe("no vendor model-provider package is installed", () => {
  test("declares no @ai-sdk model provider", () => {
    const vendorProviders = allDeclaredNames().filter(
      (name) => name.startsWith("@ai-sdk/") && !ALLOWED_AI_SDK_PACKAGES.has(name),
    );
    expect(vendorProviders).toEqual([]);
  });

  test.each(REFUSED_VENDOR_PACKAGES)("declares no %s", (name) => {
    expect(allDeclaredNames()).not.toContain(name);
  });
});
