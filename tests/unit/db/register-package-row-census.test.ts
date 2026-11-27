/**
 * The in-repo register row census: every grant register package row whose package name is a provider package of this
 * repository (`providerPackageDirectories` in scripts/workspace-packages.mjs: `packages/provider-*` but the SDK) is
 * held equal to that package as the pack step builds it, so a change to a package's bytes fails here until its rows
 * are reviewed again and regenerated from the key command (`bun run providers:key -- --dir <artifact directory>`).
 *
 * For each such package, in the order of its first row, the census packs it twice with the pack step's own
 * `packProviders` (scripts/providers-pack.ts), into two output directories and two temporary roots, and holds the two
 * digests equal before it compares anything: a pack that is not reproducible cannot key a row. It then reads the first
 * pack with the key command's own `packageKeys` (scripts/providers-key.ts), and holds each of the package's rows to it:
 * the row's `version` to the package's package.json version, its `digest` to the pack's, and its `grammarSha256` and
 * `languageSha256` to what the key command answers for the row's engine. A row's version other than its package.json's
 * fails, so a version bump replaces the package's rows rather than adding beside them. A row of a package outside the
 * repository is not in the census, nor a row naming the SDK. Each problem names the package, the row's version and
 * engine, and the member, with both values as JSON.
 *
 * The register is the one Studio grants from, `STUDIO_GRANT_REGISTER`, read through its reader's `packageRows`; the
 * census never parses register.json itself. On today's tree the register holds legacy rows only and the repository no
 * provider package, so the first test holds no row; a planted root proves the census fails and passes. A planted
 * package lives in a planted root under the system's temporary directory, never under the repository's packages/: the
 * isolation ratchet counts any `packages/provider-<id>/` directory there as an engine. Its build is a fixed script run
 * by Node.js on PATH, with built-ins only, so the planted root needs no node_modules.
 *
 * Platforms: paths are real paths (`fs.realpathSync.native`), since macOS reaches the temporary directory through
 * `/var`, a link to `/private/var`; a child's output is split on `\r?\n`, since a Windows child ends its lines with
 * CRLF; no file mode is asserted, since the digest lists none (C-93). Engine ids are fixture ids of the form
 * `acme<case>`, and every digest a control row names is generated at run time.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { type GrantRegister, parseGrantRegister, type RegisterRow } from "@libredb/grant-register";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { MANIFEST_FILE_NAME } from "@/lib/provider-host/provider-artifact";
import { generatedDigest, packageRow, rawManifest, withStatementLanguageData } from "../../helpers/package-catalog";
import { plantedRoot, removePlantedRoot } from "../../helpers/planted-package";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";
import { packageKeys } from "../../../scripts/providers-key";
import { type PackedPackage, packProviders } from "../../../scripts/providers-pack";
import { providerPackageDirectories, workspacePackageManifests } from "../../../scripts/workspace-packages.mjs";

const REPOSITORY_ROOT = fs.realpathSync.native(path.resolve(import.meta.dir, "..", "..", ".."));
const CENSUS_TIMEOUT_MS = 60_000;

const scratch = scratchDirectory("libredb-register-row-census-");
const roots: string[] = [];
let counter = 0;

afterAll(() => {
  removeScratch(scratch);
  for (const root of roots) removePlantedRoot(root);
});

/** What the census held and every problem it found. */
interface Census {
  /** `<name> <row version> <engine>` of each row it held, in the register's order. */
  readonly held: string[];
  readonly problems: string[];
}

/** The absolute directory of each provider package of the repository at `root`, by its package.json `name`. */
function inRepoPackages(root: string): Map<string, string> {
  const providers = new Set<string>(providerPackageDirectories(root));
  const directories = new Map<string, string>();
  for (const { directory, manifest } of workspacePackageManifests(root)) {
    if (providers.has(directory)) directories.set(manifest.name, path.join(root, ...directory.split("/")));
  }
  return directories;
}

/** The label a row's problems start with: its package name, its version and its engine. */
function rowLabel(
  row: RegisterRow & { readonly package: { readonly name: string; readonly version: string } },
): string {
  return `${row.package.name} ${row.package.version} ${row.engine}`;
}

