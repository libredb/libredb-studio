/**
 * The committed Oxia descriptor is exactly what the generator makes of the vendored protos (SB1-1.4): Oxia's
 * client.proto at v0.16.10 and the gRPC health service's health.proto.
 *
 * `src/lib/db/providers/keyvalue/oxia/proto/descriptor.ts` is a generated artifact: the gRPC adapter hands it to
 * `@grpc/proto-loader`'s `fromJSON`, so the client reads no `.proto` file at run time. This file regenerates it in
 * memory and requires the committed bytes to match, reads the committed module as a file to check its shape, imports
 * it once to prove it is the regenerated descriptor, and loads the regenerated descriptor through `fromJSON` to prove
 * its two services and 14 RPCs. It runs the generator's command in node child processes that write with `--out` into
 * a temporary directory and never into the tree. The vendored files are held to the digests `proto/README.md` records.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fromJSON, type PackageDefinition } from "@grpc/proto-loader";
import ts from "typescript";
import { OXIA_DESCRIPTOR } from "@/lib/db/providers/keyvalue/oxia/proto/descriptor";
import {
  descriptorOutputFile,
  loadOxiaDescriptor,
  OXIA_DESCRIPTOR_FILE,
  OXIA_PROTO_DIR,
  renderOxiaDescriptor,
  wroteLine,
} from "../../../../scripts/generate-oxia-descriptor.mjs";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const GENERATOR = path.join(ROOT, "scripts", "generate-oxia-descriptor.mjs");
const PROTO_DIR = path.join(ROOT, "src", "lib", "db", "providers", "keyvalue", "oxia", "proto");

/** The commit Oxia's annotated tag v0.16.10 points at (SB1-1.1, SB1-13 D7). */
const OXIA_COMMIT = "c72b0bfce3fa0058fe200462b64f0d502dd56b02";
/** The annotated tag object itself, which the research called a commit (SB1-13 D7). */
const OXIA_TAG_OBJECT = "22ad8b8867c5a0a764937fb016eaac27739e3de9";
/** The last grpc/grpc-proto commit that touched health.proto; that repository has no tags. */
const GRPC_PROTO_COMMIT = "2eb777aba6593c31e21f7f69a163486bdc793501";

/** The two protos, each upstream's LICENSE, and Oxia's NOTICE. */
const VENDORED_FILES = ["LICENSE", "NOTICE", "client.proto", "grpc/LICENSE", "grpc/health/v1/health.proto"];

/** Where each vendored file comes from in its upstream repository. */
const UPSTREAM_PATHS: Readonly<Record<string, string>> = {
  "client.proto": "common/proto/client.proto",
  LICENSE: "LICENSE",
  NOTICE: "NOTICE",
  "grpc/health/v1/health.proto": "grpc/health/v1/health.proto",
  "grpc/LICENSE": "LICENSE",
};

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

function loadPackageDefinition(): PackageDefinition {
  return fromJSON(loadOxiaDescriptor(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
}

function servicesOf(definition: PackageDefinition): Record<string, string[]> {
  const services: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(definition)) {
    if (!("format" in value)) services[name] = Object.keys(value);
  }
  return services;
}

interface MessageDefinition {
  readonly type: { readonly field: ReadonlyArray<{ readonly name: string }> };
}

function fieldNames(message: string): string[] {
  const definition = loadPackageDefinition()[message] as unknown as MessageDefinition;
  return definition.type.field.map((field) => field.name);
}

interface ReadmeRow {
  readonly upstream: string;
  readonly sha256: string;
}

function readmeDigests(): Map<string, ReadmeRow> {
  const rows = new Map<string, ReadmeRow>();
  const readme = readFileSync(path.join(PROTO_DIR, "README.md"), "utf8");
  for (const match of readme.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)) {
    rows.set(match[1] as string, { upstream: match[2] as string, sha256: match[3] as string });
  }
  return rows;
}

function parseDescriptorExport() {
  const text = readFileSync(OXIA_DESCRIPTOR_FILE, "utf8");
  const source = ts.createSourceFile(OXIA_DESCRIPTOR_FILE, text, ts.ScriptTarget.Latest, true);
  const [importStatement, statement, ...rest] = source.statements;
  if (!importStatement || !ts.isImportDeclaration(importStatement))
    throw new Error("the first statement is not an import");
  if (!statement || !ts.isVariableStatement(statement)) throw new Error("the second statement is not a variable");
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer || !ts.isAsExpression(initializer)) throw new Error("OXIA_DESCRIPTOR is not a type assertion");
  return { text, source, importStatement, statement, initializer, rest };
}

