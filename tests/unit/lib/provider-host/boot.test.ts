/**
 * Boot admission (src/lib/provider-host/boot.ts; docs/providers/CONTRACT.md, clause C-105): the providers lock is read
 * once per process, each package it verified is admitted in package-name order, the order the lock's read answers, one
 * at a time, under the import deadline, the catalog's set rules run over every admitted package, only the packages they
 * keep are registered, and the server's engine catalog is installed; a refused package is logged once by its sentence
 * and its engines answer as unavailable.
 * A lock that cannot be read stops the boot with exit 1 and a named line; an unset directory reads nothing.
 *
 * Every package is written by the test into a scratch directory under the system's temporary directory, each case with
 * package names and engine ids of its own, because the loader's registry has no reset; this file runs in its own
 * process (tests/run-tests.ts). The late-settle case waits on the log line its settle writes, never on a timer. Paths
 * are joined with `path.join` from the scratch directory's real path, so the case reaches the same step on every
 * platform; no case depends on file modes or links.
 */
// oxlint-disable no-await-in-loop -- each boot runs after the one before, on purpose: every case reads the process's one registry.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { admitted } from "@libredb/provider-loader";
import { MANIFEST_SCHEMA_SHA256 } from "@libredb/provider-sdk/manifest";
import {
  forgetServerCatalog,
  serverCatalogBooting,
  serverCatalogInstalled,
  serverEngine,
} from "@/lib/db/server-catalog";
import { logger } from "@/lib/logger";
import * as admission from "@/lib/provider-host/admission";
import { admitProvidersAtBoot, bootAdmission, PROVIDER_IMPORT_DEADLINE_MS } from "@/lib/provider-host/boot";
import { MANIFEST_FILE_NAME } from "@/lib/provider-host/provider-artifact";
import { forgetPackageDirectories, packagesInStack } from "@/lib/provider-host/package-directories";
import { forgetProvidersDirectory } from "@/lib/provider-host/providers-dir";
import * as providersLock from "@/lib/provider-host/providers-lock";
import {
  lockEntryOf,
  removeScratch,
  scratchDirectory,
  writeArtifact,
  writeLock,
} from "../../../helpers/provider-artifacts";
import { rawManifest } from "../../../helpers/package-catalog";

/** The banner's advice line: the channels that serve the lock command, and nothing else. */
const ADVICE =
  " Write the lock with npx @libredb/studio providers lock --dir <absolute directory>, or with libredb-studio providers lock --dir <absolute directory> in an image (bun run providers:lock -- --dir <absolute directory> in a checkout of Studio), or unset LIBREDB_PROVIDERS_DIR.";

const scratch = scratchDirectory("libredb-boot-");
let counter = 0;
const originalDirectory = process.env.LIBREDB_PROVIDERS_DIR;

afterAll(() => {
  removeScratch(scratch);
});

beforeEach(() => {
  forgetServerCatalog();
  forgetProvidersDirectory();
});

afterEach(() => {
  forgetServerCatalog();
  forgetProvidersDirectory();
  if (originalDirectory === undefined) delete process.env.LIBREDB_PROVIDERS_DIR;
  else process.env.LIBREDB_PROVIDERS_DIR = originalDirectory;
});

/** What a case writes of one package. */
interface Spec {
  /** Statements run before the record is exported, on `manifest` and `record`. */
  readonly edit?: string;
  /** The whole entry, in place of the record's. */
  readonly source?: string;
  /** A change to the manifest's one engine. */
  readonly engine?: (engine: Record<string, Record<string, unknown>>) => void;
}

/** A package of the case's own name and engine id, and the digest its lock entry pins. */
interface Written {
  readonly name: string;
  readonly id: string;
  readonly digest: string;
}

/** A new empty providers directory. */
function freshProviders(): string {
  counter += 1;
  const providers = path.join(scratch, `providers-${counter}`);
  fs.mkdirSync(providers, { recursive: true });
  return providers;
}

