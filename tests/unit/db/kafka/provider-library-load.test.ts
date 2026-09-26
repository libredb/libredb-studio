/**
 * A Kafka connect whose client library cannot load (issue #1088, spec 3.2; plan Task 21, finding r2-contract-1).
 *
 * `@platformatic/kafka` loads `ajv-draft-04` at import time, and `ajv-draft-04` requires `ajv/dist/core`
 * from where it is installed. A host that installs the published package with bun and holds an ajv 6 at
 * the top of its own node_modules gets `ajv-draft-04` hoisted beside that ajv 6, so the library's import
 * fails with the runtime's resolution error: no error class of this product's, and a message that carries
 * the server's paths. `connect()` refuses that instead, with a `DatabaseConfigError` naming the package.
 *
 * The resolution errors below are the runtimes' own, raised for packages no install holds: Bun's in this
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
/** An empty scope, which no package has: the form a path alias takes, such as this product's own `@/`. */
const ABSENT_ALIAS = "@/libredb-studio-absent";

/**
 * The package names the refusal reads, each with the name a runtime's import writes for it, which is the
 * package alone, where a require writes the whole specifier. Between them they hold letters of both cases,
 * digits, an underscore, a dot, a tilde and a hyphen, in a scope, first in a name and after it, and a
 * subpath with a character no name holds.
 */
const ABSENT_PACKAGES: ReadonlyArray<readonly [specifier: string, imported: string, holds: string]> = [
  [ABSENT_SUBPATH, "libredb-studio-absent-package", "a package's subpath"],
  [ABSENT_SCOPED, ABSENT_SCOPED, "a scoped package"],
  [
    "libredb-studio.absent/dist/core+esm.js",
    "libredb-studio.absent",
    "a dotted name, as lodash.merge and socket.io are, with a subpath holding a character no name holds",
  ],
  ["@libredb.studio-absent/package", "@libredb.studio-absent/package", "a dotted scope, as @a.b/c is"],
  [
    "LibreDB~Studio_Absent04/dist/core",
    "LibreDB~Studio_Absent04",
    "a name with capitals and a tilde, which npm accepted before its rules changed, an underscore and digits, a capital first",
  ],
  [
    "@LibreDB~Studio_Absent04/-libredb-studio-absent",
    "@LibreDB~Studio_Absent04/-libredb-studio-absent",
    "a scope holding those, and a name in it that starts with a hyphen",
  ],
  ["~libredb-studio-absent", "~libredb-studio-absent", "a name that starts with a tilde"],
  ["04-libredb-studio-absent", "04-libredb-studio-absent", "a name that starts with a digit"],
  ["@x/_", "@x/_", "the shortest scoped name, a one-character scope and name, here an underscore"],
];

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

type LoadForm = "require" | "import";
type NodeFailures = Readonly<Record<LoadForm, Readonly<Record<string, NodeFailure | null>>>>;

/** Every specifier Node's child loads, each by require and by import. */
const NODE_SPECIFIERS = [...ABSENT_PACKAGES.map(([specifier]) => specifier), ABSENT_ALIAS, ABSENT_FILE];

let nodeRun: NodeFailures | undefined;

/** Node's own resolution errors for the same names, raised once, in one child process. */
function nodeFailures(): NodeFailures {
  if (nodeRun !== undefined) return nodeRun;
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("No node on PATH: this test reads Node's own resolution errors; install Node 24 or later");
  }
  const script = path.join(scratch, NODE_SCRIPT);
  writeFileSync(
    script,
    [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      "const failure = async (load) => {",
      "  try { await load(); return null; } catch (error) { return { code: error.code, message: error.message }; }",
      "};",
      "const out = { require: {}, import: {} };",
      `for (const specifier of ${JSON.stringify(NODE_SPECIFIERS)}) {`,
      "  out.require[specifier] = await failure(() => require(specifier));",
      "  out.import[specifier] = await failure(() => import(specifier));",
      "}",
      "console.log(JSON.stringify(out));",
    ].join("\n"),
  );
  const run = Bun.spawnSync([node, script], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
  // Compared whole, so a child that failed shows its stderr.
  expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
  const failures: NodeFailures = JSON.parse(run.stdout.toString());
  nodeRun = failures;
  return failures;
}

/** Node's error for one load, which must have failed. */
function nodeFailure(form: LoadForm, specifier: string): NodeFailure {
  const failure = nodeFailures()[form][specifier];
  if (!failure) throw new Error(`Node's ${form} of ${specifier} did not fail`);
  return failure;
}

const asNodeError = ({ code, message }: NodeFailure) => Object.assign(new Error(message), { code });

/** The Next.js server's wrapper of an external package's load failure, as its runtime writes it. */
const wrappedByTheServer = (error: unknown) =>
  new Error(`Failed to load external module @platformatic/kafka-0123456789abcdef: ${error}`);

/** The four ways the runtimes raise a resolution error here, and which name each writes. */
const RAISED_BY: ReadonlyArray<
  readonly [runtime: string, raise: (specifier: string) => Promise<unknown>, writes: "specifier" | "package"]
> = [
  ["Bun's require", (specifier) => rejectionOf(() => localRequire(specifier)), "specifier"],
  ["Bun's import", (specifier) => rejectionOf(() => import(specifier)), "package"],
  ["Node's require", async (specifier) => asNodeError(nodeFailure("require", specifier)), "specifier"],
  ["Node's import", async (specifier) => asNodeError(nodeFailure("import", specifier)), "package"],
];

