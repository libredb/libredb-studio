import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";

/**
 * The container-path sentence has one producer under `src/lib/db/providers`.
 *
 * #1023 hoisted the object-path checks so `assertObjectPathShape` was the only thing left
 * rendering a `path is [...]` sentence. The container family was the same defect one layer
 * over and was not hoisted with it: fifteen provider files rendered their own
 * `container path is [...]`, eleven deriving the level list locally first and four carrying
 * a private `shapeList()`, two of which had already drifted (SQL Server's had lost the
 * guard for a declaration naming no level, so an empty one printed
 * `A SQL Server container path is , received [...]`).
 *
 * This file is the mechanical half of #1065's acceptance criterion, the way
 * `object-surface-conformance.test.ts` is for the object family. It reads the provider tree
 * rather than exercising a provider, because the claim is about where the sentence is
 * BUILT: a behavioural test can only show that one engine's message is right, and the
 * defect was that fifteen engines each built their own.
 */

// Anchored to this file rather than to `process.cwd()`, because a runner that launched this
// file from anywhere but the repository root would otherwise read nothing and pass.
const ROOT = path.resolve(import.meta.dir, "../../..");
const PROVIDERS = path.join(ROOT, "src/lib/db/providers");

/** `path.relative` spells the separator by HOST; the pinned list below is POSIX-spelled. */
const repoRelative = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/**
 * Every line of CODE that RENDERS the sentence, rather than one that talks about it.
 *
 * Prose quotes the phrase on purpose (a dozen docblocks explain why a path is refused), and
 * a blanket grep would fail on the documentation that records the fix. So the file is
 * parsed rather than scanned, the way the seam guards read a provider: comments are trivia
 * and never reach the walk, and every string the code carries is a node, whatever its quote
 * style. A `throw new QueryError("A Trino container path is ...")` written with double
 * quotes is the same defect as a template, and a line scanner that strips `//` without
 * knowing about strings reads one that carries a URL before the phrase as clean.
 */
function renderingLines(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  // One entry per line: the two arms of a conditional that both carry the phrase would
  // otherwise report their line twice, which reads like two throw sites.
  const found = new Set<number>();

  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) && node.text.includes("container path is")) {
      found.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...found].sort((a, b) => a - b).map((line) => `${line + 1}: ${lines[line].trim()}`);
}

/**
 * The fifteen provider files that reach the renderer, pinned by name.
 *
 * A floor (`>= 14`) stood here first, and a floor cannot see the thing it exists to notice:
 * an engine that stops reaching the renderer takes the count DOWN, and 14 still passes for
 * a fifteen-file population minus one. Naming the files makes a departure fail with the
 * file in the message, and a sixteenth arriving as a deliberate edit here rather than as a
 * silent count change.
 */
const ENGINES = [
  "src/lib/db/providers/document/couchbase/objects.ts",
  "src/lib/db/providers/document/mongodb.ts",
  "src/lib/db/providers/embedded/libredb.ts",
  "src/lib/db/providers/keyvalue/redis.ts",
  "src/lib/db/providers/sql/cassandra/objects.ts",
  "src/lib/db/providers/sql/clickhouse/objects.ts",
  "src/lib/db/providers/sql/druid/objects.ts",
  "src/lib/db/providers/sql/duckdb/objects.ts",
  "src/lib/db/providers/sql/libsql/objects.ts",
  "src/lib/db/providers/sql/mssql.ts",
  "src/lib/db/providers/sql/mysql.ts",
  "src/lib/db/providers/sql/oracle.ts",
  "src/lib/db/providers/sql/postgres.ts",
  "src/lib/db/providers/sql/sqlite.ts",
  "src/lib/db/providers/sql/trino/objects.ts",
];

describe("the container-path sentence has one producer under providers/", () => {
  const files = sourceFiles(PROVIDERS);

  test("no provider builds the sentence itself", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rendered = renderingLines(file, fs.readFileSync(file, "utf8"));
      if (rendered.length > 0) offenders.push(`${repoRelative(file)}\n    ${rendered.join("\n    ")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the shared renderer is the producer, and every engine reaches it", () => {
    const kinds = fs.readFileSync(path.join(ROOT, "src/lib/db/object-kinds.ts"), "utf8");
    expect(kinds).toContain("export function assertContainerPathShape(");

    // One descriptor per engine that renders the sentence, which is what keeps an engine's
    // own opening words and its shape spelling travelling through the shared renderer
    // instead of being re-typed at a call site. The depths it accepts are not the
    // descriptor's: they come from its declaration's `containerPathShapes`, through
    // `acceptedContainerShapes()` (#1147). A new provider that hand-rolls its own message
    // fails the test above; one that reaches the renderer without a descriptor fails here.
    const callers = files.filter((file) => fs.readFileSync(file, "utf8").includes("assertContainerPathShape("));
    expect(callers.map(repoRelative).sort()).toEqual([...ENGINES].sort());

    for (const file of callers) {
      expect(fs.readFileSync(file, "utf8")).toMatch(/\w+_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = \{/);
    }
  });

  test("no provider keeps its own shape-list helper", () => {
    // The four private `shapeList()` copies are the reason this issue exists; three of them
    // also served an OBJECT-path message, which the shared renderer does not cover, so the
    // helper may stay for that use. What must not stay is a helper whose only job is the
    // container sentence, which is what a `containerShapes()` next to it means.
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      if (/function containerShapes\s*\(/.test(source)) offenders.push(repoRelative(file));
    }
    expect(offenders).toEqual([]);
  });
});