/** The entry module exporting a record of `manifest`. */
function entrySource(manifest: unknown, edit = ""): string {
  return [
    "const f = () => {};",
    `const manifest = ${JSON.stringify(manifest)};`,
    'const record = { contract: "0.1", manifest, impl: { open: f, close: f, health: f, console: { execute: f }, monitoring: { panel: f } } };',
    edit,
    "export default record;",
    "",
  ].join("\n");
}

/** Writes each package of `specs` into `providers` and a lock pinning every one, and answers their names. */
function writePackages(providers: string, specs: readonly Spec[]): Written[] {
  const written = specs.map((spec) => {
    counter += 1;
    const name = `acme-boot-${counter}`;
    const id = `acmeboot${counter}`;
    const manifest = rawManifest(id);
    spec.engine?.(manifest.engines[0] as Record<string, Record<string, unknown>>);
    const pkg = {
      name,
      version: "1.0.0",
      engines: [id],
      files: {
        [MANIFEST_FILE_NAME]: `${JSON.stringify(manifest, null, 2)}\n`,
        "dist/index.mjs": spec.source ?? entrySource(manifest, spec.edit),
      },
    };
    writeArtifact(providers, pkg);
    return { name, id, pkg };
  });
  const entries = written.map(({ pkg }) => lockEntryOf(providers, pkg));
  writeLock(providers, entries);
  return written.map(({ name, id }, index) => ({ name, id, digest: entries[index].digest }));
}

/** The log calls of every level, each as its message and its second argument. */
function spyLogs() {
  return {
    info: spyOn(logger, "info").mockImplementation(() => {}),
    warn: spyOn(logger, "warn").mockImplementation(() => {}),
    error: spyOn(logger, "error").mockImplementation(() => {}),
    restore() {
      this.info.mockRestore();
      this.warn.mockRestore();
      this.error.mockRestore();
    },
  };
}

/** The boot line `message` begins every package line with: its code, name and version. */
const named = (code: string, pkg: Written) => `${code}: ${pkg.name} 1.0.0: `;

/** The name the engine `id` is served under, or the kind `serverEngine` answers for an engine it does not serve. */
function servedBy(id: string): string {
  const answer = serverEngine(id);
  return answer.kind === "served" ? answer.engine.source.name : answer.kind;
}

