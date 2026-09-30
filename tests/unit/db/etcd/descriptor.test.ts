/**
 * The committed etcd descriptor is exactly what the generator makes of the vendored v3.7.2 protos (spec 3.2).
 *
 * `src/lib/db/providers/keyvalue/etcd/proto/descriptor.ts` is a generated artifact: the gRPC adapter hands it to
 * `@grpc/proto-loader`'s `fromJSON`, so the client reads no `.proto` file at run time. This file regenerates it in
 * memory and requires the committed bytes to match, reads the committed module as a file (the seam guard of spec E11
 * lets only `grpc-client.ts` and its two transport tests, `grpc-client.test.ts` and `tls-handshake.test.ts`, import
 * it), and loads the regenerated descriptor through `fromJSON` to prove that it carries all 42 RPCs of `rpc.proto`
 * with the field names the `.proto` files spell. It runs the generator's command too, in node child processes that
 * write with `--out` into a temporary directory and never into the tree: directly, through a symlinked checkout, and
 * imported. The vendored files themselves are held to the digests `proto/README.md` records for them, so the
 * provenance it states cannot drift from the tree.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fromJSON, type PackageDefinition } from "@grpc/proto-loader";
import ts from "typescript";
import {
  descriptorOutputFile,
  ETCD_DESCRIPTOR_FILE,
  ETCD_PROTO_DIR,
  loadEtcdDescriptor,
  renderEtcdDescriptor,
} from "../../../../scripts/generate-etcd-descriptor.mjs";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const GENERATOR = path.join(ROOT, "scripts", "generate-etcd-descriptor.mjs");
const PROTO_DIR = path.join(ROOT, "src", "lib", "db", "providers", "keyvalue", "etcd", "proto");

/** The etcd commit the v3.7.2 tag points at (`etcd --version` prints its first seven digits, 68c065e). */
const V3_7_2_COMMIT = "68c065e562994b89e333e77b039ad066f933c586";

/** Every service and RPC of `api/etcdserverpb/rpc.proto` at v3.7.2, in declaration order: 42 RPCs. */
const RPC_PROTO_SERVICES: Readonly<Record<string, readonly string[]>> = {
  "etcdserverpb.KV": ["Range", "RangeStream", "Put", "DeleteRange", "Txn", "Compact"],
  "etcdserverpb.Watch": ["Watch"],
  "etcdserverpb.Lease": ["LeaseGrant", "LeaseRevoke", "LeaseKeepAlive", "LeaseTimeToLive", "LeaseLeases"],
  "etcdserverpb.Cluster": ["MemberAdd", "MemberRemove", "MemberUpdate", "MemberList", "MemberPromote"],
  "etcdserverpb.Maintenance": [
    "Alarm",
    "Status",
    "Defragment",
    "Hash",
    "HashKV",
    "Snapshot",
    "MoveLeader",
    "Downgrade",
  ],
  "etcdserverpb.Auth": [
    "AuthEnable",
    "AuthDisable",
    "AuthStatus",
    "Authenticate",
    "UserAdd",
    "UserGet",
    "UserList",
    "UserDelete",
    "UserChangePassword",
    "UserGrantRole",
    "UserRevokeRole",
    "RoleAdd",
    "RoleGet",
    "RoleList",
    "RoleDelete",
    "RoleGrantPermission",
    "RoleRevokePermission",
  ],
};

/** The vendored upstream files; every other file in the directory is authored here or generated. */
const VENDORED_FILES = [
  "LICENSE",
  "etcd/api/authpb/auth.proto",
  "etcd/api/etcdserverpb/rpc.proto",
  "etcd/api/mvccpb/kv.proto",
  "etcd/api/versionpb/version.proto",
];

const STUB_FILES = ["stubs/google/api/annotations.proto", "stubs/protoc-gen-openapiv2/options/annotations.proto"];

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/** The runtime's view: what `fromJSON` builds from the regenerated descriptor, with the adapter's loader options. */
function loadPackageDefinition(): PackageDefinition {
  return fromJSON(loadEtcdDescriptor(), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
}

function servicesOf(definition: PackageDefinition): Record<string, string[]> {
  const services: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(definition)) {
    // A message or enum definition carries a `format`; a service definition is a map of its methods.
    if (!("format" in value)) services[name] = Object.keys(value);
  }
  return services;
}

