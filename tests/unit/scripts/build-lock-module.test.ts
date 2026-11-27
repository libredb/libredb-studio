/**
 * The lock command's module (scripts/build-lock-module.mjs): `build:lib` and each image's builder stage build the lock
 * command into one Node.js ES module that imports only `node:` built-ins, bundles acorn alone, carries acorn's license
 * text as its leading comment, names no engine id and runs nothing when it is imported.
 *
 * Each case builds into its own temporary directory with the function the build runs, never into the repository's
 * dist/. The Node.js cases spawn the node on PATH synchronously, with a bounded heap and a timeout, and split its output
 * on CRLF or LF, since a child's stdout ends its lines with CRLF on Windows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LOCK_FILE_NAME } from "@/lib/provider-host/providers-lock-format";
import { removeScratch, scratchDirectory, writeArtifact } from "../../helpers/provider-artifacts";
import { moduleSpecifiers } from "../../../scripts/check-lib-load.mjs";
import { namingPattern } from "../../../scripts/isolation-ratchet";
import { buildLockModule } from "../../../scripts/build-lock-module.mjs";
import { USAGE } from "../../../scripts/providers-lock";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const scratch = scratchDirectory("libredb-build-lock-module-");

/** The engine ids the isolation ratchet judges a core file by: one per committed engine declaration. */
const ENGINE_IDS = fs
  .readdirSync(path.join(REPOSITORY_ROOT, "src", "lib", "db", "engine-declarations"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length));

/** The engine ids `text` names by the isolation ratchet's naming rule. */
function namedEngineIds(text: string): string[] {
  return [...new Set([...text.matchAll(namingPattern(ENGINE_IDS))].map((match) => (match[2] ?? match[3]) as string))];
}

let built: { outfile: string; inputs: string[]; imports: string[] };

beforeAll(async () => {
  built = await buildLockModule({ root: REPOSITORY_ROOT, outfile: path.join(scratch, "module", "providers-lock.mjs") });
});

afterAll(() => {
  removeScratch(scratch);
});

