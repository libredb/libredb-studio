/**
 * One host core across two bundles of one process (docs/providers/CONTRACT.md, clauses C-51 and C-52;
 * docs/ARCHITECTURE.md, "The provider host core"), in the test process.
 *
 * Next.js loads instrumentation, which installs the host core, and each route handler as separate module instances,
 * each with its own copy of Studio's error classes. This file reproduces that with two `Bun.build` bundles of Studio's
 * source, each with its own copy of the errors, the SDK, the core and the facade: `boot.mjs`, the composition root that
 * installs `createHostCore()`, and `route.mjs`, which runs the editor query. Both load into this process with
 * `import()`. A bundle is named `.mjs`: written as `.js` beside its `.ts` entry, bun imports the `.ts` source instead,
 * and the two "bundles" would be one module instance.
 *
 * tests/live/host-core-live.ts holds the same rule live against the built standalone server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseProvider, PreparedQuery, QueryPrepareOptions } from "@/lib/db/types";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

const SOURCE = path.resolve(import.meta.dir, "..", "..", "..", "..", "src");
const source = (...parts: string[]): string => JSON.stringify(path.join(SOURCE, ...parts));

/** A host core as a bundle answers it: the console calls, typed loosely, since each bundle has its own copy. */
interface CoreShape {
  readonly executeCall: (...args: never[]) => unknown;
  readonly cancelCall: (...args: never[]) => unknown;
}

/** What the boot bundle exports: the composition root's install and its own copy of the errors. */
interface BootBundle {
  boot(): CoreShape;
  installHostCore(core: CoreShape, root: "test"): void;
  forgetHostCore(): void;
  QueryCancelledError: new (message: string) => Error;
  StudioTimeoutRefusal: new (message: string) => Error;
  QueryError: new (message: string) => Error;
}

/** What the route bundle exports: the facade, the slot's reader and its own copy of the errors and the record readers. */
interface RouteBundle {
  runEditorQuery(provider: DatabaseProvider, run: object): Promise<{ body: { rows: unknown[] } }>;
  cancelEditorRun(provider: DatabaseProvider, queryId: string, caller: AbortSignal, route: string): Promise<object>;
  hostCore(): CoreShape;
  providerTextScrub(connection: DatabaseConnection, reach: "any"): object;
  errorKind(error: unknown): string;
  errorOutcome(error: unknown): string;
  QueryCancelledError: new (message: string) => Error;
  StudioTimeoutRefusal: new (message: string) => Error;
  QueryError: new (message: string) => Error;
}

const directory = mkdtempSync(path.join(tmpdir(), "studio-cross-bundle-"));
let boot: BootBundle;
let route: RouteBundle;

/** Bundles `entry` (its text) on its own into `<directory>/<name>/bundle.mjs` and imports it. */
async function bundled<T>(name: string, entry: string[]): Promise<T> {
  const folder = path.join(directory, name);
  const file = path.join(folder, "entry.ts");
  await Bun.write(file, entry.join("\n"));
  const build = await Bun.build({ entrypoints: [file], outdir: folder, naming: "bundle.mjs", target: "node" });
  if (!build.success) throw new Error(`Bun.build could not bundle ${name}: ${build.logs.join("\n")}`);
  return (await import(pathToFileURL(path.join(folder, "bundle.mjs")).href)) as T;
}

beforeAll(async () => {
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  boot = await bundled<BootBundle>("boot", [
    `import { createHostCore } from ${source("lib", "provider-host", "core", "host-core.ts")};`,
    `import { installHostCore } from ${source("lib", "provider-host", "instance.ts")};`,
    `export { forgetHostCore, installHostCore } from ${source("lib", "provider-host", "instance.ts")};`,
    `export { QueryCancelledError, QueryError, StudioTimeoutRefusal } from ${source("lib", "db", "errors.ts")};`,
    'export function boot() { const core = createHostCore(); installHostCore(core, "test"); return core; }',
    "",
  ]);
  route = await bundled<RouteBundle>("route", [
    `export { cancelEditorRun, runEditorQuery } from ${source("lib", "api", "editor-query.ts")};`,
    `export { hostCore } from ${source("lib", "provider-host", "instance.ts")};`,
    `export { providerTextScrub } from ${source("lib", "db", "operations", "provider-text.ts")};`,
    `export { errorKind, errorOutcome } from ${source("lib", "db", "error-record.ts")};`,
    `export { QueryCancelledError, QueryError, StudioTimeoutRefusal } from ${source("lib", "db", "errors.ts")};`,
    "",
  ]);
});