/** The committed module's export and its type assertion, read as a file; the shape test pins the rest. */
function parseDescriptorExport(): {
  readonly text: string;
  readonly source: ts.SourceFile;
  readonly statement: ts.VariableStatement;
  readonly initializer: ts.AsExpression;
} {
  const text = readFileSync(ETCD_DESCRIPTOR_FILE, "utf8");
  const source = ts.createSourceFile(ETCD_DESCRIPTOR_FILE, text, ts.ScriptTarget.Latest, true);
  const statement = source.statements[1];
  if (!statement || !ts.isVariableStatement(statement)) {
    throw new Error("the second statement is not a variable");
  }
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer || !ts.isAsExpression(initializer)) {
    throw new Error("ETCD_DESCRIPTOR is not a type assertion");
  }
  return { text, source, statement, initializer };
}

function readmeDigests(): Map<string, { readonly upstream: string; readonly sha256: string }> {
  const rows = new Map<string, { readonly upstream: string; readonly sha256: string }>();
  const readme = readFileSync(path.join(PROTO_DIR, "README.md"), "utf8");
  for (const match of readme.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)) {
    rows.set(match[1] as string, { upstream: match[2] as string, sha256: match[3] as string });
  }
  return rows;
}

describe("etcd descriptor generation", () => {
  test("the generator writes the committed descriptor in the vendored proto directory", () => {
    expect(ETCD_PROTO_DIR).toBe(PROTO_DIR);
    expect(ETCD_DESCRIPTOR_FILE).toBe(path.join(PROTO_DIR, "descriptor.ts"));
  });

  test("the committed descriptor is byte-identical to a fresh generation", () => {
    const generated = renderEtcdDescriptor(loadEtcdDescriptor());
    expect(readFileSync(ETCD_DESCRIPTOR_FILE, "utf8")).toBe(generated);
    expect(readFileSync(ETCD_DESCRIPTOR_FILE).equals(Buffer.from(generated, "utf8"))).toBe(true);
  });

  test("a node process that loads nothing but the generator produces the same bytes", () => {
    // This file imports @grpc/proto-loader itself, which registers descriptor.proto for the whole process, so only a
    // process of its own shows that the generator's import of proto-loader, which the CLI run depends on, is there.
    // It is the node on PATH, the runtime the header's command names (the unit test job sets up Node 24).
    const child = Bun.spawnSync(
      [
        "node",
        "--input-type=module",
        "-e",
        `import { loadEtcdDescriptor, renderEtcdDescriptor } from ${JSON.stringify(pathToFileURL(GENERATOR).href)};` +
          " process.stdout.write(renderEtcdDescriptor(loadEtcdDescriptor()));",
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.equals(readFileSync(ETCD_DESCRIPTOR_FILE))).toBe(true);
  });

  test("the header says the file is generated, and by what", () => {
    const [first] = readFileSync(ETCD_DESCRIPTOR_FILE, "utf8").split("\n");
    expect(first).toBe("// GENERATED FILE - do not edit. Run: node scripts/generate-etcd-descriptor.mjs");
  });

  test("the module exports exactly ETCD_DESCRIPTOR, asserted to fromJSON's parameter through a type-only import", () => {
    const source = ts.createSourceFile(
      ETCD_DESCRIPTOR_FILE,
      readFileSync(ETCD_DESCRIPTOR_FILE, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const [importStatement, exportStatement, ...rest] = source.statements;
    expect(rest).toHaveLength(0);

    if (!importStatement || !ts.isImportDeclaration(importStatement)) {
      throw new Error("the first statement is not an import");
    }
    expect(importStatement.importClause?.isTypeOnly).toBe(true);
    expect((importStatement.moduleSpecifier as ts.StringLiteral).text).toBe("@grpc/proto-loader");
    expect(importStatement.importClause?.name).toBeUndefined();
    const bindings = importStatement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) throw new Error("the import names no bindings");
    expect(bindings.elements.map((element) => element.getText(source))).toEqual(["fromJSON"]);

    if (!exportStatement || !ts.isVariableStatement(exportStatement)) {
      throw new Error("the second statement is not a variable");
    }
    expect(exportStatement.modifiers?.map((modifier) => modifier.kind)).toEqual([ts.SyntaxKind.ExportKeyword]);
    expect(exportStatement.declarationList.flags & ts.NodeFlags.Const).toBe(ts.NodeFlags.Const);
    const declarations = exportStatement.declarationList.declarations;
    expect(declarations.map((declaration) => declaration.name.getText(source))).toEqual(["ETCD_DESCRIPTOR"]);
    // An assertion, because protobufjs's typings reject fields its own toJSON writes; the runtime test below is the proof.
    expect(declarations[0]?.type).toBeUndefined();
    const initializer = declarations[0]?.initializer;
    if (!initializer || !ts.isAsExpression(initializer)) throw new Error("ETCD_DESCRIPTOR is not a type assertion");
    expect(initializer.type.getText(source)).toBe("Parameters<typeof fromJSON>[0]");
    expect(ts.isObjectLiteralExpression(initializer.expression)).toBe(true);
  });

  test("the literal is the descriptor as JSON.stringify writes it, two spaces deep", () => {
    const { source, initializer } = parseDescriptorExport();
    expect(initializer.expression.getText(source)).toBe(JSON.stringify(loadEtcdDescriptor(), null, 2));
  });

  test("the literal is kept out of the formatter, which checks src/** and would rewrite JSON's quoted keys", () => {
    const { text, statement } = parseDescriptorExport();
    const leading = (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []).map((range) =>
      text.slice(range.pos, range.end),
    );
    expect(leading.at(-1)?.startsWith("// biome-ignore format: ")).toBe(true);
  });

  test("the descriptor carries no .proto comments, which no runtime reads", () => {
    expect(JSON.stringify(loadEtcdDescriptor())).not.toContain('"comment"');
  });
});

describe("the generator's command, run by node in child processes that write only into a temporary directory", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    // A junction inside is removed as a link: rmSync never follows one into the checkout it names.
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function temporaryDirectory(): string {
    const directory = mkdtempSync(path.join(tmpdir(), "etcd-descriptor-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  function node(args: readonly string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
    const child = Bun.spawnSync(["node", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  }

  test("with no argument it writes the committed module, and --out names another file, resolved against cwd", () => {
    // Read here rather than run, because a child process given no argument would write into the tree.
    expect(descriptorOutputFile([])).toBe(ETCD_DESCRIPTOR_FILE);
    expect(descriptorOutputFile(["--out", "out/descriptor.ts"])).toBe(path.resolve("out/descriptor.ts"));
    expect(descriptorOutputFile(["--out", "/elsewhere/descriptor.ts"])).toBe(path.resolve("/elsewhere/descriptor.ts"));
  });

  test("every other argument list is refused, so a mistyped flag never writes the committed module instead", () => {
    const refused = [
      ["--out"],
      ["--out", ""],
      ["--out", "-"],
      ["--out", "--check"],
      ["--out", "a.ts", "b.ts"],
      ["--out=a.ts"],
      ["--output", "a.ts"],
      ["a.ts"],
      ["--check"],
    ];
    for (const args of refused) expect({ args, file: descriptorOutputFile(args) }).toEqual({ args, file: undefined });
  });

  test("--out writes the committed bytes to that file, resolved against the working directory, and names it", () => {
    const cwd = temporaryDirectory();
    mkdirSync(path.join(cwd, "out"));
    expect(node([GENERATOR, "--out", "out/descriptor.ts"], cwd)).toEqual({
      exitCode: 0,
      stdout: "Wrote out/descriptor.ts\n",
      stderr: "",
    });
    expect(readFileSync(path.join(cwd, "out", "descriptor.ts")).equals(readFileSync(ETCD_DESCRIPTOR_FILE))).toBe(true);
  });

  test("run through a symlinked checkout it still writes, because the guard compares real paths", () => {
    // Node keeps the link in process.argv[1] and resolves import.meta.url to the real file, so the first run fails a
    // comparison of the two as given; --preserve-symlinks-main keeps the link in import.meta.url too, so the second
    // fails one that makes only argv[1] real. A junction, because it needs no privilege on Windows; on POSIX the
    // type is ignored.
    const cwd = temporaryDirectory();
    const checkout = path.join(cwd, "checkout");
    symlinkSync(ROOT, checkout, "junction");
    const linkedGenerator = path.join(checkout, "scripts", "generate-etcd-descriptor.mjs");
    const runs = [
      { flags: [], file: "linked.ts" },
      { flags: ["--preserve-symlinks-main"], file: "preserved.ts" },
    ];
    for (const { flags, file } of runs) {
      expect({ flags, ...node([...flags, linkedGenerator, "--out", file], cwd) }).toEqual({
        flags,
        exitCode: 0,
        stdout: `Wrote ${file}\n`,
        stderr: "",
      });
      expect(readFileSync(path.join(cwd, file)).equals(readFileSync(ETCD_DESCRIPTOR_FILE))).toBe(true);
    }
  });

  test("imported, by a script or by node -e with arguments, it runs no command and writes nothing", () => {
    // Both carry an --out, so a guard that ran the command on import would write it here, never in the tree.
    const cwd = temporaryDirectory();
    const importGenerator = `import ${JSON.stringify(pathToFileURL(GENERATOR).href)};`;
    writeFileSync(path.join(cwd, "importer.mjs"), `${importGenerator}\n`);
    const quiet = { exitCode: 0, stdout: "", stderr: "" };
    expect(node([path.join(cwd, "importer.mjs"), "--out", "from-script.ts"], cwd)).toEqual(quiet);
    // node -e puts its first argument, --out here, in process.argv[1], where no file of that name exists.
    expect(node(["--input-type=module", "-e", importGenerator, "--", "--out", "from-eval.ts"], cwd)).toEqual(quiet);
    expect(readdirSync(cwd)).toEqual(["importer.mjs"]);
  });

  test("any other argument list is refused with the usage line and exit code 2, and nothing is written", () => {
    const cwd = temporaryDirectory();
    expect(node([GENERATOR, "--out"], cwd)).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "Usage: node scripts/generate-etcd-descriptor.mjs [--out <file>]\n",
    });
    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe("the regenerated descriptor, loaded as the adapter loads it", () => {
  test("fromJSON finds every service and all 42 RPCs of rpc.proto at v3.7.2", () => {
    const services = servicesOf(loadPackageDefinition());
    expect(services).toEqual(RPC_PROTO_SERVICES as Record<string, string[]>);
    expect(Object.values(services).flat()).toHaveLength(42);
  });

  test("field names keep the spelling of the .proto files", () => {
    const rangeRequest = loadPackageDefinition()["etcdserverpb.RangeRequest"] as unknown as {
      readonly type: { readonly field: ReadonlyArray<{ readonly name: string }> };
    };
    expect(rangeRequest.type.field.map((field) => field.name)).toEqual([
      "key",
      "range_end",
      "limit",
      "revision",
      "sort_order",
      "sort_target",
      "serializable",
      "keys_only",
      "count_only",
      "min_mod_revision",
      "max_mod_revision",
      "min_create_revision",
      "max_create_revision",
    ]);
  });

  test("each stub declares its package and nothing else", () => {
    const nested = loadEtcdDescriptor().nested as Record<string, { nested?: Record<string, unknown> }>;
    const googleApi = (nested.google?.nested?.api ?? null) as object | null;
    const openapiv2 = nested.grpc?.nested?.gateway as { nested?: Record<string, { nested?: Record<string, unknown> }> };
    expect(googleApi).toEqual({});
    expect(openapiv2?.nested?.protoc_gen_openapiv2?.nested?.options).toEqual({});
  });
});

describe("the vendored proto directory", () => {
  test("holds the vendored files, the two stubs, the README and the descriptor, and nothing else", () => {
    expect(listFiles(PROTO_DIR)).toEqual([...VENDORED_FILES, ...STUB_FILES, "README.md", "descriptor.ts"].sort());
  });

  test("the README names the v3.7.2 tag and the commit it points at", () => {
    const readme = readFileSync(path.join(PROTO_DIR, "README.md"), "utf8");
    expect(readme).toContain("v3.7.2");
    expect(readme).toContain(V3_7_2_COMMIT);
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

  test("the README maps every vendored proto to its upstream path under api/", () => {
    for (const [file, row] of readmeDigests()) {
      expect(row.upstream).toBe(file === "LICENSE" ? "api/LICENSE" : file.replace(/^etcd\//, ""));
    }
  });
});
