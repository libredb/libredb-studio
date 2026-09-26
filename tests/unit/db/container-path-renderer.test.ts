import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

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
 * Every line that RENDERS the sentence, rather than one that talks about it.
 *
 * Prose cites the phrase on purpose (a dozen docblocks explain why a path is refused), and
 * a blanket grep would fail on the documentation that records the fix. A line that builds
 * the message is one that interpolates `container path is` into a template literal, which
 * is what a throw site looks like.
 */
function renderingLines(source: string): string[] {
  // A comment line is skipped outright: docblocks quote the sentence on purpose (a dozen of
  // them explain why a path is refused), and one of those quotes is a backticked phrase that
  // a naive template-literal match reads as a throw site. Only code builds the message.
  return source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      return /`[^`]*container path is/.test(code);
    })
    .map(({ line, number }) => `${number}: ${line.trim()}`);
}

describe("the container-path sentence has one producer under providers/", () => {
  const files = sourceFiles(PROVIDERS);

  test("no provider builds the sentence itself", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rendered = renderingLines(fs.readFileSync(file, "utf8"));
      if (rendered.length > 0) offenders.push(`${path.relative(ROOT, file)}\n    ${rendered.join("\n    ")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the shared renderer is the producer, and every engine reaches it", () => {
    const kinds = fs.readFileSync(path.join(ROOT, "src/lib/db/object-kinds.ts"), "utf8");
    expect(kinds).toContain("export function assertContainerPathShape(");

    // One descriptor per engine that renders the sentence, which is what keeps an engine's
    // own opening words and accepted depths travelling through the shared renderer instead
    // of being re-typed at a call site. A new provider that hand-rolls its own message
    // fails the test above; one that reaches the renderer without a descriptor fails here.
    const callers = files.filter((file) => fs.readFileSync(file, "utf8").includes("assertContainerPathShape("));
    expect(callers.length).toBeGreaterThanOrEqual(14);

    for (const file of callers) {
      const source = fs.readFileSync(file, "utf8");
      if (file.endsWith("object-kinds.ts")) continue;
      expect(source).toMatch(/\w+_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = \{/);
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
      if (/function containerShapes\s*\(/.test(source)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});
