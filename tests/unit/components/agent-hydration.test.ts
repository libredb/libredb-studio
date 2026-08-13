/**
 * Reading one agent artifact into the surface that already renders it (#329 T11).
 *
 * The rule these pin: an artifact is hydrated into an EXISTING surface, chosen from
 * the operation that produced it, and nothing is invented for a payload the server
 * did not send. A plan the app cannot parse is not a failure — the rows are still
 * rows, so it falls back to the grid rather than to an empty explain view.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { hydrateAgentArtifact } from "@/components/agent/hydration";

function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    runId: "arun_1",
    correlationId: "corr_9",
    operationId: "sql.query.read",
    summary: { rowCount: 2, columnNames: ["id", "total"], elapsedMs: 12 },
    result: {
      rows: [
        { id: 1, total: 10 },
        { id: 2, total: 20 },
      ],
      fields: ["id", "total"],
      rowCount: 2,
      executionTime: 12,
    },
    ...overrides,
  };
}

describe("hydrateAgentArtifact", () => {
  test("a read artifact hydrates the results grid, carrying the run it came from", () => {
    const hydrated = hydrateAgentArtifact(payload(), "postgres-json");

    expect(hydrated).not.toBeNull();
    expect(hydrated?.surface).toBe("results");
    expect(hydrated?.runId).toBe("arun_1");
    expect(hydrated?.correlationId).toBe("corr_9");
    expect(hydrated?.operationId).toBe("sql.query.read");
    expect(hydrated?.result.rows).toEqual([
      { id: 1, total: 10 },
      { id: 2, total: 20 },
    ]);
    expect(hydrated?.explainPlan).toBeNull();
  });

  test("a plan artifact hydrates the explain surface, through the connection's own strategy", () => {
    const hydrated = hydrateAgentArtifact(
      payload({
        operationId: "sql.explain.estimate",
        result: {
          rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan" } }] }],
          fields: ["QUERY PLAN"],
          rowCount: 1,
          executionTime: 3,
        },
      }),
      "postgres-json",
    );

    expect(hydrated?.surface).toBe("explain");
    expect(hydrated?.explainPlan).toEqual({ format: "postgres-json", raw: [{ Plan: { "Node Type": "Seq Scan" } }] });
  });

  test("a plan the connection has no strategy for falls back to the grid rather than an empty plan view", () => {
    const hydrated = hydrateAgentArtifact(payload({ operationId: "sql.explain.estimate" }), undefined);

    expect(hydrated?.surface).toBe("results");
    expect(hydrated?.explainPlan).toBeNull();
  });

  test("a plan the strategy renders nothing from falls back the same way", () => {
    const hydrated = hydrateAgentArtifact(
      payload({
        operationId: "sql.explain.estimate",
        result: { rows: [], fields: [], rowCount: 0, executionTime: 1 },
      }),
      "postgres-json",
    );

    expect(hydrated?.surface).toBe("results");
    expect(hydrated?.explainPlan).toBeNull();
  });

  test("a payload without a readable result is refused rather than rendered empty", () => {
    expect(hydrateAgentArtifact(payload({ result: null }), "postgres-json")).toBeNull();
    expect(hydrateAgentArtifact(payload({ result: { rows: "nope", fields: [] } }), "postgres-json")).toBeNull();
    expect(hydrateAgentArtifact(payload({ runId: 42 }), "postgres-json")).toBeNull();
    expect(hydrateAgentArtifact(payload({ correlationId: null }), "postgres-json")).toBeNull();
    expect(hydrateAgentArtifact(payload({ operationId: undefined }), "postgres-json")).toBeNull();
    expect(hydrateAgentArtifact("not an object", "postgres-json")).toBeNull();
    expect(hydrateAgentArtifact(null, "postgres-json")).toBeNull();
  });
});

/**
 * The rail renders no result surface of its own (#329 T11).
 *
 * Asserted on the source rather than on one render, because a rendered assertion only
 * proves that the paths a test exercised built no grid. The claim is about the
 * modules: nothing under `src/components/agent/` may reach for the components that
 * render results or hold statements, so a later change that puts a grid inside the
 * rail fails here rather than shipping a second one to keep correct.
 */
describe("the agent rail's module boundary", () => {
  const AGENT_DIR = path.join(process.cwd(), "src/components/agent");
  const RAIL_MODULES = [
    "AgentRail.tsx",
    "hydration.ts",
    "timeline.ts",
    "use-agent-artifact.ts",
    "use-agent-prefill.ts",
    "use-agent-run.ts",
  ];
  const FORBIDDEN = [
    "@/components/ResultsGrid",
    "@/components/QueryEditor",
    "@/components/DataCharts",
    // The barrel too: it re-exports BottomPanel, which is where the grid lives, so a
    // rail module reaching it would pull one in without naming it.
    "@/components/studio",
    "monaco",
  ];

  // Static AND dynamic: a lazy `import("@/components/ResultsGrid")` would put a grid in
  // the rail just as surely as a top-level one, so both forms are read.
  const specifiersOf = (source: string): string[] =>
    [...source.matchAll(/(?:from|import|require)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1]);

  test("the scan reads every form an import can take", () => {
    // A positive control: without it, a typo in the pattern makes the assertion below
    // pass by matching nothing at all.
    const fixture = [
      'import { Grid } from "@/components/ResultsGrid";',
      'const lazy = await import("@/components/QueryEditor");',
      'const cjs = require("monaco-editor");',
      'const nested = dynamic(() => import("@/components/DataCharts"));',
    ].join("\n");

    expect(specifiersOf(fixture)).toEqual([
      "@/components/ResultsGrid",
      "@/components/QueryEditor",
      "monaco-editor",
      "@/components/DataCharts",
    ]);
  });

  test("no module under src/components/agent imports a grid, an editor or a chart", () => {
    for (const moduleName of RAIL_MODULES) {
      const specifiers = specifiersOf(fs.readFileSync(path.join(AGENT_DIR, moduleName), "utf8"));
      for (const forbidden of FORBIDDEN) {
        expect(specifiers.filter((specifier) => specifier.includes(forbidden))).toEqual([]);
      }
    }
  });

  test("the list it scans is the whole tree, so a module added later cannot slip past it", () => {
    // Recursive: a subdirectory would otherwise satisfy a flat listing while going
    // unscanned, which is the same drift the list itself exists to catch.
    const present = fs
      .readdirSync(AGENT_DIR, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"));

    expect([...present].sort()).toEqual([...RAIL_MODULES].sort());
  });
});
