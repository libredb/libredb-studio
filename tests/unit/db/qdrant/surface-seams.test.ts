/**
 * The seams of the Qdrant provider's surface modules (vector-family spec 3.13, 6.11).
 *
 * - The browser-shipped modules this part adds (`generators.ts`, `labels.ts`, `type-spelling.ts`) import only each
 *   other, the provider's other browser modules, the shared console and vector modules, and types: never
 *   `qdrant-vocabulary.ts`, a server module, or a Node built-in.
 * - Interface segregation at run time: over a recording client, the object surface sends only the reads it is
 *   typed for, and monitoring only `GET /`, the listing and a description.
 * - No surface module logs: none imports a logger or calls `console`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  countQdrantObjects,
  describeQdrantObject,
  describeQdrantObjects,
  listQdrantObjects,
  type QdrantObjectContext,
  readQdrantObjectSource,
} from "@/lib/db/providers/vector/qdrant/objects";
import { recordingSend } from "../../../helpers/qdrant-surface-client";

const DIRECTORY = join(import.meta.dir, "../../../../src/lib/db/providers/vector/qdrant");

/** Every module specifier a file imports, with whether the import is type-only. */
function importsOf(file: string): readonly { readonly from: string; readonly typeOnly: boolean }[] {
  const text = readFileSync(join(DIRECTORY, file), "utf8");
  return [...text.matchAll(/^import (type )?[^;]*? from "([^"]+)";/gm)].map((match) => ({
    from: match[2],
    typeOnly: match[1] !== undefined,
  }));
}

const BROWSER_MODULES = ["generators.ts", "labels.ts", "type-spelling.ts"];
const BROWSER_SIBLINGS = new Set(["./generators", "./labels", "./type-spelling", "./routes", "./guard", "./request"]);

describe("the browser-shipped modules", () => {
  test.each(BROWSER_MODULES)("%s imports only browser-safe modules and types", (file) => {
    for (const { from, typeOnly } of importsOf(file)) {
      const allowed =
        typeOnly ||
        BROWSER_SIBLINGS.has(from) ||
        from.startsWith("@/lib/db/console/") ||
        from.startsWith("@/lib/db/vector/");
      expect({ file, from, allowed }).toEqual({ file, from, allowed: true });
    }
  });

  test.each(BROWSER_MODULES)("%s never imports the vocabulary or a Node built-in", (file) => {
    for (const { from } of importsOf(file)) {
      expect(from).not.toBe("./qdrant-vocabulary");
      expect(from.startsWith("node:")).toBe(false);
    }
  });
});

const SURFACE_MODULES = [
  "type-spelling.ts",
  "schema.ts",
  "sample.ts",
  "source.ts",
  "objects.ts",
  "generators.ts",
  "labels.ts",
  "monitoring.ts",
  "monitoring-reads.ts",
  "index.ts",
];

describe("no logger", () => {
  test.each(SURFACE_MODULES)("%s imports no logger and calls no console", (file) => {
    const text = readFileSync(join(DIRECTORY, file), "utf8");
    expect(text).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\(/);
    expect(importsOf(file).some(({ from }) => /logger/.test(from))).toBe(false);
  });
});

describe("interface segregation at run time", () => {
  test("the object surface sends only its seven reads", async () => {
    const recording = recordingSend();
    const context: QdrantObjectContext = {
      send: recording.send,
      signal: new AbortController().signal,
      sliceSupported: true,
      scoped: false,
    };
    await countQdrantObjects(context);
    await listQdrantObjects(context, "collection");
    await describeQdrantObject(context, ["docs"], "collection");
    await describeQdrantObjects(context, "collection");
    await readQdrantObjectSource(context, ["docs"], "collection");
    expect(new Set(recording.calls.map((call) => call.method))).toEqual(
      new Set([
        "get_collections",
        "get_collection",
        "get_collection_aliases",
        "list_snapshots",
        "get_optimizations",
        "collection_cluster_info",
        "scroll_points",
      ]),
    );
  });
});
