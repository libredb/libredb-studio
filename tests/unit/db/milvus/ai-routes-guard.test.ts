/**
 * E18 (VF3): no Milvus statement text reaches a route under `src/app/api/ai/`.
 *
 * The routes forward what they are posted, for every engine, so the guard sits at the senders: `explain` is posted
 * only from the Explain view, which a connection reaches only through `supportsExplain` and an `explainFormat`, and
 * `query-safety` only from the confirmation gate, which posts nothing for a row declaring `safetyAnalysis: false`.
 * This file pins the route set, the fields each route reads, each statement-bearing route's one sender and the gate
 * in front of it, and Milvus's answer to that gate. A new AI route, a route that starts reading a statement, or a
 * second sender goes red here, and must bring the elision of vectors, filter literals and values the spec names
 * with its own test.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { vocabularySendsToModel } from "@/lib/db/destructive-commands";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import type { DatabaseConnection } from "@/lib/db/types";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const AI_ROUTES = path.join(ROOT, "src/app/api/ai");
const MILVUS: DatabaseConnection = {
  id: "milvus-ai-guard",
  name: "Milvus",
  type: "milvus",
  host: "localhost",
  port: 19530,
  createdAt: new Date(0),
};

/** The fields each AI route destructures from its request body; `query` is the statement text. */
const ROUTE_FIELDS: Record<string, readonly string[]> = {
  "describe-schema": ["databaseType", "mode", "schemaContext"],
  explain: ["databaseType", "explainPlan", "query", "schemaContext"],
  "query-safety": ["databaseType", "query", "schemaContext"],
};

/** The one file outside `src/app/api/` that posts to each statement-bearing route, and the gate it sits behind. */
const SENDERS: Record<
  string,
  { readonly file: string; readonly gate: { readonly file: string; readonly text: string } }
> = {
  explain: {
    file: "src/components/VisualExplain.tsx",
    gate: { file: "src/components/studio/BottomPanel.tsx", text: "metadata?.capabilities.explainFormat ? tabs" },
  },
  "query-safety": {
    file: "src/components/QuerySafetyDialog.tsx",
    gate: {
      file: "src/components/QuerySafetyDialog.tsx",
      text: "vocabularySendsToModel(databaseType as DatabaseType | undefined)",
    },
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === path.join(ROOT, "src/app/api") ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("no Milvus statement text reaches an AI route (E18)", () => {
  test("the AI routes are the three this guard knows", () => {
    const routes = readdirSync(AI_ROUTES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(routes).toEqual(Object.keys(ROUTE_FIELDS).sort());
  });

  test.each(Object.entries(ROUTE_FIELDS))("%s reads exactly the fields this guard knows", (route, fields) => {
    const source = readFileSync(path.join(AI_ROUTES, route, "route.ts"), "utf8");
    const reads = [...source.matchAll(/const \{([^}]*)\} = await req\.json\(\)/g)];
    expect(reads).toHaveLength(1);
    const names = reads[0][1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();
    expect(names).toEqual([...fields]);
  });

  test("every route that reads a statement has one sender, and the sender sits behind its gate", () => {
    const statementRoutes = Object.entries(ROUTE_FIELDS)
      .filter(([, fields]) => fields.includes("query"))
      .map(([route]) => route)
      .sort();
    expect(statementRoutes).toEqual(Object.keys(SENDERS).sort());
    const files = sourceFiles(path.join(ROOT, "src"));
    for (const route of statementRoutes) {
      const senders = files
        .filter((file) => readFileSync(file, "utf8").includes(`"/api/ai/${route}"`))
        // Forward slashes, as SENDERS spells them, so the comparison holds on Windows too.
        .map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
      expect(senders).toEqual([SENDERS[route].file]);
      expect(readFileSync(path.join(ROOT, SENDERS[route].gate.file), "utf8")).toContain(SENDERS[route].gate.text);
    }
  });

  test("Milvus closes both gates: no Explain, and no statement posted for a safety analysis", () => {
    const capabilities = new MilvusProvider(MILVUS).getCapabilities();
    expect(capabilities.supportsExplain).toBe(false);
    expect(capabilities.explainFormat).toBeUndefined();
    expect(vocabularySendsToModel("milvus")).toBe(false);
  });
});