/** Runs `source` as an ES module in a Node.js child, with a bounded heap and a timeout; answers how it ended. */
function runNode(source: string): { status: number | null; out: string[]; err: string } {
  const run = spawnSync("node", ["--max-old-space-size=256", "--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (run.error) throw run.error;
  return { status: run.status, out: run.stdout.split(/\r?\n/).filter(Boolean), err: run.stderr };
}

describe("the lock command's module", () => {
  test("the built lock module imports only node: built-ins, bundles acorn alone and names no engine id, and a planted import of the engine catalog is named", async () => {
    const text = fs.readFileSync(built.outfile, "utf8");
    const { specifiers, computed } = moduleSpecifiers(text, "providers-lock.mjs");
    expect(computed).toBe(0);
    expect([...new Set(specifiers)].sort()).toEqual(["node:crypto", "node:fs", "node:path"]);
    expect(built.imports).toEqual(["node:crypto", "node:fs", "node:path"]);
    const packages = built.inputs.filter((input) => input.includes("node_modules"));
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.filter((input) => !input.startsWith("node_modules/acorn/"))).toEqual([]);
    expect(built.inputs).toContain("scripts/providers-lock.ts");
    expect(text.startsWith("#!")).toBe(false);
    expect(ENGINE_IDS.length).toBeGreaterThan(0);
    expect(namedEngineIds(text)).toEqual([]);

    // Control: the same build of the type-id module, which imports the engine catalog, names engine ids.
    const control = await buildLockModule({
      root: REPOSITORY_ROOT,
      outfile: path.join(scratch, "control", "type-id.mjs"),
      entry: `export * from ${JSON.stringify(path.join(REPOSITORY_ROOT, "src", "lib", "db", "type-id.ts"))};\n`,
    });
    expect(namedEngineIds(fs.readFileSync(control.outfile, "utf8")).length).toBeGreaterThan(0);
  });

  test("the built lock module begins with acorn's license text as the installed package states it", () => {
    const acorn = path.join(REPOSITORY_ROOT, "node_modules", "acorn");
    const license = fs.readFileSync(path.join(acorn, "LICENSE"), "utf8");
    const { version, license: spdx } = JSON.parse(fs.readFileSync(path.join(acorn, "package.json"), "utf8"));
    expect(spdx).toBe("MIT");
    expect(license.startsWith("MIT License")).toBe(true);
    const text = fs.readFileSync(built.outfile, "utf8");
    expect(
      text.startsWith(
        `/*\nThis module bundles acorn ${version} (https://github.com/acornjs/acorn), under this license:\n\n${license.trimEnd()}\n*/\n`,
      ),
    ).toBe(true);
  });

  test("the build refuses by name when acorn's license file is missing", async () => {
    const root = path.join(scratch, "no-license");
    fs.mkdirSync(root, { recursive: true });
    const outfile = path.join(root, "out.mjs");
    await expect(buildLockModule({ root, outfile })).rejects.toThrow(
      `${path.join(root, "node_modules", "acorn", "LICENSE")} is missing`,
    );
    expect(fs.existsSync(outfile)).toBe(false);
  });

  test("the build refuses a package other than acorn by name", async () => {
    const outfile = path.join(scratch, "refused", "yaml.mjs");
    await expect(
      buildLockModule({ root: REPOSITORY_ROOT, outfile, entry: 'import { parse } from "yaml";\nexport { parse };\n' }),
    ).rejects.toThrow("it bundles the package yaml, and the lock module may bundle acorn alone");
    await expect(
      buildLockModule({ root: REPOSITORY_ROOT, outfile, entry: 'import fs from "fs";\nexport { fs };\n' }),
    ).rejects.toThrow("it imports fs, and the lock module may import node: built-ins alone");
    expect(fs.existsSync(outfile)).toBe(false);
  });

  test("importing the built module under Node.js runs nothing, and its main writes the bytes bun run providers:lock writes", () => {
    const url = pathToFileURL(built.outfile).href;
    const imported = runNode(
      `const lock = await import(${JSON.stringify(url)}); console.log(JSON.stringify(Object.keys(lock).sort()));`,
    );
    expect(imported).toEqual({ status: 0, out: ['["USAGE","main"]'], err: "" });
    const usage = runNode(
      `const { USAGE } = await import(${JSON.stringify(url)}); console.log(JSON.stringify(USAGE));`,
    );
    expect(usage.out).toEqual([JSON.stringify(USAGE)]);

    const providers = path.join(scratch, "providers");
    writeArtifact(providers, {
      name: "acme-probe",
      version: "1.0.0",
      engines: ["acmeprobe"],
      files: { "dist/index.mjs": 'import "node:fs";\nimport "./other.mjs";\nexport default {};\n' },
    });
    writeArtifact(providers, { name: "@acme/scoped", version: "2.0.0", engines: ["acmescoped"] });
    const lockFile = path.join(fs.realpathSync(providers), LOCK_FILE_NAME);

    const node = runNode(
      `const { main } = await import(${JSON.stringify(url)}); process.exitCode = main(["--dir", ${JSON.stringify(providers)}]);`,
    );
    expect([node.status, node.out[0], node.err]).toEqual([0, `Wrote ${lockFile}`, ""]);
    const nodeBytes = fs.readFileSync(lockFile);
    fs.rmSync(lockFile);

    const bun = spawnSync(process.execPath, ["scripts/providers-lock.ts", "--dir", providers], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect([bun.status, bun.stderr]).toEqual([0, ""]);
    expect(fs.readFileSync(lockFile).equals(nodeBytes)).toBe(true);
  });

  test("build:lib writes the lock module after tsup and the theme copy", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    expect(manifest.scripts["build:lib"]).toBe(
      "tsup && node scripts/copy-theme.mjs && node scripts/build-lock-module.mjs",
    );
  });
});
