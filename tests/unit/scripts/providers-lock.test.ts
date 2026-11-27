/**
 * The lock command (scripts/providers-lock.ts, `bun run providers:lock -- --dir <directory>`): it writes the lock of
 * every `<name>/<version>/` artifact in a providers directory with the functions Studio's own read uses, so the lock it
 * writes is read unchanged and a later edit is refused; it refuses a directory it cannot lock and writes nothing then.
 *
 * Each case spawns the command from the repository root, as an operator runs it, under a timeout, with `--silent` so
 * that `bun run` adds no line of its own to what the command prints.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { LOCK_ENTRY_CAP, LOCK_FILE_NAME } from "@/lib/provider-host/providers-lock-format";
import { readProvidersLock } from "@/lib/provider-host/providers-lock";
import { boundedChild } from "../../helpers/bounded-node-child";
import {
  artifactDirectoryOf,
  type FixturePackage,
  lockEntryOf,
  removeScratch,
  scratchDirectory,
  writeArtifact,
} from "../../helpers/provider-artifacts";
import { moduleImports } from "../../../scripts/providers-lock";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const USAGE = "Usage: bun run providers:lock -- --dir <absolute directory>";
const scratch = scratchDirectory("libredb-providers-lock-command-");
let counter = 0;

/** What the command did in the Node child: its exit code and the lines it printed to stdout and stderr. */
interface NodeRun {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

/**
 * The command's `main` run under Node in a bounded child, over the providers directory its case names: the lines it
 * prints are collected from `console.log` and `console.error`, which are restored after the run.
 */
const nodeCommand = boundedChild({
  label: "providers-lock-node",
  imports: [{ from: path.join(REPOSITORY_ROOT, "scripts", "providers-lock.ts"), names: ["main"] }],
  runCase: (deps: { main: (argv: readonly string[]) => number }, directory: string): NodeRun => {
    const out: string[] = [];
    const err: string[] = [];
    const { log, error } = console;
    console.log = (line: string) => out.push(line);
    console.error = (line: string) => err.push(line);
    try {
      return { code: deps.main(["--dir", directory]), out, err };
    } finally {
      console.log = log;
      console.error = error;
    }
  },
  heapLimitMiB: 512,
  timeoutMs: 60_000,
});

beforeAll(async () => {
  await nodeCommand.build();
});

afterAll(() => {
  nodeCommand.remove();
  removeScratch(scratch);
});

/** A new empty providers directory under the scratch root. */
function freshProviders(): string {
  counter += 1;
  const directory = path.join(scratch, `providers-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** Runs the command with `args` from the repository root, and answers how it ended. */
function runCommand(...args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const run = Bun.spawnSync([process.execPath, "run", "--silent", "providers:lock", "--", ...args], {
    cwd: REPOSITORY_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const FOO: FixturePackage = { name: "acme-foo", version: "1.0.0", engines: ["acmefoob", "acmefooa"] };
const BAR: FixturePackage = { name: "@acme/bar", version: "2.3.4-rc.1", engines: ["acmebar"], entry: "lib/bar.js" };

/** The minimal package numbered `index`, one of many in a providers directory. */
function numbered(index: number): FixturePackage {
  const number = String(index).padStart(3, "0");
  return { name: `acme-p${number}`, version: "1.0.0", engines: [`acmep${number}`] };
}

/**
 * A package of every import form the command records and of forms it does not: only a JavaScript module file, .js, .mjs
 * or .cjs in any letter case, is scanned. A TypeScript file, a declaration file among them, is listed but not scanned:
 * admission refuses a package holding one by the listing alone.
 */
const FORMS: FixturePackage = {
  name: "acme-scanned",
  version: "1.0.0",
  engines: ["acmescanned"],
  files: {
    "dist/index.mjs": [
      'import { a } from "./a.mjs";',
      'import "node:fs";',
      'export * from "./b.mjs";',
      'export { c } from "./c.cjs";',
      'const later = () => import("./late.mjs");',
      "const tagged = () => import(`./template.mjs`);",
      'import { a as again } from "./a.mjs";',
      'const required = () => require("./a.mjs");',
      'export * as ns from "./ns.mjs";',
      'import data from "./data.json" with { type: "json" };',
      'const opted = () => import("./opt.mjs", { with: { type: "json" } });',
      "export default { a, later, tagged, again, required };",
      "",
    ].join("\n"),
    "dist/c.cjs":
      'const fs = require("fs");\nif (false) require("./dead.cjs");\nrequire.resolve("./resolved.cjs");\nrequire("./two.cjs", 0);\n',
    // A script's sloppy forms: `await` as a name and a `with` statement.
    "dist/sloppy.cjs": 'var await = 1;\nwith (Math) { require("./sloppy-dep.cjs"); }\n',
    "dist/types.ts": 'import type { T } from "./t";\nimport { v } from "./v";\nexport const w: T = v;\n',
    "dist/view.TSX": 'import "./never.mjs";\nexport const v = <div />;\n',
    "dist/types.d.ts": 'export * from "acme-typings";\nimport type { T } from "./t";\n',
    "dist/esm.D.MTS": 'export * from "acme-typings";\n',
    "dist/cjs.d.cts": 'import x = require("acme-typings");\nexport = x;\n',
    "dist/UPPER.MJS": 'import "./upper.mjs";\n',
    "bin/run.js": '#!/usr/bin/env node\nimport "./main.js";\n',
    // A leading #! line ends at any line terminator, as in Node.js: here a carriage return alone.
    "bin/cr.js": '#!/usr/bin/env node\rimport "./cr-main.js";\n',
    "dist/notes.txt": 'import "./never.mjs";\n',
    "dist/data.json": '{"import": "./never.mjs"}\n',
  },
};

/** The import record of `FORMS`. */
const FORMS_RECORD = [
  { from: "bin/cr.js", specifier: "./cr-main.js", kind: "import" },
  { from: "bin/run.js", specifier: "./main.js", kind: "import" },
  { from: "dist/UPPER.MJS", specifier: "./upper.mjs", kind: "import" },
  { from: "dist/c.cjs", specifier: "./dead.cjs", kind: "require" },
  { from: "dist/c.cjs", specifier: "./two.cjs", kind: "require" },
  { from: "dist/c.cjs", specifier: "fs", kind: "require" },
  { from: "dist/index.mjs", specifier: "./a.mjs", kind: "import" },
  { from: "dist/index.mjs", specifier: "./a.mjs", kind: "require" },
  { from: "dist/index.mjs", specifier: "./b.mjs", kind: "import" },
  { from: "dist/index.mjs", specifier: "./c.cjs", kind: "import" },
  { from: "dist/index.mjs", specifier: "./data.json", kind: "import" },
  { from: "dist/index.mjs", specifier: "./late.mjs", kind: "import" },
  { from: "dist/index.mjs", specifier: "./ns.mjs", kind: "import" },
  { from: "dist/index.mjs", specifier: "./opt.mjs", kind: "import" },
  { from: "dist/index.mjs", specifier: "./template.mjs", kind: "import" },
  { from: "dist/index.mjs", specifier: "node:fs", kind: "import" },
  { from: "dist/sloppy.cjs", specifier: "./sloppy-dep.cjs", kind: "require" },
];

describe("the lock command", () => {
  test("the lock the command writes is admitted unchanged, and a later edit to the artifact is refused", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    writeArtifact(providers, BAR);

    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    const lock = path.join(providers, LOCK_FILE_NAME);
    expect(run.stdout).toBe(
      [
        `Wrote ${lock}`,
        `@acme/bar 2.3.4-rc.1 ${lockEntryOf(providers, BAR).digest}`,
        `acme-foo 1.0.0 ${lockEntryOf(providers, FOO).digest}`,
        "",
      ].join("\n"),
    );
    const read = readProvidersLock(providers);
    expect(read.read && read.packages.map((pkg) => [pkg.name, pkg.verified])).toEqual([
      ["@acme/bar", true],
      ["acme-foo", true],
    ]);

    fs.appendFileSync(path.join(artifactDirectoryOf(providers, FOO), "dist", "index.mjs"), "// edited\n");
    const edited = readProvidersLock(providers);
    expect(
      edited.read &&
        edited.packages.map((pkg) => [pkg.name, pkg.verified ? "verified" : `${pkg.refusal.code} ${pkg.refusal.rule}`]),
    ).toEqual([
      ["@acme/bar", "verified"],
      ["acme-foo", "PROVIDER_DIGEST_MISMATCH digest-differs"],
    ]);
  });

  test("the command writes the same bytes for the same directory, entries by name and engines in order", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    writeArtifact(providers, BAR);
    expect(runCommand("--dir", providers).exitCode).toBe(0);
    const lock = path.join(providers, LOCK_FILE_NAME);
    const first = fs.readFileSync(lock, "utf8");
    expect(runCommand(`--dir=${providers}`).exitCode).toBe(0);
    expect(fs.readFileSync(lock, "utf8")).toBe(first);

    const expected = {
      lockVersion: 1,
      entries: [
        { ...lockEntryOf(providers, BAR) },
        { ...lockEntryOf(providers, FOO), engines: ["acmefooa", "acmefoob"] },
      ],
    };
    expect(first).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(fs.readdirSync(providers).sort()).toEqual(["@acme", "acme-foo", LOCK_FILE_NAME]);

    const empty = freshProviders();
    expect(runCommand("--dir", empty).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(empty, LOCK_FILE_NAME), "utf8")).toBe(
      '{\n  "lockVersion": 1,\n  "entries": []\n}\n',
    );
  });

  test("the command refuses a relative or missing --dir and any other argument with its usage and exit 2", () => {
    const providers = freshProviders();
    for (const args of [
      [],
      ["--dir"],
      ["--dir", "relative/providers"],
      ["--dir=relative"],
      ["--dir", providers, "--extra"],
      ["--other"],
      ["--dir="],
    ]) {
      const run = runCommand(...args);
      expect([args, run.exitCode, run.stdout, run.stderr]).toEqual([args, 2, "", `${USAGE}\n`]);
    }
    expect(fs.existsSync(path.join(providers, LOCK_FILE_NAME))).toBe(false);
  });

  test("the command writes nothing and exits 1 when an artifact is refused, printing every refusal", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    const linked = { name: "acme-linked", version: "1.0.0", engines: ["acmelinked"] };
    writeArtifact(providers, linked);
    fs.symlinkSync(providers, path.join(artifactDirectoryOf(providers, linked), "loop"), "junction");
    const renamed = { name: "acme-renamed", version: "1.0.0", engines: ["acmerenamed"] };
    fs.writeFileSync(
      path.join(writeArtifact(providers, renamed), "package.json"),
      JSON.stringify({ name: "acme-other", version: "1.0.0" }),
    );
    const noEntry = { name: "acme-no-entry", version: "1.0.0", engines: ["acmenoentry"] };
    fs.rmSync(path.join(writeArtifact(providers, noEntry), "dist", "index.mjs"));

    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stdout]).toEqual([1, ""]);
    expect(run.stderr).toBe(
      [
        "PROVIDER_PATH_OUTSIDE: acme-linked 1.0.0: its directory holds a symbolic link or junction, which is never followed",
        "PROVIDER_PATH_OUTSIDE: acme-no-entry 1.0.0: the entry its manifest names is not a regular file of its directory",
        "PROVIDER_IDENTITY_MISMATCH: acme-renamed 1.0.0: its package.json names another package name",
        "providers:lock wrote nothing",
        "",
      ].join("\n"),
    );
    expect(fs.existsSync(path.join(providers, LOCK_FILE_NAME))).toBe(false);

    const absent = path.join(providers, "absent");
    const missing = runCommand("--dir", absent);
    expect([missing.exitCode, missing.stdout, missing.stderr]).toEqual([
      1,
      "",
      `providers:lock: ${absent}: the providers directory does not exist\nproviders:lock wrote nothing\n`,
    ]);
  });

  test("the command refuses an entry of the directory that is neither a package nor the lock, and two versions of one package", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    writeArtifact(providers, { ...FOO, version: "1.1.0" });
    writeArtifact(providers, BAR);
    fs.writeFileSync(path.join(providers, "notes.txt"), "not a package\n");
    fs.mkdirSync(path.join(providers, "Upper", "1.0.0"), { recursive: true });
    fs.mkdirSync(path.join(providers, "acme-versionless", "latest"), { recursive: true });
    fs.writeFileSync(path.join(providers, "@acme", "loose.txt"), "");

    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stdout]).toEqual([1, ""]);
    expect(run.stderr).toBe(
      [
        `providers:lock: ${path.join("@acme", "loose.txt")}: neither a package nor the lock`,
        "providers:lock: Upper: neither a package nor the lock",
        "providers:lock: acme-foo: two versions of one package",
        `providers:lock: ${path.join("acme-versionless", "latest")}: not a version directory of the package`,
        "providers:lock: notes.txt: neither a package nor the lock",
        "providers:lock wrote nothing",
        "",
      ].join("\n"),
    );
    expect(fs.existsSync(path.join(providers, LOCK_FILE_NAME))).toBe(false);
  });

  test("a --dir that names a regular file is refused by name, exit 1, writing nothing", () => {
    // A regular file reads alike on Linux, macOS and Windows; no FIFO case, since Windows has none.
    const parent = freshProviders();
    const file = path.join(parent, "providers.txt");
    fs.writeFileSync(file, "not a directory\n");
    const run = runCommand("--dir", file);
    expect([run.exitCode, run.stdout, run.stderr]).toEqual([
      1,
      "",
      `providers:lock: ${file}: the providers directory is not a directory\nproviders:lock wrote nothing\n`,
    ]);
    expect(fs.readFileSync(file, "utf8")).toBe("not a directory\n");
    expect(fs.readdirSync(parent)).toEqual(["providers.txt"]);
  });

  test("an empty scope directory is refused by name, exit 1, writing nothing", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    fs.mkdirSync(path.join(providers, "@empty"));
    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stdout, run.stderr]).toEqual([
      1,
      "",
      "providers:lock: @empty: a scope directory holding no package\nproviders:lock wrote nothing\n",
    ]);
    expect(fs.existsSync(path.join(providers, LOCK_FILE_NAME))).toBe(false);
  });

  test("an entry of a package directory that is not a version directory is refused by name, not as two versions", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    fs.writeFileSync(path.join(providers, "acme-foo", ".DS_Store"), "");
    writeArtifact(providers, BAR);
    fs.mkdirSync(path.join(providers, "@acme", "bar", "latest"));
    writeArtifact(providers, { name: "acme-two", version: "1.0.0", engines: ["acmetwoa"] });
    writeArtifact(providers, { name: "acme-two", version: "1.1.0", engines: ["acmetwob"] });
    fs.writeFileSync(path.join(providers, "acme-two", "notes.txt"), "");
    fs.writeFileSync(path.join(providers, "notes.txt"), "");

    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stdout]).toEqual([1, ""]);
    expect(run.stderr).toBe(
      [
        `providers:lock: ${path.join("@acme", "bar", "latest")}: not a version directory of the package`,
        `providers:lock: ${path.join("acme-foo", ".DS_Store")}: not a version directory of the package`,
        `providers:lock: ${path.join("acme-two", "notes.txt")}: not a version directory of the package`,
        "providers:lock: acme-two: two versions of one package",
        "providers:lock: notes.txt: neither a package nor the lock",
        "providers:lock wrote nothing",
        "",
      ].join("\n"),
    );
    expect(fs.existsSync(path.join(providers, LOCK_FILE_NAME))).toBe(false);
  });

  test("a directory of more packages than the lock reader admits is refused by name before any lock is written", () => {
    const providers = freshProviders();
    for (let index = 0; index <= LOCK_ENTRY_CAP; index += 1) writeArtifact(providers, numbered(index));
    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stdout, run.stderr]).toEqual([
      1,
      "",
      `providers:lock: the lock would hold ${LOCK_ENTRY_CAP + 1} entries, more than the 256 Studio reads\nproviders:lock wrote nothing\n`,
    ]);
    // Neither the lock nor a temporary file of it is left.
    expect(fs.readdirSync(providers).filter((name) => name.includes(LOCK_FILE_NAME))).toEqual([]);
  });

  test("the command records every static import of each module file, sorted and once each, and Studio's read admits the lock", () => {
    const providers = freshProviders();
    writeArtifact(providers, FORMS);

    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    const lock = JSON.parse(fs.readFileSync(path.join(providers, LOCK_FILE_NAME), "utf8"));
    expect(lock.entries[0].imports).toEqual(FORMS_RECORD);
    expect(lock.entries[0]).toEqual({ ...lockEntryOf(providers, FORMS), engines: ["acmescanned"] });
    const read = readProvidersLock(providers);
    expect(read.read && read.packages.map((verified) => [verified.name, verified.verified])).toEqual([
      ["acme-scanned", true],
    ]);
  });

  test("the command refuses a module file its parser cannot read, a specifier outside its form, too many imports and a lock over its byte limit, writing nothing", () => {
    const providers = freshProviders();
    const refused: [FixturePackage, string][] = [
      [
        { name: "acme-broken", version: "1.0.0", engines: ["acmebroken"], files: { "dist/index.mjs": "import {\n" } },
        "providers:lock: acme-broken 1.0.0: dist/index.mjs: its parser cannot read it, or it is not UTF-8",
      ],
      [
        {
          name: "acme-form",
          version: "1.0.0",
          engines: ["acmeform"],
          files: { "dist/index.mjs": 'import "./a b.mjs";\n' },
        },
        "providers:lock: acme-form 1.0.0: dist/index.mjs: it imports a specifier outside printable ASCII without spaces, or longer than 1024 characters",
      ],
      [
        // An HTML-like comment is read differently by a script and a module, so the file is refused.
        {
          name: "acme-html",
          version: "1.0.0",
          engines: ["acmehtml"],
          files: { "dist/index.mjs": '<!-- a comment in a script\nimport "./a.mjs";\n' },
        },
        "providers:lock: acme-html 1.0.0: dist/index.mjs: its parser cannot read it, or it is not UTF-8",
      ],
      [
        // Nesting past the parser's stack is refused by name, never raised.
        {
          name: "acme-deep",
          version: "1.0.0",
          engines: ["acmedeep"],
          files: { "dist/index.mjs": `export default ${"(".repeat(100_000)}1${")".repeat(100_000)};\n` },
        },
        "providers:lock: acme-deep 1.0.0: dist/index.mjs: its parser cannot read it, or it is not UTF-8",
      ],
      [
        // A syntax the pinned parser does not read yet is refused, never skipped.
        {
          name: "acme-defer",
          version: "1.0.0",
          engines: ["acmedefer"],
          files: { "dist/index.mjs": 'import defer * as later from "./later.mjs";\n' },
        },
        "providers:lock: acme-defer 1.0.0: dist/index.mjs: its parser cannot read it, or it is not UTF-8",
      ],
      [
        {
          name: "acme-empty",
          version: "1.0.0",
          engines: ["acmeempty"],
          files: { "dist/index.mjs": 'export const later = () => import("");\n' },
        },
        "providers:lock: acme-empty 1.0.0: dist/index.mjs: it imports a specifier outside printable ASCII without spaces, or longer than 1024 characters",
      ],
      [
        {
          name: "acme-many",
          version: "1.0.0",
          engines: ["acmemany"],
          files: {
            "dist/index.mjs": Array.from({ length: 4097 }, (_, index) => `import "./${index}.mjs";`).join("\n"),
          },
        },
        "providers:lock: acme-many 1.0.0: its module files hold more than 4096 imports",
      ],
    ];
    for (const [pkg] of refused) writeArtifact(providers, pkg);
    const latin1 = { name: "acme-latin", version: "1.0.0", engines: ["acmelatin"] };
    fs.writeFileSync(
      path.join(writeArtifact(providers, latin1), "dist", "index.mjs"),
      Buffer.from([0x2f, 0x2f, 0xe9, 0x0a]),
    );

    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stdout]).toEqual([1, ""]);
    expect(run.stderr).toBe(
      [
        refused[0]?.[1],
        refused[3]?.[1],
        refused[4]?.[1],
        refused[5]?.[1],
        refused[1]?.[1],
        refused[2]?.[1],
        "providers:lock: acme-latin 1.0.0: dist/index.mjs: its parser cannot read it, or it is not UTF-8",
        refused[6]?.[1],
        "providers:lock wrote nothing",
        "",
      ].join("\n"),
    );
    expect(fs.existsSync(path.join(providers, LOCK_FILE_NAME))).toBe(false);

    // One package of 4,096 imports, each of a 250-character specifier, is a lock over 1 MiB.
    const large = freshProviders();
    const longName = "a".repeat(240);
    writeArtifact(large, {
      name: "acme-large",
      version: "1.0.0",
      engines: ["acmelarge"],
      files: {
        "dist/index.mjs": Array.from({ length: 4096 }, (_, index) => `import "./${longName}${index}.mjs";`).join("\n"),
      },
    });
    const over = runCommand("--dir", large);
    expect([over.exitCode, over.stdout, over.stderr]).toEqual([
      1,
      "",
      "providers:lock: the lock would be over its byte limit of 1048576 bytes\nproviders:lock wrote nothing\n",
    ]);
    expect(fs.existsSync(path.join(large, LOCK_FILE_NAME))).toBe(false);

    // A module path over 1,024 characters is refused before the file is read. macOS refuses an absolute path that long,
    // so the listing is handed to the scanner as it stands, never written to disk.
    const longPath = `${"a/".repeat(511)}abc.mjs`;
    expect(moduleImports(large, [{ path: longPath, sha256: "0".repeat(64) }])).toBe(
      "a module path is longer than 1024 characters",
    );
  });

  test("the scanner records the same imports under Node and under Bun", async () => {
    // Node's child prints lines through console; a Windows child would end them with CRLF on a pipe, so the Bun
    // command's output is split on CRLF or LF and the lock is compared as bytes, which the command writes with LF.
    const lines = (text: string) => text.split(/\r?\n/);
    const acorn = path.join(REPOSITORY_ROOT, "node_modules", "acorn", "dist");
    const providers = freshProviders();
    writeArtifact(providers, FORMS);
    writeArtifact(providers, {
      name: "acme-corpus",
      version: "1.0.0",
      engines: ["acmecorpus"],
      files: Object.fromEntries(
        ["acorn.mjs", "acorn.js", "bin.js"].map((name) => [
          `dist/corpus/${name}`,
          fs.readFileSync(path.join(acorn, name), "utf8"),
        ]),
      ),
    });
    const lock = path.join(providers, LOCK_FILE_NAME);
    const bun = runCommand("--dir", providers);
    expect([bun.exitCode, bun.stderr]).toEqual([0, ""]);
    const bunLock = fs.readFileSync(lock);
    expect(JSON.parse(bunLock.toString("utf8")).entries[1].imports).toEqual(FORMS_RECORD);
    fs.rmSync(lock);
    const node = await nodeCommand.run<NodeRun>(providers);
    expect([node.code, node.err]).toEqual([0, []]);
    expect([...node.out, ""]).toEqual(lines(bun.stdout));
    expect(fs.readFileSync(lock).equals(bunLock)).toBe(true);

    const refused = freshProviders();
    const broken: [string, string][] = [
      ["acme-broken", "import {\n"],
      ["acme-html", '<!-- a comment in a script\nimport "./a.mjs";\n'],
      ["acme-deep", `export default ${"(".repeat(100_000)}1${")".repeat(100_000)};\n`],
    ];
    for (const [name, text] of broken) {
      writeArtifact(refused, {
        name,
        version: "1.0.0",
        engines: [name.replace("-", "")],
        files: { "dist/index.mjs": text },
      });
    }
    const latin1 = { name: "acme-latin", version: "1.0.0", engines: ["acmelatin"] };
    fs.writeFileSync(
      path.join(writeArtifact(refused, latin1), "dist", "index.mjs"),
      Buffer.from([0x2f, 0x2f, 0xe9, 0x0a]),
    );
    writeArtifact(refused, FOO);
    fs.writeFileSync(path.join(refused, "acme-foo", ".DS_Store"), "");
    fs.mkdirSync(path.join(refused, "@empty"));
    const bunRefused = runCommand("--dir", refused);
    const nodeRefused = await nodeCommand.run<NodeRun>(refused);
    expect([bunRefused.exitCode, bunRefused.stdout]).toEqual([1, ""]);
    expect([nodeRefused.code, nodeRefused.out]).toEqual([1, []]);
    expect([...nodeRefused.err, ""]).toEqual(lines(bunRefused.stderr));
    expect(fs.existsSync(path.join(refused, LOCK_FILE_NAME))).toBe(false);
  }, 120_000);

  test("package.json runs the command as providers:lock", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    expect(manifest.scripts["providers:lock"]).toBe("bun scripts/providers-lock.ts");
    expect(fs.existsSync(path.join(REPOSITORY_ROOT, "scripts", "providers-lock.ts"))).toBe(true);
  });
});