/** Packs the package at `directory` into a fresh output under `work`; the placed package, or the problem naming why not. */
function packInto(root: string, name: string, directory: string, work: string, run: string): PackedPackage | string {
  const out = path.join(work, `out-${run}`);
  const temporaryRoot = path.join(work, `temporary-${run}`);
  fs.mkdirSync(out);
  fs.mkdirSync(temporaryRoot);
  const result = packProviders({
    repositoryRoot: root,
    out,
    packageDirectories: [directory],
    temporaryRoot,
    environment: process.env,
  });
  if (result.refusals.length > 0) return [`${name}: the pack step refused it:`, ...result.refusals].join("\n");
  const [pack] = result.packed;
  if (pack === undefined || result.packed.length !== 1) {
    throw new Error(`the pack step placed ${result.packed.length} packages for one directory without a refusal`);
  }
  return pack;
}

/**
 * The census of `register` against the provider packages of the repository at `root`, a real path, writing only under
 * `scratch`; see the module's docblock.
 */
function registerPackageRowCensus(root: string, register: GrantRegister, scratch: string): Census {
  const directories = inRepoPackages(root);
  const held: string[] = [];
  const rows = register.packageRows();
  const byPackage = new Map<string, { directory: string; rows: (typeof rows)[number][] }>();
  for (const row of rows) {
    const directory = directories.get(row.package.name);
    if (directory === undefined) continue;
    held.push(rowLabel(row));
    const entry = byPackage.get(row.package.name) ?? { directory, rows: [] };
    entry.rows.push(row);
    byPackage.set(row.package.name, entry);
  }

  const problems: string[] = [];
  for (const [name, { directory, rows: packageRows }] of byPackage) {
    const work = fs.mkdtempSync(path.join(scratch, "census-"));
    const first = packInto(root, name, directory, work, "1");
    if (typeof first === "string") {
      problems.push(first);
      continue;
    }
    const second = packInto(root, name, directory, work, "2");
    if (typeof second === "string") {
      problems.push(second);
      continue;
    }
    if (second.digest !== first.digest) {
      problems.push(`${name}: two packs of one tree in two directories gave ${first.digest} and ${second.digest}`);
      continue;
    }
    const keys = packageKeys(first.directory);
    if (typeof keys === "string") {
      problems.push(`${name}: the key command refused its pack: ${keys}`);
      continue;
    }
    for (const row of packageRows) {
      const label = rowLabel(row);
      const compare = (member: string, rowValue: string | null, packValue: string | null): void => {
        if (rowValue !== packValue) {
          problems.push(
            `${label}: ${member} is ${JSON.stringify(rowValue)}, the pack's is ${JSON.stringify(packValue)}`,
          );
        }
      };
      compare("version", row.package.version, first.version);
      compare("digest", row.package.digest, first.digest);
      const engine = keys.engines.find((declared) => declared.engine === row.engine);
      if (engine === undefined) {
        problems.push(`${label}: its pack declares no engine ${row.engine}`);
        continue;
      }
      compare("grammarSha256", row.grants.grammarSha256, engine.grammarSha256);
      compare("languageSha256", row.grants.languageSha256, engine.languageSha256);
    }
  }
  return { held, problems };
}

/** A planted root holding `files`, with the repository's workspaces and no node_modules; its real path. */
function root(files: Readonly<Record<string, string>>): string {
  const planted = fs.realpathSync.native(plantedRoot({ copy: [], workspaces: true, files, linkNodeModules: false }));
  roots.push(planted);
  return planted;
}