describe("a client library the installation cannot load", () => {
  test.each(ABSENT_PACKAGES)(
    "the runtimes' own resolution errors for %s: a require writes the specifier, an import the package",
    async (specifier, imported) => {
      // Each path is compared by its file name: the runtimes name the real path, which on macOS is not
      // the temporary directory's own spelling (/var is a link to /private/var).
      const nodeRequire = nodeFailure("require", specifier);
      expect(nodeRequire.code).toBe("MODULE_NOT_FOUND");
      expect(nodeRequire.message).toStartWith(`Cannot find module '${specifier}'\nRequire stack:\n- `);
      expect(nodeRequire.message).toContain(NODE_SCRIPT);
      const nodeImport = nodeFailure("import", specifier);
      expect(nodeImport.code).toBe("ERR_MODULE_NOT_FOUND");
      expect(nodeImport.message).toStartWith(`Cannot find package '${imported}' imported from `);
      expect(nodeImport.message).toContain(NODE_SCRIPT);
      const bunRequire = (await rejectionOf(() => localRequire(specifier))) as Error & { code?: string };
      expect(bunRequire).toBeInstanceOf(Error);
      expect(bunRequire.code).toBe("MODULE_NOT_FOUND");
      expect(bunRequire.message).toStartWith(`Cannot find module '${specifier}'`);
      expect(bunRequire.message).toContain(path.basename(import.meta.path));
      const bunImport = (await rejectionOf(() => import(specifier))) as Error & { code?: string };
      expect(bunImport).toBeInstanceOf(Error);
      expect(bunImport.code).toBe("ERR_MODULE_NOT_FOUND");
      expect(bunImport.message).toStartWith(`Cannot find package '${imported}' imported from `);
      expect(bunImport.message).toContain(path.basename(import.meta.path));
    },
  );

  test("the runtimes' own resolution errors for a relative file and a path alias write the name as no package's", async () => {
    // A relative import is named by the absolute path it resolved to, a relative require as written.
    const nodeImport = nodeFailure("import", ABSENT_FILE);
    expect(nodeImport.code).toBe("ERR_MODULE_NOT_FOUND");
    const named = /^Cannot find module '([^']+)' imported from /.exec(nodeImport.message)?.[1] ?? "";
    expect({ absolute: path.isAbsolute(named), file: path.basename(named) }).toEqual({
      absolute: true,
      file: path.basename(ABSENT_FILE),
    });
    expect(nodeFailure("require", ABSENT_FILE).message).toStartWith(`Cannot find module '${ABSENT_FILE}'\n`);
    const bunFile = (await rejectionOf(() => localRequire(ABSENT_FILE))) as Error;
    expect(bunFile.message).toStartWith(`Cannot find module '${ABSENT_FILE}'`);
    // An alias is written as a scoped name whose scope is empty.
    expect(nodeFailure("require", ABSENT_ALIAS).message).toStartWith(`Cannot find module '${ABSENT_ALIAS}'\n`);
    expect(nodeFailure("import", ABSENT_ALIAS).message).toStartWith(
      `Cannot find package '${ABSENT_ALIAS}' imported from `,
    );
    const bunRequire = (await rejectionOf(() => localRequire(ABSENT_ALIAS))) as Error;
    expect(bunRequire.message).toStartWith(`Cannot find module '${ABSENT_ALIAS}'`);
    const bunImport = (await rejectionOf(() => import(ABSENT_ALIAS))) as Error;
    expect(bunImport.message).toStartWith(`Cannot find package '${ABSENT_ALIAS}' imported from `);
  });

  const REFUSED: ReadonlyArray<readonly [label: string, fail: () => Promise<unknown>, specifier: string]> = [
    ...ABSENT_PACKAGES.flatMap(([specifier, imported, holds]) =>
      RAISED_BY.map(
        ([runtime, raise, writes]) =>
          [`${runtime} of ${holds}`, () => raise(specifier), writes === "specifier" ? specifier : imported] as const,
      ),
    ),
    [
      "the Next.js server's wrapper of Node's require, which keeps the text and drops the code",
      async () => wrappedByTheServer(asNodeError(nodeFailure("require", ABSENT_SUBPATH))),
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
    ["Node's require of a relative file", async () => asNodeError(nodeFailure("require", ABSENT_FILE))],
    [
      "Node's import of a relative file, which it names by its absolute path",
      async () => asNodeError(nodeFailure("import", ABSENT_FILE)),
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
    ...RAISED_BY.map(
      ([runtime, raise]) =>
        [`${runtime} of a path alias, whose empty scope no package has`, () => raise(ABSENT_ALIAS)] as const,
    ),
    ["a failure of another kind", async () => new TypeError("a defect, not a resolution")],
    ["a thrown value that is no Error, whatever its text", async () => `Cannot find module '${ABSENT_SUBPATH}'`],
    [
      "a plain object that is no Error, whatever its text and code",
      async () => ({ code: "MODULE_NOT_FOUND", message: `Cannot find module '${ABSENT_SUBPATH}'` }),
    ],
  ];
  test.each(ITSELF)(
    "%s is not read as a package the installation lacks, and surfaces as itself",
    async (_label, fail) => {
      const failure = await fail();
      const { provider } = unloadable(failure);
      expect(await rejectionOf(() => provider.connect())).toBe(failure);
      expect(provider.isConnected()).toBe(false);
    },
  );

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
