/**
 * A failed fetch of the canvas packages is a missing chunk
 *
 * `loadCytoscape` imports `cytoscape` and `cytoscape-fcose` on demand, and a rejected import is
 * the same failure as a split view whose chunk never arrived, so it is named a `ChunkLoadError`
 * and the panel offers Reload. Kept in a file of its own because the import is made to fail
 * with a process-wide `mock.module`.
 */
import { expect, mock, test } from "bun:test";
import { ChunkLoadError } from "@/lib/lazy";

const fetchFailure = new Error("Failed to fetch dynamically imported module");
mock.module("cytoscape-fcose", () => {
  throw fetchFailure;
});

test("a package that cannot be imported rejects with a ChunkLoadError carrying the failure", async () => {
  const { loadCytoscape } = await import("@/components/results-graph/cytoscape-host");
  const failure = await loadCytoscape().then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ChunkLoadError);
  expect((failure as ChunkLoadError).cause).toBe(fetchFailure);
});