/** A new empty directory under the scratch root. */
function fresh(label: string): string {
  counter += 1;
  const directory = path.join(scratch, `${label}-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

const PLANTED_NAME = "@libredb/provider-acmecensus";
const PLANTED_DIRECTORY = "packages/provider-acmecensus";
const PLANTED_ENGINE = "acmecensus";

/** A package.json named `name` at `version`, whose build is `node build.mjs`. */
function packageJson(name: string, version = "1.0.0"): string {
  return `${JSON.stringify({ name, version, private: true, type: "module", scripts: { build: "node build.mjs" } }, null, 2)}\n`;
}

/** A `build.mjs` that copies `src/index.mjs` to `<outdir>/dist/index.mjs`. */
const COPYING_BUILD = [
  'import { copyFileSync, mkdirSync } from "node:fs";',
  'import path from "node:path";',
  'const outdir = process.argv[process.argv.indexOf("--outdir") + 1];',
  'mkdirSync(path.join(outdir, "dist"), { recursive: true });',
  'copyFileSync(path.join("src", "index.mjs"), path.join(outdir, "dist", "index.mjs"));',
  "",
].join("\n");

/** A `build.mjs` that writes an entry exporting a new UUID on every build: a pack that is not reproducible. */
const RANDOM_BUILD = [
  'import { randomUUID } from "node:crypto";',
  'import { mkdirSync, writeFileSync } from "node:fs";',
  'import path from "node:path";',
  'const outdir = process.argv[process.argv.indexOf("--outdir") + 1];',
  'mkdirSync(path.join(outdir, "dist"), { recursive: true });',
  'writeFileSync(path.join(outdir, "dist", "index.mjs"), `export default "${randomUUID()}";\\n`);',
  "",
].join("\n");

/** The planted package's manifest: the SDK's minimal manifest for its engine, with statement language data. */
function plantedManifest(): ReturnType<typeof rawManifest> {
  const manifest = rawManifest(PLANTED_ENGINE);
  withStatementLanguageData(manifest.engines[0] as Parameters<typeof withStatementLanguageData>[0]);
  return manifest;
}

/** The files of the planted package and of the SDK's control directory, by path relative to the planted root. */
function plantedFiles(): Record<string, string> {
  return {
    [`${PLANTED_DIRECTORY}/package.json`]: packageJson(PLANTED_NAME),
    [`${PLANTED_DIRECTORY}/${MANIFEST_FILE_NAME}`]: `${JSON.stringify(plantedManifest(), null, 2)}\n`,
    [`${PLANTED_DIRECTORY}/build.mjs`]: COPYING_BUILD,
    [`${PLANTED_DIRECTORY}/src/index.mjs`]: "export default 1;\n",
    "packages/provider-sdk/package.json": packageJson("@libredb/provider-sdk"),
  };
}

/** Rows the census passes over: one naming the SDK, one naming a package outside the repository. */
function controlRows(): RegisterRow[] {
  return [
    packageRow({ name: "@libredb/provider-sdk", version: "1.0.0", digest: generatedDigest() }, PLANTED_ENGINE),
    packageRow({ name: "@acme/provider-elsewhere", version: "1.0.0", digest: generatedDigest() }, PLANTED_ENGINE),
  ];
}

/** The keys the key command prints for the package at `directory` of `root`, packed once, as a row author reads them. */
function printedKeys(
  root: string,
  directory: string,
): {
  package: { name: string; version: string; digest: string };
  engines: { engine: string; grammarSha256: string | null; languageSha256: string | null }[];
} {
  const out = fresh("key-out");
  const temporaryRoot = fresh("key-temporary");
  const result = packProviders({
    repositoryRoot: root,
    out,
    packageDirectories: [directory],
    temporaryRoot,
    environment: process.env,
  });
  expect(result.refusals).toEqual([]);
  const [pack] = result.packed;
  if (pack === undefined) throw new Error("the pack step placed nothing without a refusal");
  const run = Bun.spawnSync([process.execPath, "run", "--silent", "providers:key", "--", "--dir", pack.directory], {
    cwd: REPOSITORY_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
  return JSON.parse(run.stdout.toString());
}

/** The rows of the package at `directory` of `root`, regenerated from the key command's printed keys. */
function keyRows(root: string, directory: string): RegisterRow[] {
  const keys = printedKeys(root, directory);
  return keys.engines.map((engine) =>
    packageRow(keys.package, engine.engine, {
      grammarSha256: engine.grammarSha256,
      languageSha256: engine.languageSha256,
    }),
  );
}

/** The census of `rows` and the control rows against the planted root `root`. */
function census(root: string, rows: readonly RegisterRow[]): Census {
  return registerPackageRowCensus(root, parseGrantRegister([...rows, ...controlRows()], []), fresh("census"));
}

/** Rewrites the planted file `relative` of `root` by `edit`. */
function edit(root: string, relative: string, change: (text: string) => string): void {
  const file = path.join(root, ...relative.split("/"));
  fs.writeFileSync(file, change(fs.readFileSync(file, "utf8")));
}

/** The members of the planted engine a case edits, as the planted manifest holds them. */
interface PlantedEngine {
  readonly sqlText: { readonly grammar: Record<string, unknown> };
  readonly statementLanguageData: { readonly confirmation: Record<string, unknown> };
}

/** The planted manifest of `root` with `change` applied to its one engine. */
function editEngine(root: string, change: (engine: PlantedEngine) => void): void {
  edit(root, `${PLANTED_DIRECTORY}/${MANIFEST_FILE_NAME}`, (text) => {
    const manifest = JSON.parse(text);
    change(manifest.engines[0]);
    return `${JSON.stringify(manifest, null, 2)}\n`;
  });
}

describe("the in-repo register row census", () => {
  test("every register package row of an in-repo package equals the keys of its pack", () => {
    const answered = registerPackageRowCensus(REPOSITORY_ROOT, STUDIO_GRANT_REGISTER, scratch);
    expect(answered.problems).toEqual([]);
    // The census holds exactly the register's package rows that name a provider package of this repository. On today's
    // tree that is none: the register holds legacy rows only and packages/ no provider package.
    const inRepo = inRepoPackages(REPOSITORY_ROOT);
    expect(answered.held).toEqual(
      STUDIO_GRANT_REGISTER.packageRows()
        .filter((row) => inRepo.has(row.package.name))
        .map(rowLabel),
    );
  });

  test(
    "a changed byte of a planted in-repo package fails the census by package and member",
    () => {
      const planted = root(plantedFiles());
      const directory = path.join(planted, ...PLANTED_DIRECTORY.split("/"));
      const label = `${PLANTED_NAME} 1.0.0 ${PLANTED_ENGINE}`;
      const member = (version: string, name: string, row: unknown, pack: unknown): string =>
        `${PLANTED_NAME} ${version} ${PLANTED_ENGINE}: ${name} is ${JSON.stringify(row)}, the pack's is ${JSON.stringify(pack)}`;

      // Fresh rows, regenerated from the key command: held, no problem; the two control rows are passed over.
      let rows = keyRows(planted, directory);
      expect(rows).toHaveLength(1);
      expect(census(planted, rows)).toEqual({ held: [label], problems: [] });

      // One byte of the entry's source.
      const before = printedKeys(planted, directory);
      edit(planted, `${PLANTED_DIRECTORY}/src/index.mjs`, (text) => text.replace("1", "2"));
      let after = printedKeys(planted, directory);
      expect(after.package.digest).not.toBe(before.package.digest);
      expect(census(planted, rows).problems).toEqual([
        member("1.0.0", "digest", before.package.digest, after.package.digest),
      ]);
      rows = keyRows(planted, directory);
      expect(census(planted, rows).problems).toEqual([]);

      // One byte of the grammar.
      let previous = after;
      editEngine(planted, (engine) => {
        engine.sqlText.grammar.dollarTags = false;
      });
      after = printedKeys(planted, directory);
      expect(census(planted, rows).problems).toEqual([
        member("1.0.0", "digest", previous.package.digest, after.package.digest),
        member("1.0.0", "grammarSha256", rows[0]?.grants.grammarSha256, after.engines[0]?.grammarSha256),
      ]);
      rows = keyRows(planted, directory);
      expect(census(planted, rows).problems).toEqual([]);

      // One byte of the statement language data.
      previous = after;
      editEngine(planted, (engine) => {
        engine.statementLanguageData.confirmation.maxTextBytes = 4097;
      });
      after = printedKeys(planted, directory);
      expect(census(planted, rows).problems).toEqual([
        member("1.0.0", "digest", previous.package.digest, after.package.digest),
        member("1.0.0", "languageSha256", rows[0]?.grants.languageSha256, after.engines[0]?.languageSha256),
      ]);
      rows = keyRows(planted, directory);
      expect(census(planted, rows).problems).toEqual([]);

      // The package's version, its rows not updated: named under the row's version.
      previous = after;
      edit(planted, `${PLANTED_DIRECTORY}/package.json`, () => packageJson(PLANTED_NAME, "1.0.1"));
      after = printedKeys(planted, directory);
      expect(census(planted, rows).problems).toEqual([
        member("1.0.0", "version", "1.0.0", "1.0.1"),
        member("1.0.0", "digest", previous.package.digest, after.package.digest),
      ]);
      rows = keyRows(planted, directory);
      expect(census(planted, rows)).toEqual({ held: [`${PLANTED_NAME} 1.0.1 ${PLANTED_ENGINE}`], problems: [] });

      // A row of an engine the manifest does not declare, under the package's right key.
      const [row] = rows;
      if (row === undefined || !("package" in row)) throw new Error("the regenerated row is not a package row");
      expect(census(planted, [...rows, packageRow(row.package, "acmecensusb")]).problems).toEqual([
        `${PLANTED_NAME} 1.0.1 acmecensusb: its pack declares no engine acmecensusb`,
      ]);

      // A package the pack step refuses fails by package, its rows not compared: a build that exits 3 after printing a
      // marker generated at run time.
      const marker = randomUUID();
      const failingName = "@libredb/provider-acmefailing";
      const failingDirectory = "packages/provider-acmefailing";
      const failing = root({
        [`${failingDirectory}/package.json`]: packageJson(failingName),
        [`${failingDirectory}/${MANIFEST_FILE_NAME}`]: `${JSON.stringify(plantedManifest(), null, 2)}\n`,
        [`${failingDirectory}/build.mjs`]: `console.log(${JSON.stringify(marker)});\nprocess.exit(3);\n`,
      });
      const failingPath = path.join(failing, ...failingDirectory.split("/"));
      const failingRow = packageRow({ name: failingName, version: "1.0.0", digest: generatedDigest() }, PLANTED_ENGINE);
      // What the build printed follows the pack step's sentence as it printed it, with `bun run`'s own closing line, and
      // a Windows child ends its lines with CRLF, so only the marker is looked for there.
      const refused = census(failing, [failingRow]).problems;
      expect(refused).toHaveLength(1);
      const lines = (refused[0] ?? "").split(/\r?\n/);
      expect(lines.slice(0, 2)).toEqual([
        `${failingName}: the pack step refused it:`,
        `providers:pack: ${failingPath}: its build exited 3, and printed:`,
      ]);
      expect(lines).toContain(marker);
      expect(lines.at(-1)).toBe(`providers:pack: ${failingPath}: wrote nothing for this package`);

      // A package the key command refuses fails by package too: a manifest the pack step accepts, since it runs no
      // validator, and the SDK's validator refuses. The sentence is the key command's own, answered on a pack of it.
      const bareName = "@libredb/provider-acmebare";
      const bareDirectory = "packages/provider-acmebare";
      const bare = root({
        [`${bareDirectory}/package.json`]: packageJson(bareName),
        [`${bareDirectory}/${MANIFEST_FILE_NAME}`]: `${JSON.stringify({ engines: [{ id: "acmebare" }], runtime: { entry: "dist/index.mjs" } }, null, 2)}\n`,
        [`${bareDirectory}/build.mjs`]: COPYING_BUILD,
        [`${bareDirectory}/src/index.mjs`]: "export default 1;\n",
      });
      const barePath = path.join(bare, ...bareDirectory.split("/"));
      const barePack = packProviders({
        repositoryRoot: bare,
        out: fresh("bare-out"),
        packageDirectories: [barePath],
        temporaryRoot: fresh("bare-temporary"),
        environment: process.env,
      });
      expect(barePack.refusals).toEqual([]);
      const [bareArtifact] = barePack.packed;
      if (bareArtifact === undefined) throw new Error("the pack step placed nothing without a refusal");
      const sentence = packageKeys(bareArtifact.directory);
      if (typeof sentence !== "string") throw new Error("the key command keyed a manifest the validator refuses");
      const bareRow = packageRow({ name: bareName, version: "1.0.0", digest: generatedDigest() }, "acmebare");
      expect(census(bare, [bareRow]).problems).toEqual([`${bareName}: the key command refused its pack: ${sentence}`]);
    },
    CENSUS_TIMEOUT_MS,
  );

  test(
    "two packs of one tree in two directories give one digest",
    () => {
      const planted = root(plantedFiles());
      const directory = path.join(planted, ...PLANTED_DIRECTORY.split("/"));
      const digests = ["one", "two"].map((label) => {
        const result = packProviders({
          repositoryRoot: planted,
          out: fresh(`${label}-out`),
          packageDirectories: [directory],
          temporaryRoot: fresh(`${label}-temporary`),
          environment: process.env,
        });
        expect(result.refusals).toEqual([]);
        return result.packed[0]?.digest;
      });
      expect(digests[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(digests[1]).toBe(digests[0] as string);
      expect(census(planted, keyRows(planted, directory)).problems).toEqual([]);

      // A build whose output differs on every run: one problem naming both digests, and no member compared, though
      // its row's digest matches neither.
      edit(planted, `${PLANTED_DIRECTORY}/build.mjs`, () => RANDOM_BUILD);
      const row = packageRow({ name: PLANTED_NAME, version: "1.0.0", digest: generatedDigest() }, PLANTED_ENGINE);
      const { problems } = census(planted, [row]);
      expect(problems).toHaveLength(1);
      const match =
        /^(\S+): two packs of one tree in two directories gave (sha256:[0-9a-f]{64}) and (sha256:[0-9a-f]{64})$/.exec(
          problems[0] ?? "",
        );
      expect(match?.[1]).toBe(PLANTED_NAME);
      expect(match?.[2]).not.toBe(match?.[3]);
    },
    CENSUS_TIMEOUT_MS,
  );
});
