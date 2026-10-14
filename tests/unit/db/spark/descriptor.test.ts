/**
 * The committed Spark Connect descriptor is exactly what the generator makes of the vendored v4.2.0 protos.
 *
 * `src/lib/db/providers/sql/spark/proto/descriptor.ts` is a generated artifact: the gRPC adapter hands it to
 * `@grpc/proto-loader`'s `fromJSON`, so the client reads no `.proto` file at run time. This file regenerates it in
 * memory and requires the committed bytes to match, reads the committed module as a file (only `grpc-client.ts`
 * imports it, which the seam guard holds), and loads the regenerated descriptor through `fromJSON` to prove its one
 * service and twelve RPCs. It runs the generator's command in node child processes that write with `--out` into a
 * temporary directory and never into the tree. The vendored files are held to the digests `proto/README.md` records.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fromJSON, type PackageDefinition } from "@grpc/proto-loader";
import ts from "typescript";
import {
  descriptorOutputFile,
  loadSparkDescriptor,
  renderSparkDescriptor,
  SPARK_DESCRIPTOR_FILE,
  SPARK_PROTO_DIR,
  wroteLine,
} from "../../../../scripts/generate-spark-descriptor.mjs";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const GENERATOR = path.join(ROOT, "scripts", "generate-spark-descriptor.mjs");
const PROTO_DIR = path.join(ROOT, "src", "lib", "db", "providers", "sql", "spark", "proto");

/** The commit apache/spark's tag v4.2.0 points at. */
const V4_2_0_COMMIT = "32f7299601108917fb01920a54e084595b7b3bf8";
const UPSTREAM_PROTO_DIR = "sql/connect/common/src/main/protobuf";

/** The ten files base.proto reaches, and Spark's LICENSE and NOTICE; example_plugins.proto is not imported, so not vendored. */
const VENDORED_FILES = [
  "LICENSE",
  "NOTICE",
  "spark/connect/base.proto",
  "spark/connect/catalog.proto",
  "spark/connect/commands.proto",
  "spark/connect/common.proto",
  "spark/connect/expressions.proto",
  "spark/connect/ml.proto",
  "spark/connect/ml_common.proto",
  "spark/connect/pipelines.proto",
  "spark/connect/relations.proto",
  "spark/connect/types.proto",
];

/** SparkConnectService at v4.2.0, in the order base.proto declares them. */
const SERVICE_RPCS = [
  "ExecutePlan",
  "AnalyzePlan",
  "Config",
  "AddArtifacts",
  "ArtifactStatus",
  "Interrupt",
  "ReattachExecute",
  "ReleaseExecute",
  "ReleaseSession",
  "FetchErrorDetails",
  "CloneSession",
  "GetStatus",
];

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

function loadPackageDefinition(): PackageDefinition {
  return fromJSON(loadSparkDescriptor(), {
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

function readmeDigests(): Map<string, { readonly upstream: string; readonly sha256: string }> {
  const rows = new Map<string, { readonly upstream: string; readonly sha256: string }>();
  const readme = readFileSync(path.join(PROTO_DIR, "README.md"), "utf8");
  for (const match of readme.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)) {
    rows.set(match[1] as string, { upstream: match[2] as string, sha256: match[3] as string });
  }
  return rows;
}

function parseDescriptorExport() {
  const text = readFileSync(SPARK_DESCRIPTOR_FILE, "utf8");
  const source = ts.createSourceFile(SPARK_DESCRIPTOR_FILE, text, ts.ScriptTarget.Latest, true);
  const [importStatement, statement, ...rest] = source.statements;
  if (!importStatement || !ts.isImportDeclaration(importStatement))
    throw new Error("the first statement is not an import");
  if (!statement || !ts.isVariableStatement(statement)) throw new Error("the second statement is not a variable");
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer || !ts.isAsExpression(initializer)) throw new Error("SPARK_DESCRIPTOR is not a type assertion");
  return { text, source, importStatement, statement, initializer, rest };
}

describe("Spark Connect descriptor generation", () => {
  test("the generator writes the committed descriptor in the vendored proto directory", () => {
    expect(SPARK_PROTO_DIR).toBe(PROTO_DIR);
    expect(SPARK_DESCRIPTOR_FILE).toBe(path.join(PROTO_DIR, "descriptor.ts"));
  });

  test("the committed descriptor is byte-identical to a fresh generation", () => {
    const generated = renderSparkDescriptor(loadSparkDescriptor());
    expect(readFileSync(SPARK_DESCRIPTOR_FILE).equals(Buffer.from(generated, "utf8"))).toBe(true);
  });

  test("a node process that loads nothing but the generator produces the same bytes", () => {
    const child = Bun.spawnSync(
      [
        "node",
        "--input-type=module",
        "-e",
        `import { loadSparkDescriptor, renderSparkDescriptor } from ${JSON.stringify(pathToFileURL(GENERATOR).href)};` +
          " process.stdout.write(renderSparkDescriptor(loadSparkDescriptor()));",
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.equals(readFileSync(SPARK_DESCRIPTOR_FILE))).toBe(true);
  });

  test("the header says the file is generated, and by what", () => {
    const [first] = readFileSync(SPARK_DESCRIPTOR_FILE, "utf8").split("\n");
    expect(first).toBe("// GENERATED FILE - do not edit. Run: node scripts/generate-spark-descriptor.mjs");
  });

  test("the module exports exactly SPARK_DESCRIPTOR, asserted to fromJSON's parameter through a type-only import", () => {
    const { source, importStatement, statement, initializer, rest } = parseDescriptorExport();
    expect(rest).toHaveLength(0);
    expect(importStatement.importClause?.isTypeOnly).toBe(true);
    expect((importStatement.moduleSpecifier as ts.StringLiteral).text).toBe("@grpc/proto-loader");
    expect(statement.modifiers?.map((modifier) => modifier.kind)).toEqual([ts.SyntaxKind.ExportKeyword]);
    const declarations = statement.declarationList.declarations;
    expect(declarations.map((declaration) => declaration.name.getText(source))).toEqual(["SPARK_DESCRIPTOR"]);
    expect(declarations[0]?.type).toBeUndefined();
    expect(initializer.type.getText(source)).toBe("Parameters<typeof fromJSON>[0]");
  });

  test("the literal is the descriptor as JSON.stringify writes it, two spaces deep", () => {
    const { source, initializer } = parseDescriptorExport();
    expect(initializer.expression.getText(source)).toBe(JSON.stringify(loadSparkDescriptor(), null, 2));
  });

  test("the literal is kept out of the formatter", () => {
    const { text, statement } = parseDescriptorExport();
    const leading = (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []).map((range) =>
      text.slice(range.pos, range.end),
    );
    expect(leading.at(-1)?.startsWith("// biome-ignore format: ")).toBe(true);
  });

  test("the descriptor carries no .proto comments", () => {
    // pipelines.proto declares a field named `comment`, so the key itself appears as a field; protobufjs writes a
    // comment as a `comment` key holding text or null, never an object.
    const commentTexts: unknown[] = [];
    const visit = (value: unknown) => {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "comment" && (child === null || typeof child !== "object")) commentTexts.push(child);
        visit(child);
      }
    };
    visit(loadSparkDescriptor());
    expect(commentTexts).toEqual([]);
    expect(JSON.stringify(loadSparkDescriptor())).toContain('"comment":{"type":"string","id":4');
  });
});