describe("Oxia descriptor generation", () => {
  test("the generator writes the committed descriptor in the vendored proto directory", () => {
    expect(OXIA_PROTO_DIR).toBe(PROTO_DIR);
    expect(OXIA_DESCRIPTOR_FILE).toBe(path.join(PROTO_DIR, "descriptor.ts"));
  });

  test("the committed descriptor is byte-identical to a fresh generation", () => {
    const generated = renderOxiaDescriptor(loadOxiaDescriptor());
    expect(readFileSync(OXIA_DESCRIPTOR_FILE).equals(Buffer.from(generated, "utf8"))).toBe(true);
  });

  test("a node process that loads nothing but the generator produces the same bytes", () => {
    // This file imports @grpc/proto-loader itself, so only a process of its own shows that the generator's own
    // import of proto-loader is there and that it reads the protos with nothing else loaded.
    const child = Bun.spawnSync(
      [
        "node",
        "--input-type=module",
        "-e",
        `import { loadOxiaDescriptor, renderOxiaDescriptor } from ${JSON.stringify(pathToFileURL(GENERATOR).href)};` +
          " process.stdout.write(renderOxiaDescriptor(loadOxiaDescriptor()));",
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.equals(readFileSync(OXIA_DESCRIPTOR_FILE))).toBe(true);
  });

  test("the header says the file is generated, and by what", () => {
    const [first] = readFileSync(OXIA_DESCRIPTOR_FILE, "utf8").split("\n");
    expect(first).toBe("// GENERATED FILE - do not edit. Run: node scripts/generate-oxia-descriptor.mjs");
  });

  test("the module exports exactly OXIA_DESCRIPTOR, asserted to fromJSON's parameter through a type-only import", () => {
    const { source, importStatement, statement, initializer, rest } = parseDescriptorExport();
    expect(rest).toHaveLength(0);
    expect(importStatement.importClause?.isTypeOnly).toBe(true);
    expect((importStatement.moduleSpecifier as ts.StringLiteral).text).toBe("@grpc/proto-loader");
    expect(statement.modifiers?.map((modifier) => modifier.kind)).toEqual([ts.SyntaxKind.ExportKeyword]);
    const declarations = statement.declarationList.declarations;
    expect(declarations.map((declaration) => declaration.name.getText(source))).toEqual(["OXIA_DESCRIPTOR"]);
    expect(declarations[0]?.type).toBeUndefined();
    expect(initializer.type.getText(source)).toBe("Parameters<typeof fromJSON>[0]");
  });

  test("the literal is the descriptor as JSON.stringify writes it, two spaces deep", () => {
    const { source, initializer } = parseDescriptorExport();
    expect(initializer.expression.getText(source)).toBe(JSON.stringify(loadOxiaDescriptor(), null, 2));
  });

  test("the literal is kept out of the formatter", () => {
    const { text, statement } = parseDescriptorExport();
    const leading = (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []).map((range) =>
      text.slice(range.pos, range.end),
    );
    expect(leading.at(-1)?.startsWith("// biome-ignore format: ")).toBe(true);
  });

  test("the imported module is the regenerated descriptor", () => {
    expect(JSON.stringify(OXIA_DESCRIPTOR)).toBe(JSON.stringify(loadOxiaDescriptor()));
  });

  test("the descriptor carries no .proto comments, and is 9,697 compact bytes", () => {
    const compact = JSON.stringify(loadOxiaDescriptor());
    expect(compact).not.toContain('"comment"');
    expect(Buffer.byteLength(compact)).toBe(9_697);
  });
});

describe("the generator's command, run by node in child processes that write only into a temporary directory", () => {
  const temporaryDirectories: string[] = [];
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  function temporaryDirectory(): string {
    const directory = mkdtempSync(path.join(tmpdir(), "oxia-descriptor-"));
    temporaryDirectories.push(directory);
    return directory;
  }
  function node(args: readonly string[], cwd: string) {
    const committed = statSync(OXIA_DESCRIPTOR_FILE).mtimeMs;
    const child = Bun.spawnSync(["node", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    expect(statSync(OXIA_DESCRIPTOR_FILE).mtimeMs).toBe(committed);
    return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  }

  test("no argument names the committed module, and --out another file resolved against cwd", () => {
    expect(descriptorOutputFile([])).toBe(OXIA_DESCRIPTOR_FILE);
    expect(descriptorOutputFile(["--out", "out/descriptor.ts"])).toBe(path.resolve("out/descriptor.ts"));
    for (const args of [
      ["--out"],
      ["--out", ""],
      ["--out", "-"],
      ["--out", "a.ts", "b.ts"],
      ["--out=a.ts"],
      ["a.ts"],
    ]) {
      expect({ args, file: descriptorOutputFile(args) }).toEqual({ args, file: undefined });
    }
  });

  test("the line it prints uses forward slashes on every platform", () => {
    expect(wroteLine(path.win32.join("C:\\work", "out", "descriptor.ts"), "C:\\work", path.win32)).toBe(
      "Wrote out/descriptor.ts",
    );
    expect(wroteLine("/work/out/descriptor.ts", "/work", path.posix)).toBe("Wrote out/descriptor.ts");
  });

  test("--out writes the committed bytes to that file and names it", () => {
    const cwd = temporaryDirectory();
    mkdirSync(path.join(cwd, "out"));
    expect(node([GENERATOR, "--out", "out/descriptor.ts"], cwd)).toEqual({
      exitCode: 0,
      stdout: "Wrote out/descriptor.ts\n",
      stderr: "",
    });
    expect(readFileSync(path.join(cwd, "out", "descriptor.ts")).equals(readFileSync(OXIA_DESCRIPTOR_FILE))).toBe(true);
  });

  test("imported, it runs no command and writes nothing", () => {
    const cwd = temporaryDirectory();
    writeFileSync(path.join(cwd, "importer.mjs"), `import ${JSON.stringify(pathToFileURL(GENERATOR).href)};\n`);
    expect(node([path.join(cwd, "importer.mjs"), "--out", "from-script.ts"], cwd)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(readdirSync(cwd)).toEqual(["importer.mjs"]);
  });

  test("any other argument list is refused with the usage line and exit code 2", () => {
    const cwd = temporaryDirectory();
    expect(node([GENERATOR, "--out"], cwd)).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "Usage: node scripts/generate-oxia-descriptor.mjs [--out <file>]\n",
    });
  });
});

describe("the regenerated descriptor, loaded as the adapter loads it", () => {
  test("two services: OxiaClient's 11 RPCs and Health's 3", () => {
    const services = servicesOf(loadPackageDefinition());
    expect(Object.keys(services).sort()).toEqual(["grpc.health.v1.Health", "io.oxia.proto.v1.OxiaClient"]);
    expect(services["io.oxia.proto.v1.OxiaClient"]).toEqual([
      "GetShardAssignments",
      "Write",
      "WriteStream",
      "Read",
      "List",
      "RangeScan",
      "GetSequenceUpdates",
      "GetNotifications",
      "CreateSession",
      "KeepAlive",
      "CloseSession",
    ]);
    expect(services["grpc.health.v1.Health"]).toEqual(["Check", "List", "Watch"]);
  });

  test("field names keep the spelling of the .proto files", () => {
    expect(fieldNames("io.oxia.proto.v1.GetRequest")).toEqual([
      "key",
      "include_value",
      "comparison_type",
      "secondary_index_name",
    ]);
    expect(fieldNames("io.oxia.proto.v1.ListRequest")).toEqual([
      "shard",
      "start_inclusive",
      "end_exclusive",
      "secondary_index_name",
      "include_internal_keys",
    ]);
  });
});

describe("the vendored proto directory", () => {
  test("holds the vendored files, the README and the descriptor, and nothing else", () => {
    expect(listFiles(PROTO_DIR)).toEqual([...VENDORED_FILES, "README.md", "descriptor.ts"].sort());
  });

  test("every vendored file matches the SHA-256 the README records for it", () => {
    const digests = readmeDigests();
    expect([...digests.keys()].sort()).toEqual([...VENDORED_FILES].sort());
    for (const file of VENDORED_FILES) {
      const actual = createHash("sha256")
        .update(readFileSync(path.join(PROTO_DIR, file)))
        .digest("hex");
      expect({ file, sha256: actual }).toEqual({ file, sha256: digests.get(file)?.sha256 as string });
    }
  });

  test("the README maps every vendored file to its upstream path", () => {
    const digests = readmeDigests();
    for (const file of VENDORED_FILES) {
      expect({ file, upstream: digests.get(file)?.upstream }).toEqual({ file, upstream: UPSTREAM_PATHS[file] });
    }
  });

  test("the README names the tag, the tag object, the commit it points at and the grpc-proto commit", () => {
    const readme = readFileSync(path.join(PROTO_DIR, "README.md"), "utf8");
    expect(readme).toContain("v0.16.10");
    expect(readme).toContain(OXIA_TAG_OBJECT);
    expect(readme).toContain(OXIA_COMMIT);
    expect(readme).toContain(GRPC_PROTO_COMMIT);
  });
});
