/**
 * A Kafka connect whose client library cannot load (issue #1088, spec 3.2; plan Task 21, finding r2-contract-1).
 *
 * `@platformatic/kafka` loads `ajv-draft-04` at import time, and `ajv-draft-04` requires `ajv/dist/core`
 * from where it is installed. A host that installs the published package with bun and holds an ajv 6 at
 * the top of its own node_modules gets `ajv-draft-04` hoisted beside that ajv 6, so the library's import
 * fails with the runtime's resolution error: no error class of this product's, and a message that carries
 * the server's paths. `connect()` refuses that instead, with a `DatabaseConfigError` naming the package.
 *
 * The resolution errors below are the runtimes' own, raised for a package no install holds: Bun's in this
 * process, and Node's in a child process, since Node runs the standalone server and most hosts. The
 * Next.js server wraps an external package's load failure in an Error of its own, whose text is written
 * here as its runtime writes it (`externalImport` in the `[turbopack]_runtime.js` a build emits). No
 * mock.module(): the provider constructor's `createClient` parameter is the seam.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import type { KafkaReadClient } from "@/lib/db/providers/stream/kafka/client";
import type { DatabaseConnection } from "@/lib/types";

const CONNECTION = {
  id: "k1",
  name: "kafka",
  type: "kafka",
  host: "localhost",
  createdAt: new Date(),
} as unknown as DatabaseConnection;

/** Names no install holds, so each resolution below fails wherever the suite runs. */
const ABSENT_SUBPATH = "libredb-studio-absent-package/dist/core";
const ABSENT_SCOPED = "@libredb-studio-absent/package";
const ABSENT_FILE = "./libredb-studio-absent-file.mjs";

const refusal = (specifier: string) =>
  `The Kafka client library could not be loaded: the module "${specifier}" it requires does not resolve in this installation. See docs/providers/kafka.md section 2.5`;

