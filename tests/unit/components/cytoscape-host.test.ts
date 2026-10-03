/**
 * The Cytoscape host (graph view spec, Architecture)
 *
 * `cytoscape-host.ts` is the one module that loads `cytoscape` and `cytoscape-fcose`,
 * and it loads them with a dynamic `import()` only when the view asks, so nothing
 * touches `window` at module load or on the server. These tests drive the real
 * libraries headlessly through the loader the view takes as its injectable factory,
 * and a syntactic guard keeps every other source file from importing either package.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { type CytoscapeFactory, fcoseLayout, loadCytoscape } from "@/components/results-graph/cytoscape-host";

const ROOT = join(import.meta.dir, "..", "..", "..");
const HOST = "src/components/results-graph/cytoscape-host.ts";
const PACKAGES = new Set(["cytoscape", "cytoscape-fcose"]);

const elements = [
  { data: { id: "a" } },
  { data: { id: "b" } },
  { data: { id: "c" } },
  { data: { id: "ab", source: "a", target: "b" } },
  { data: { id: "bc", source: "b", target: "c" } },
];

/** Every module under `dir`; declaration files emit no code, so they are left out. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|cts|js|mjs)$/.test(name) && !name.endsWith(".d.ts") ? [path.split(sep).join("/")] : [];
  });
}

function importedPackages(source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((file) => file.fileName)
    .filter((name) => PACKAGES.has(name));
}

/** Static import declarations of either package that are not `import type`. */
function runtimeStaticImports(source: string): string[] {
  const file = ts.createSourceFile("host.ts", source, ts.ScriptTarget.Latest, true);
  return file.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    PACKAGES.has(statement.moduleSpecifier.text) &&
    !statement.importClause?.isTypeOnly
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

async function headless(create: CytoscapeFactory) {
  const make = await create();
  return make({ headless: true, styleEnabled: true, elements });
}

describe("loadCytoscape", () => {
  test("returns a factory that builds a working Cytoscape instance", async () => {
    const cy = await headless(loadCytoscape);
    try {
      expect(cy.nodes().map((node) => node.id())).toEqual(["a", "b", "c"]);
      expect(cy.edges().map((edge) => edge.id())).toEqual(["ab", "bc"]);
    } finally {
      cy.destroy();
    }
  });

  test("registers fcose, so the layout it names runs and places every node", async () => {
    const cy = await headless(loadCytoscape);
    try {
      cy.layout(fcoseLayout()).run();
      const positions = cy.nodes().map((node) => node.position());
      for (const { x, y } of positions) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      }
      expect(new Set(positions.map(({ x, y }) => `${x},${y}`)).size).toBe(3);
    } finally {
      cy.destroy();
    }
  });

  test("can be called again, as a remounted view does, without a warning and without breaking the first instance", async () => {
    const warn = spyOn(console, "warn");
    const error = spyOn(console, "error");
    const first = await headless(loadCytoscape);
    const second = await headless(loadCytoscape);
    try {
      second.layout(fcoseLayout()).run();
      first.layout(fcoseLayout()).run();
      expect(second.nodes()).toHaveLength(3);
      for (const cy of [first, second]) {
        expect(new Set(cy.nodes().map((node) => `${node.position().x},${node.position().y}`)).size).toBe(3);
      }
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
      first.destroy();
      second.destroy();
    }
  });
});

describe("fcoseLayout", () => {
  test("randomizes the first placement and never animates, so a run ends when run() returns", () => {
    expect(fcoseLayout()).toEqual({ name: "fcose", randomize: true, animate: false });
  });

  test("returns a fresh object each call, so a caller may add a handler to it", () => {
    expect(fcoseLayout()).not.toBe(fcoseLayout());
  });
});

describe("the host is the only way in", () => {
  test("no source file but the host imports cytoscape or cytoscape-fcose, even for types", () => {
    const offenders = sourceFiles("src").filter(
      (path) => path !== HOST && importedPackages(readFileSync(join(ROOT, path), "utf8")).length > 0,
    );
    expect(offenders).toEqual([]);
  });

  test("the host loads both packages, and only through a dynamic import", () => {
    const source = readFileSync(join(ROOT, HOST), "utf8");
    expect(new Set(importedPackages(source))).toEqual(PACKAGES);
    expect(runtimeStaticImports(source)).toEqual([]);
  });

  test("the guard sees a static runtime import and passes a type-only one", () => {
    expect(runtimeStaticImports('import cytoscape from "cytoscape";')).toEqual(["cytoscape"]);
    expect(runtimeStaticImports('import { type Core } from "cytoscape";')).toEqual(["cytoscape"]);
    expect(runtimeStaticImports('import type { Core } from "cytoscape";')).toEqual([]);
    expect(importedPackages('const m = await import("cytoscape-fcose");')).toEqual(["cytoscape-fcose"]);
  });

  test("the file walk reaches nested source files", () => {
    expect(sourceFiles("src")).toContain("src/lib/db/graph/result-graph.ts");
    expect(sourceFiles("src")).not.toContain("src/types/cytoscape-fcose.d.ts");
  });
});