describe("boot admission", () => {
  test("a refused package leaves Studio running without its engines, named once by code", async () => {
    const providers = freshProviders();
    const [good, tampered] = writePackages(providers, [{}, {}]) as [Written, Written];
    fs.appendFileSync(path.join(providers, tampered.name, "1.0.0", "dist", "index.mjs"), " ");
    process.env.LIBREDB_PROVIDERS_DIR = providers;
    const logs = spyLogs();
    try {
      expect(await admitProvidersAtBoot()).toBe(true);
      const lines = logs.warn.mock.calls.map(([message]) => message);
      expect(lines.filter((line) => line.includes(tampered.name))).toEqual([
        `${named("PROVIDER_DIGEST_MISMATCH", tampered)}its files differ from the digest its lock entry pins`,
      ]);
      expect(logs.warn.mock.calls.find(([message]) => message.includes(tampered.name))?.[1]).toEqual({
        route: "provider-boot",
      });
      expect(logs.info.mock.calls.filter(([message]) => message === "A provider package was admitted")).toEqual([
        [
          "A provider package was admitted",
          { route: "provider-boot", package: `${good.name} 1.0.0`, engines: good.id },
        ],
      ]);
    } finally {
      logs.restore();
    }
    expect(servedBy(good.id)).toBe(good.name);
    expect<unknown>(serverEngine(tampered.id)).toEqual({
      kind: "unavailable",
      id: tampered.id,
      codes: ["PROVIDER_DIGEST_MISMATCH"],
    });
    expect(admitted().map((entry) => entry.name)).toContain(good.name);
    expect(admitted().map((entry) => entry.name)).not.toContain(tampered.name);
  });

  test("boot hands admission Studio's held names: a package stating a query dialect Studio does not hold is refused and logged with its sentence", async () => {
    const providers = freshProviders();
    // A generated name of the dialect's form, so it is no engine id and no dialect Studio holds.
    const dialect = `x${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const [unheld] = writePackages(providers, [
      {
        engine: (engine) => {
          engine.editor.dialect = {
            name: dialect,
            offersColumnProfiling: false,
            offersCodeGeneration: false,
            offersCountQuery: false,
            offersSqlExport: false,
            historyMask: null,
          };
        },
      },
    ]) as [Written];
    process.env.LIBREDB_PROVIDERS_DIR = providers;
    const logs = spyLogs();
    try {
      expect(await admitProvidersAtBoot()).toBe(true);
      expect(logs.warn.mock.calls.filter(([message]) => message.includes(unheld.name))).toEqual([
        [
          `${named("PROVIDER_SCHEMA_INVALID", unheld)}its manifest is not one the provider contract admits: value-not-allowed at /engines/0/editor/dialect/name`,
          { route: "provider-boot" },
        ],
      ]);
    } finally {
      logs.restore();
    }
    expect<unknown>(serverEngine(unheld.id)).toEqual({
      kind: "unavailable",
      id: unheld.id,
      codes: ["PROVIDER_SCHEMA_INVALID"],
    });
  });

  test("an unreadable lock exits 1 with a named line", async () => {
    const cases: [string, (providers: string) => void, string][] = [
      [
        "a lock that is a directory",
        (p) => fs.mkdirSync(path.join(p, "providers.lock.json")),
        "the lock is not a regular file",
      ],
      [
        "a lock that is not JSON",
        (p) => fs.writeFileSync(path.join(p, "providers.lock.json"), "{"),
        "the lock is not UTF-8 JSON without a byte order mark",
      ],
      [
        "a directory that does not exist",
        (p) => fs.rmSync(p, { recursive: true }),
        "the providers directory does not exist",
      ],
    ];
    for (const [label, make, why] of cases) {
      // Each case is a process of its own: the refused boot exits, leaving its begun boot behind.
      forgetServerCatalog();
      forgetProvidersDirectory();
      const providers = freshProviders();
      make(providers);
      process.env.LIBREDB_PROVIDERS_DIR = providers;
      const exits: (number | undefined)[] = [];
      const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
        exits.push(code);
      }) as typeof process.exit);
      const banner = spyOn(console, "error").mockImplementation(() => {});
      const logs = spyLogs();
      let answer: boolean;
      let printed = "";
      try {
        answer = await admitProvidersAtBoot();
        printed = banner.mock.calls.flat().join("\n");
      } finally {
        exit.mockRestore();
        banner.mockRestore();
        logs.restore();
      }
      expect([label, answer, exits]).toEqual([label, false, [1]]);
      expect(printed).toContain("LibreDB Studio cannot start: its providers lock is invalid");
      expect(printed).toContain(`PROVIDER_LOCK_INVALID: ${path.join(providers, "providers.lock.json")}: ${why}`);
      expect(printed).toContain(ADVICE);
      expect([label, serverCatalogInstalled(), serverCatalogBooting()]).toEqual([label, false, true]);
    }
  });

  test("the refused lock's banner names only npx and the images", async () => {
    const providers = freshProviders();
    fs.writeFileSync(path.join(providers, "providers.lock.json"), "{");
    process.env.LIBREDB_PROVIDERS_DIR = providers;
    const exit = spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    const banner = spyOn(console, "error").mockImplementation(() => {});
    const logs = spyLogs();
    let printed = "";
    try {
      await admitProvidersAtBoot();
      printed = banner.mock.calls.flat().join("\n");
    } finally {
      exit.mockRestore();
      banner.mockRestore();
      logs.restore();
    }
    const lines = printed.split("\n");
    expect(lines.filter((line) => line.includes("providers lock --dir"))).toEqual([ADVICE]);
    expect(printed).not.toContain("where the package is installed");
  });

  test("admission begins the catalog's boot before it reads the providers directory, and installing the catalog ends it", async () => {
    for (const set of [false, true]) {
      forgetProvidersDirectory();
      forgetServerCatalog();
      if (set) {
        const providers = freshProviders();
        writePackages(providers, [{}]);
        process.env.LIBREDB_PROVIDERS_DIR = providers;
      } else delete process.env.LIBREDB_PROVIDERS_DIR;
      const seen: Array<readonly [string, boolean, boolean]> = [];
      const logs = spyLogs();
      // The providers directory is read once, and its read logs one line at info: the boot's state is taken there.
      logs.info.mockImplementation((message: string) => {
        if (message.includes("providers directory"))
          seen.push(["directory", serverCatalogBooting(), serverCatalogInstalled()]);
      });
      const read = spyOn(providersLock, "readProvidersLock");
      read.mockImplementation((...args: Parameters<typeof providersLock.readProvidersLock>) => {
        seen.push(["lock", serverCatalogBooting(), serverCatalogInstalled()]);
        read.mockRestore();
        return providersLock.readProvidersLock(...args);
      });
      try {
        expect([serverCatalogBooting(), serverCatalogInstalled()]).toEqual([false, false]);
        expect(await admitProvidersAtBoot()).toBe(true);
      } finally {
        read.mockRestore();
        logs.restore();
      }
      expect(seen).toEqual(
        set
          ? [
              ["directory", true, false],
              ["lock", true, false],
            ]
          : [["directory", true, false]],
      );
      expect([serverCatalogBooting(), serverCatalogInstalled()]).toEqual([false, true]);
    }
  });

  test("an unset directory admits nothing and boots", async () => {
    for (const value of [undefined, "", "   "]) {
      forgetProvidersDirectory();
      forgetServerCatalog();
      if (value === undefined) delete process.env.LIBREDB_PROVIDERS_DIR;
      else process.env.LIBREDB_PROVIDERS_DIR = value;
      const read = spyOn(providersLock, "readProvidersLock");
      const compile = spyOn(admission, "hostManifestValidator");
      const logs = spyLogs();
      try {
        expect(await admitProvidersAtBoot()).toBe(true);
        expect([read.mock.calls.length, compile.mock.calls.length]).toEqual([0, 0]);
      } finally {
        read.mockRestore();
        compile.mockRestore();
        logs.restore();
      }
      expect(serverCatalogInstalled()).toBe(true);
      expect(servedBy("postgres")).toBe("@libredb/studio");
    }
  });

  test("a package whose entry throws at import is refused with its code, its cause logged on the same line call and out of the sentence", async () => {
    const providers = freshProviders();
    const marker = `acme-marker-${randomUUID()}`;
    const [thrower] = writePackages(providers, [{ source: `throw new Error(${JSON.stringify(marker)});\n` }]) as [
      Written,
    ];
    const logs = spyLogs();
    let answer: Awaited<ReturnType<typeof bootAdmission>>;
    try {
      answer = await bootAdmission(providers, PROVIDER_IMPORT_DEADLINE_MS);
      const calls = logs.error.mock.calls.filter(([message]) => message.includes(thrower.name));
      expect(calls.length).toBe(1);
      const [message, cause, context] = calls[0] as [string, unknown, unknown];
      expect(message).toBe(`${named("PROVIDER_LOAD_FAILED", thrower)}its entry threw while it was imported`);
      expect(message).not.toContain(marker);
      expect((cause as Error).message).toBe(marker);
      expect(context).toEqual({ route: "provider-boot" });
    } finally {
      logs.restore();
    }
    if (!answer.read) throw new Error("the lock was refused");
    expect(answer.refused).toEqual([
      { name: thrower.name, version: "1.0.0", engines: [thrower.id], code: "PROVIDER_LOAD_FAILED" },
    ]);
    expect(answer.admitted).toEqual([]);
  });

  test("an import that settles after its deadline is logged once by its package and never registered", async () => {
    const providers = freshProviders();
    const [late] = writePackages(providers, [
      { edit: "await new Promise((resolve) => setTimeout(resolve, 300));" },
    ]) as [Written];
    const logs = spyLogs();
    const settled = new Promise<unknown[]>((resolve) => {
      logs.warn.mockImplementation((...args: unknown[]) => {
        if (String(args[0]).startsWith("A provider package's entry settled after its import deadline")) resolve(args);
      });
    });
    try {
      const answer = await bootAdmission(providers, 50);
      if (!answer.read) throw new Error("the lock was refused");
      expect(answer.refused.map(({ code }) => code)).toEqual(["PROVIDER_LOAD_FAILED"]);
      expect(logs.warn.mock.calls.filter(([message]) => message.includes(late.name)).length).toBe(1);
      const [message, context] = await settled;
      expect(message).toBe("A provider package's entry settled after its import deadline; the package stays refused");
      expect(context).toEqual({ route: "provider-boot", package: `${late.name} 1.0.0`, outcome: "fulfilled" });
    } finally {
      logs.restore();
    }
    expect(admitted().some((entry) => entry.name === late.name)).toBe(false);
  });

  test("packages the catalog's set rules refuse are logged with PROVIDER_CATALOG_CONFLICT and serve none of their engines", async () => {
    const providers = freshProviders();
    const alias = `acmealias${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const withAlias = (engine: Record<string, Record<string, unknown>>) => {
      engine.editor.fenceAliases = [alias];
    };
    const [first, second, quiet] = writePackages(providers, [{ engine: withAlias }, { engine: withAlias }, {}]) as [
      Written,
      Written,
      Written,
    ];
    process.env.LIBREDB_PROVIDERS_DIR = providers;
    const logs = spyLogs();
    try {
      expect(await admitProvidersAtBoot()).toBe(true);
      const lines = logs.warn.mock.calls.map(([message]) => message).filter((line) => line.includes("CATALOG"));
      expect(lines).toEqual([
        `${named("PROVIDER_CATALOG_CONFLICT", first)}it states a fence alias Studio's catalog or another package states, or one that names another engine`,
        `${named("PROVIDER_CATALOG_CONFLICT", second)}it states a fence alias Studio's catalog or another package states, or one that names another engine`,
      ]);
      expect(lines.join(" ")).not.toContain(alias);
    } finally {
      logs.restore();
    }
    for (const pkg of [first, second]) {
      expect<unknown>(serverEngine(pkg.id)).toEqual({
        kind: "unavailable",
        id: pkg.id,
        codes: ["PROVIDER_CATALOG_CONFLICT"],
      });
    }
    expect(servedBy(quiet.id)).toBe(quiet.name);
  });

  test("a package a set rule refuses is absent from the loader's registry, which names exactly the packages the catalog serves", async () => {
    const providers = freshProviders();
    const alias = `acmereg${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const withAlias = (engine: Record<string, Record<string, unknown>>) => {
      engine.editor.fenceAliases = [alias];
    };
    const [first, second, kept] = writePackages(providers, [{ engine: withAlias }, { engine: withAlias }, {}]) as [
      Written,
      Written,
      Written,
    ];
    const before = new Set(admitted().map((entry) => entry.name));
    process.env.LIBREDB_PROVIDERS_DIR = providers;
    const logs = spyLogs();
    try {
      expect(await admitProvidersAtBoot()).toBe(true);
    } finally {
      logs.restore();
    }
    const added = admitted()
      .map((entry) => entry.name)
      .filter((name) => !before.has(name));
    expect(added).toEqual([kept.name]);
    expect([first, second].some((pkg) => added.includes(pkg.name))).toBe(false);
  });

  test("the boot's validator is compiled once from the SDK's schema module, whose digest is the SDK's", async () => {
    const providers = freshProviders();
    writePackages(providers, [{}, {}]);
    const compile = spyOn(admission, "hostManifestValidator");
    const logs = spyLogs();
    try {
      await bootAdmission(providers, PROVIDER_IMPORT_DEADLINE_MS);
      expect(compile.mock.calls.length).toBe(1);
      const [bytes] = compile.mock.calls[0] as [Uint8Array];
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(MANIFEST_SCHEMA_SHA256);
    } finally {
      compile.mockRestore();
      logs.restore();
    }
    // A lock that verifies no package compiles nothing.
    const empty = freshProviders();
    writeLock(empty, []);
    const none = spyOn(admission, "hostManifestValidator");
    try {
      await bootAdmission(empty, PROVIDER_IMPORT_DEADLINE_MS);
      expect(none.mock.calls.length).toBe(0);
    } finally {
      none.mockRestore();
    }
  });

  test("every package that passed its lock is recorded with its directory, as a path and as a file URL", async () => {
    forgetPackageDirectories();
    const empty = freshProviders();
    writeLock(empty, []);
    await bootAdmission(empty, PROVIDER_IMPORT_DEADLINE_MS);
    expect(packagesInStack(() => "")).toBeNull();

    const providers = freshProviders();
    const [kept, thrower] = writePackages(providers, [{}, { source: "throw new Error('boom');\n" }]) as [
      Written,
      Written,
    ];
    const logs = spyLogs();
    try {
      await bootAdmission(providers, PROVIDER_IMPORT_DEADLINE_MS);
    } finally {
      logs.restore();
    }
    const directoryOf = (pkg: Written) => path.join(providers, pkg.name, "1.0.0");
    const frame = (file: string) => `Error: boom\n    at <anonymous> (${file}:1:7)`;
    // A package refused after its import has run its top level, so it is recorded too.
    expect(packagesInStack(() => frame(path.join(directoryOf(thrower), "dist", "index.mjs")))).toEqual([
      `${thrower.name} 1.0.0`,
    ]);
    expect(packagesInStack(() => frame(`${pathToFileURL(directoryOf(kept)).href}/dist/index.mjs`))).toEqual([
      `${kept.name} 1.0.0`,
    ]);
    // A sibling directory whose name starts with the package's is not the package's.
    expect(packagesInStack(() => frame(`${directoryOf(kept)}0${path.sep}x.mjs`))).toEqual([]);
    forgetPackageDirectories();
  });

  test("an admitted package's engine record carries its lock entry's verified digest", async () => {
    const providers = freshProviders();
    const [only] = writePackages(providers, [{}]) as [Written];
    process.env.LIBREDB_PROVIDERS_DIR = providers;
    const logs = spyLogs();
    try {
      expect(await admitProvidersAtBoot()).toBe(true);
    } finally {
      logs.restore();
    }
    const answer = serverEngine(only.id);
    if (answer.kind !== "served") throw new Error(`${only.id} answered ${answer.kind}`);
    expect(only.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect([answer.engine.source.digest, answer.engine.source.package?.digest]).toEqual([only.digest, only.digest]);
    // A legacy engine's record carries no digest: its source is Studio's own code, not a package.
    const legacy = serverEngine("postgres");
    if (legacy.kind !== "served") throw new Error(`postgres answered ${legacy.kind}`);
    expect(legacy.engine.source.digest).toBeNull();
  });

  test("admission runs once per process: a second call reads nothing and keeps the installed catalog", async () => {
    const providers = freshProviders();
    const [only] = writePackages(providers, [{}]) as [Written];
    process.env.LIBREDB_PROVIDERS_DIR = providers;
    const read = spyOn(providersLock, "readProvidersLock");
    const logs = spyLogs();
    try {
      expect(await admitProvidersAtBoot()).toBe(true);
      expect(await admitProvidersAtBoot()).toBe(true);
      expect(read.mock.calls.length).toBe(1);
    } finally {
      read.mockRestore();
      logs.restore();
    }
    expect(servedBy(only.id)).toBe(only.name);
  });

  test("each package is admitted under the 10 s import deadline, in lock order, one after another", async () => {
    const providers = freshProviders();
    const packages = writePackages(providers, [{}, {}, {}]);
    const original = admission.admitPackage;
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const deadlines: number[] = [];
    const admit = spyOn(admission, "admitPackage").mockImplementation(async (pkg, options) => {
      running += 1;
      most = Math.max(most, running);
      order.push(pkg.name);
      deadlines.push(options.deadlineMs);
      try {
        return await original(pkg, options);
      } finally {
        running -= 1;
      }
    });
    const logs = spyLogs();
    try {
      await bootAdmission(providers, PROVIDER_IMPORT_DEADLINE_MS);
    } finally {
      admit.mockRestore();
      logs.restore();
    }
    expect(PROVIDER_IMPORT_DEADLINE_MS).toBe(10_000);
    expect(order).toEqual(packages.map(({ name }) => name).sort());
    expect(deadlines).toEqual([10_000, 10_000, 10_000]);
    expect(most).toBe(1);
  });
});