describe("the generator's command, run by node in child processes that write only into a temporary directory", () => {
  const temporaryDirectories: string[] = [];
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  function temporaryDirectory(): string {
    const directory = mkdtempSync(path.join(tmpdir(), "spark-descriptor-"));
    temporaryDirectories.push(directory);
    return directory;
  }
  function node(args: readonly string[], cwd: string) {
    const committed = statSync(SPARK_DESCRIPTOR_FILE).mtimeMs;
    const child = Bun.spawnSync(["node", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    expect(statSync(SPARK_DESCRIPTOR_FILE).mtimeMs).toBe(committed);
    return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  }

  test("no argument names the committed module, and --out another file resolved against cwd", () => {
    expect(descriptorOutputFile([])).toBe(SPARK_DESCRIPTOR_FILE);
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
    expect(readFileSync(path.join(cwd, "out", "descriptor.ts")).equals(readFileSync(SPARK_DESCRIPTOR_FILE))).toBe(true);
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
      stderr: "Usage: node scripts/generate-spark-descriptor.mjs [--out <file>]\n",
    });
  });
});

describe("the regenerated descriptor, loaded as the adapter loads it", () => {
  test("one service, SparkConnectService, with its twelve RPCs in declaration order", () => {
    const services = servicesOf(loadPackageDefinition());
    expect(Object.keys(services)).toEqual(["spark.connect.SparkConnectService"]);
    expect(services["spark.connect.SparkConnectService"]).toEqual(SERVICE_RPCS);
  });

  test("field names keep the spelling of the .proto files", () => {
    const request = loadPackageDefinition()["spark.connect.ExecutePlanRequest"] as unknown as {
      readonly type: { readonly field: ReadonlyArray<{ readonly name: string }> };
    };
    expect(request.type.field.map((field) => field.name).sort()).toEqual(
      [
        "session_id",
        "client_observed_server_side_session_id",
        "user_context",
        "operation_id",
        "plan",
        "client_type",
        "request_options",
        "tags",
      ].sort(),
    );
  });
});

describe("the vendored proto directory", () => {
  test("holds the vendored files, the README and the descriptor, and nothing else", () => {
    expect(listFiles(PROTO_DIR)).toEqual([...VENDORED_FILES, "README.md", "descriptor.ts"].sort());
  });

  test("the README names the v4.2.0 tag and the commit it points at", () => {
    const readme = readFileSync(path.join(PROTO_DIR, "README.md"), "utf8");
    expect(readme).toContain("`v4.2.0`");
    expect(readme).toContain(V4_2_0_COMMIT);
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
    for (const [file, row] of readmeDigests()) {
      expect(row.upstream).toBe(file.endsWith(".proto") ? `${UPSTREAM_PROTO_DIR}/${file}` : file);
    }
  });
});