afterEach(() => {
  boot.forgetHostCore();
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const connection = (queryTimeout?: number) =>
  ({
    id: randomUUID(),
    name: "c",
    type: "postgres",
    host: "db.internal",
    createdAt: new Date(0),
    ...(queryTimeout === undefined ? {} : { queryTimeout }),
  }) as DatabaseConnection;

/** A provider whose `query` answers `answer`, or throws it, with the limiter's rule as a SQL provider applies it. */
function provider(answer: QueryResult | Error, queryTimeout?: number): DatabaseProvider {
  return Object.assign(createMockProvider({ config: connection(queryTimeout) }), {
    prepareQuery: mock(
      (sql: string, options: QueryPrepareOptions = {}): PreparedQuery => ({
        query: sql,
        wasLimited: false,
        limit: options.limit ?? 500,
        offset: options.offset ?? 0,
      }),
    ),
    query: mock(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    cancelQuery: mock(async () => true),
  });
}

const oneRow: QueryResult = { rows: [{ n: 1 }], fields: ["n"], rowCount: 1, executionTime: 1 };

const runOf = (signal: AbortSignal = new AbortController().signal) => ({
  statement: "SELECT n FROM t",
  options: { limit: 10 },
  queryId: randomUUID(),
  signal,
  route: "test",
  scrub: route.providerTextScrub(connection(), "any"),
});

describe("one host core across two bundles", () => {
  test("the two bundles hold two copies of Studio's errors, as instrumentation and a route do", () => {
    expect(boot.QueryCancelledError).not.toBe(route.QueryCancelledError);
    expect(new boot.QueryCancelledError("x")).not.toBeInstanceOf(route.QueryCancelledError);
    expect(new route.StudioTimeoutRefusal("x")).not.toBeInstanceOf(boot.StudioTimeoutRefusal);
  });

  test("a route runs the host core instrumentation installed, and builds none of its own", async () => {
    const installed = boot.boot();
    expect(route.hostCore()).toBe(installed);

    // The installed core, replaced by one that counts its calls: the route's facade reaches only what is installed.
    boot.forgetHostCore();
    const { executeCall, cancelCall } = installed;
    const calls: string[] = [];
    boot.installHostCore(
      Object.freeze({
        executeCall: (...args: never[]) => {
          calls.push("execute");
          return executeCall(...args);
        },
        cancelCall: (...args: never[]) => {
          calls.push("cancel");
          return cancelCall(...args);
        },
      }),
      "test",
    );
    const answered = await route.runEditorQuery(provider(oneRow), runOf());
    await route.cancelEditorRun(provider(oneRow), randomUUID(), new AbortController().signal, "test");

    expect(answered.body.rows).toEqual([{ n: 1 }]);
    expect(calls).toEqual(["execute", "cancel"]);
  });

  test("a refusal the host core answers as a record becomes the route bundle's own class", async () => {
    boot.boot();
    const gone = new AbortController();
    gone.abort(new DOMException("The request went away.", "AbortError"));

    const [pastDeadline, callerGone] = await Promise.all([
      route.runEditorQuery(provider(oneRow, -70_000), runOf()).catch((error: unknown) => error),
      route.runEditorQuery(provider(oneRow), runOf(gone.signal)).catch((error: unknown) => error),
    ]);

    expect(pastDeadline).toBeInstanceOf(route.StudioTimeoutRefusal);
    expect(pastDeadline).not.toBeInstanceOf(boot.StudioTimeoutRefusal);
    expect(route.errorKind(pastDeadline)).toBe("studio-timeout-refusal");
    expect(route.errorOutcome(pastDeadline)).toBe("not-sent");
    expect(callerGone).toBeInstanceOf(route.QueryCancelledError);
    expect(callerGone).not.toBeInstanceOf(boot.QueryCancelledError);
    expect(route.errorKind(callerGone)).toBe("cancelled");
    expect(route.errorOutcome(callerGone)).toBe("not-sent");
  });

  test("a provider error the route bundle built passes through the host core by reference", async () => {
    boot.boot();
    const failure = new route.QueryError(`relation ${randomUUID()} does not exist`);

    const caught = await route.runEditorQuery(provider(failure), runOf()).catch((error: unknown) => error);

    expect(caught).toBe(failure);
    expect(caught).toBeInstanceOf(route.QueryError);
    expect(caught).not.toBeInstanceOf(boot.QueryError);
  });
});