/** What a call threw, synchronously or as a rejection, caught so a test can compare it by identity. */
async function rejectionOf(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** A provider whose client factory, the library's loader in production, rejects with `failure`. */
function unloadable(failure: unknown) {
  const calls: unknown[] = [];
  const provider = new KafkaProvider(CONNECTION, { queryTimeout: 1000 }, async (options) => {
    calls.push(options);
    throw failure;
  });
  return { provider, calls };
}

const localRequire = createRequire(import.meta.path);

const scratch = mkdtempSync(path.join(tmpdir(), "kafka-library-load-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const NODE_SCRIPT = "resolution-under-node.mjs";

interface NodeFailure {
  readonly code: string;
  readonly message: string;
}

/** Node's own resolution errors, raised in a child process for the same absent names. */
function nodeFailures(): Record<"require" | "scoped" | "file", NodeFailure> {
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("No node on PATH: this test reads Node's own resolution errors; install Node 24 or later");
  }
  const script = path.join(scratch, NODE_SCRIPT);
  writeFileSync(
    script,
    [
      'import { createRequire } from "node:module";',
      "const out = {};",
      "const keep = (key, error) => { out[key] = { code: error.code, message: error.message }; };",
      `try { createRequire(import.meta.url)(${JSON.stringify(ABSENT_SUBPATH)}); } catch (error) { keep("require", error); }`,
      `try { await import(${JSON.stringify(ABSENT_SCOPED)}); } catch (error) { keep("scoped", error); }`,
      `try { await import(${JSON.stringify(ABSENT_FILE)}); } catch (error) { keep("file", error); }`,
      "console.log(JSON.stringify(out));",
    ].join("\n"),
  );
  const run = Bun.spawnSync([node, script], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
  // Compared whole, so a child that failed shows its stderr.
  expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(run.stdout.toString());
}

const asNodeError = ({ code, message }: NodeFailure) => Object.assign(new Error(message), { code });

/** The Next.js server's wrapper of an external package's load failure, as its runtime writes it. */
const wrappedByTheServer = (error: unknown) =>
  new Error(`Failed to load external module @platformatic/kafka-0123456789abcdef: ${error}`);

describe("a client library the installation cannot load", () => {
  test("the resolution errors read here are the runtimes' own: Bun's and Node's name the module, then a path", async () => {
    // Each path is compared by its file name: the runtimes name the real path, which on macOS is not
    // the temporary directory's own spelling (/var is a link to /private/var).
    const node = nodeFailures();
    expect(node.require.code).toBe("MODULE_NOT_FOUND");
    expect(node.require.message).toStartWith(`Cannot find module '${ABSENT_SUBPATH}'\nRequire stack:\n- `);
    expect(node.require.message).toContain(NODE_SCRIPT);
    expect(node.scoped.code).toBe("ERR_MODULE_NOT_FOUND");
    expect(node.scoped.message).toStartWith(`Cannot find package '${ABSENT_SCOPED}' imported from `);
    expect(node.scoped.message).toContain(NODE_SCRIPT);
    // A relative import is named by the absolute path it resolved to.
    expect(node.file.code).toBe("ERR_MODULE_NOT_FOUND");
    const named = /^Cannot find module '([^']+)' imported from /.exec(node.file.message)?.[1] ?? "";
    expect({ absolute: path.isAbsolute(named), file: path.basename(named) }).toEqual({
      absolute: true,
      file: path.basename(ABSENT_FILE),
    });
    const bunRequire = (await rejectionOf(() => localRequire(ABSENT_SUBPATH))) as Error & { code?: string };
    expect(bunRequire).toBeInstanceOf(Error);
    expect(bunRequire.code).toBe("MODULE_NOT_FOUND");
    expect(bunRequire.message).toStartWith(`Cannot find module '${ABSENT_SUBPATH}'`);
    expect(bunRequire.message).toContain(path.basename(import.meta.path));
    const bunImport = (await rejectionOf(() => import(ABSENT_SCOPED))) as Error & { code?: string };
    expect(bunImport).toBeInstanceOf(Error);
    expect(bunImport.code).toBe("ERR_MODULE_NOT_FOUND");
    expect(bunImport.message).toStartWith(`Cannot find package '${ABSENT_SCOPED}' imported from `);
    expect(bunImport.message).toContain(path.basename(import.meta.path));
  });

  const REFUSED: ReadonlyArray<readonly [label: string, fail: () => Promise<unknown>, specifier: string]> = [
    ["Bun's require of a package's subpath", () => rejectionOf(() => localRequire(ABSENT_SUBPATH)), ABSENT_SUBPATH],
    ["Bun's import of a scoped package", () => rejectionOf(() => import(ABSENT_SCOPED)), ABSENT_SCOPED],
    ["Node's require of a package's subpath", async () => asNodeError(nodeFailures().require), ABSENT_SUBPATH],
    ["Node's import of a scoped package", async () => asNodeError(nodeFailures().scoped), ABSENT_SCOPED],
    [
      "the Next.js server's wrapper of Node's require, which keeps the text and drops the code",
      async () => wrappedByTheServer(asNodeError(nodeFailures().require)),
      ABSENT_SUBPATH,
    ],
  ];
  test.each(REFUSED)(
    "%s is refused as a configuration error naming the package and no path",
    async (_label, fail, specifier) => {
      const failure = await fail();
      const { provider, calls } = unloadable(failure);
      const error = await rejectionOf(() => provider.connect());
      expect(error).toBeInstanceOf(DatabaseConfigError);
      const { provider: stamped, message } = error as DatabaseConfigError;
      expect({ stamped, message }).toEqual({ stamped: "kafka", message: refusal(specifier) });
      expect(calls).toHaveLength(1);
      expect(provider.isConnected()).toBe(false);
    },
  );

  const ITSELF: ReadonlyArray<readonly [label: string, fail: () => Promise<unknown>]> = [
    ["Bun's require of a relative file", () => rejectionOf(() => localRequire(ABSENT_FILE))],
    [
      "Node's import of a relative file, which it names by its absolute path",
      async () => asNodeError(nodeFailures().file),
    ],
    [
      "Node's import of a relative file on Windows, named by a drive path",
      async () =>
        Object.assign(
          new Error("Cannot find module 'C:\\app\\node_modules\\x\\index.mjs' imported from C:\\app\\y.mjs"),
          {
            code: "ERR_MODULE_NOT_FOUND",
          },
        ),
    ],
    ["a failure of another kind", async () => new TypeError("a defect, not a resolution")],
    ["a thrown value that is no Error, whatever its text", async () => `Cannot find module '${ABSENT_SUBPATH}'`],
  ];
  test.each(ITSELF)("%s names no package the installation lacks, and surfaces as itself", async (_label, fail) => {
    const failure = await fail();
    const { provider } = unloadable(failure);
    expect(await rejectionOf(() => provider.connect())).toBe(failure);
    expect(provider.isConnected()).toBe(false);
  });

  test("a resolution error after the library loaded is the forced read's failure, not the library's, and surfaces as itself", async () => {
    const failure = await rejectionOf(() => localRequire(ABSENT_SUBPATH));
    const calls: string[] = [];
    const client = {
      metadata: async () => {
        calls.push("metadata");
        throw failure;
      },
      close: async () => {
        calls.push("close");
      },
    } as unknown as KafkaReadClient;
    const provider = new KafkaProvider(CONNECTION, { queryTimeout: 1000 }, async () => client);
    expect(await rejectionOf(() => provider.connect())).toBe(failure);
    expect(calls).toEqual(["metadata", "close"]);
    expect(provider.isConnected()).toBe(false);
  });
});
