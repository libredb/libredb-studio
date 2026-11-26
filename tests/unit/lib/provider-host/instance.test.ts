/**
 * One host core per process (src/lib/provider-host/instance.ts; docs/providers/CONTRACT.md, clause C-52): a composition
 * root installs the core once under a registered symbol, the caller facade reads it at the start of every call, a call
 * made before the install fails by name, a second install from the same root keeps the first core, and one from another
 * root is refused by name. No module the library entries reach reads the slot, so an embedder composes nothing.
 *
 * Value imports are read with Bun's transpiler (tests/helpers/value-import-closure.ts), so a type-only import, which is
 * erased and loads nothing, is left out, and a path in a comment or a string is never one.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { cancelEditorRun, runEditorQuery } from "@/lib/api/editor-query";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import {
  forgetHostCore,
  HOST_CORE_KEY,
  HostCoreBootOrderError,
  hostCore,
  installHostCore,
} from "@/lib/provider-host/instance";
import type { DatabaseConnection } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";
import { valueImportClosure, valueImportsOf } from "../../../helpers/value-import-closure";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const NOT_INSTALLED =
  "The provider host core is not installed in this process, so Studio cannot make this call. A composition root installs it once when the process starts: src/instrumentation.ts for the server, the VS Code backend's entry for its child, and a test that runs the editor query installs it in its own setup.";
const ANOTHER_ROOT =
  "The provider host core is already installed in this process by the server composition root, so the vscode-backend composition root cannot install another: one composition root installs it once.";
/** The library entries the npm package publishes (tsup.config.ts). */
const LIBRARY_ENTRIES = ["index", "providers", "types", "components", "workspace", "security"].map(
  (name) => `src/exports/${name}.ts`,
);
const INSTANCE_MODULE = "src/lib/provider-host/instance.ts";
const HOST_CORE_MODULE = "src/lib/provider-host/core/host-core.ts";
const CORE_DIRECTORY = "src/lib/provider-host/core/";

afterEach(() => {
  forgetHostCore();
});

/** Every tracked `.ts` and `.tsx` source file under `directories`, repository-relative with forward slashes. */
function trackedSources(...directories: string[]): string[] {
  return execFileSync("git", ["ls-files", "--", ...directories], { cwd: REPOSITORY_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"));
}

/** The files among `files` that import `module` by value, sorted. */
function valueImportersOf(files: readonly string[], module: string): string[] {
  return files.filter((file) => valueImportsOf(file).includes(module)).sort();
}

describe("one host core per process", () => {
  test("the host core is installed once per process, under a registered symbol", () => {
    const core = createHostCore();

    installHostCore(core, "server");

    expect(HOST_CORE_KEY as symbol).toBe(Symbol.for("libredb-studio.provider-host-core"));
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("libredb-studio.provider-host-core")]).toEqual({
      root: "server",
      core,
    });
    expect(hostCore()).toBe(core);
  });

  test("a second install from the same composition root keeps the first core, and throws nothing", () => {
    const first = createHostCore();
    installHostCore(first, "server");

    expect(() => installHostCore(createHostCore(), "server")).not.toThrow();

    expect(hostCore()).toBe(first);
  });

  test("a second install from another composition root is refused by name, naming both roots, and the first core stays", () => {
    const first = createHostCore();
    installHostCore(first, "server");

    const caught = (() => {
      try {
        installHostCore(createHostCore(), "vscode-backend");
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(caught).toBeInstanceOf(HostCoreBootOrderError);
    expect((caught as Error).name).toBe("HostCoreBootOrderError");
    expect((caught as Error).message).toBe(ANOTHER_ROOT);
    expect(hostCore()).toBe(first);
  });

  test("a call made with no host core installed fails by name, and nothing reaches the provider", async () => {
    const provider = Object.assign(createMockProvider(), { cancelQuery: mock(async () => true) });
    const connection = { id: randomUUID(), name: "c", type: "postgres", createdAt: new Date(0) } as DatabaseConnection;
    const run = {
      statement: "SELECT 1",
      options: { limit: 1 },
      queryId: randomUUID(),
      signal: new AbortController().signal,
      route: "test",
      scrub: providerTextScrub(connection, "any"),
    };

    installHostCore(createHostCore(), "test");
    forgetHostCore();
    const [ran, cancelled] = await Promise.all([
      runEditorQuery({ form: "provider", provider }, run).catch((error: unknown) => error),
      cancelEditorRun(provider, randomUUID(), new AbortController().signal, "test").catch((error: unknown) => error),
    ]);

    expect(() => hostCore()).toThrow(HostCoreBootOrderError);
    for (const caught of [ran, cancelled]) {
      expect(caught).toBeInstanceOf(HostCoreBootOrderError);
      expect((caught as Error).message).toBe(NOT_INSTALLED);
    }
    expect(provider.prepareQuery).not.toHaveBeenCalled();
    expect(provider.query).not.toHaveBeenCalled();
    expect(provider.cancelQuery).not.toHaveBeenCalled();
  });

  test("only a composition root creates the host core, and only the core reaches its console calls", () => {
    const sources = trackedSources("src", "vscode-extension/src");

    expect(valueImportersOf(sources, HOST_CORE_MODULE)).toEqual([
      "src/instrumentation.ts",
      "vscode-extension/src/backend/main.ts",
    ]);
    for (const name of ["console.ts", "maintenance.ts", "monitoring.ts", "objects.ts", "page-budget.ts", "turns.ts"]) {
      const outside = valueImportersOf(sources, `${CORE_DIRECTORY}${name}`).filter(
        (file) => !file.startsWith(CORE_DIRECTORY),
      );
      expect({ name, outside }).toEqual({ name, outside: [] });
    }
  });

  test("no module the library entries reach reads the host core, so an embedder needs none", () => {
    for (const entry of LIBRARY_ENTRIES) {
      const closure = valueImportClosure(entry);
      expect({ entry, unresolved: closure.unresolved }).toEqual({ entry, unresolved: [] });
      expect({ entry, reads: closure.modules.includes(INSTANCE_MODULE) }).toEqual({ entry, reads: false });
    }
    // A control on the walk: the providers entry reaches the factory, whose `getOrCreateProvider` an embedder calls.
    expect(valueImportClosure("src/exports/providers.ts").modules).toContain("src/lib/db/factory.ts");
  });
});
