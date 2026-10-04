/**
 * The vector column declaration is published (vector-family spec 3.10): a host types its result with the names
 * `@libredb/studio/types` and `@libredb/studio/workspace` export. `bun run typecheck` is what holds the names; the
 * run-time assertion only holds the values the types admit.
 */
import { describe, expect, test } from "bun:test";
import type { QueryResult, SparseEncoding, VectorColumn, VectorDType, VectorKind } from "@/exports/types";
import type { WorkspaceQueryResult } from "@/exports/workspace";

describe("the published vector column types", () => {
  test("a host declares a dense and a sparse column on both result shapes", () => {
    const kind: VectorKind = "dense";
    const dtype: VectorDType = "float32";
    const encoding: SparseEncoding = "indices-values";
    const embedding: VectorColumn = { kind, dtype, dimension: 768 };
    const keywords: VectorColumn = { kind: "sparse", dtype, dimension: null, sparseEncoding: encoding };
    const hosted: WorkspaceQueryResult = {
      rows: [],
      fields: ["embedding", "keywords"],
      rowCount: 0,
      executionTime: 1,
      vectorColumns: { embedding, keywords },
    };
    const served: QueryResult = {
      rows: [],
      fields: hosted.fields,
      rowCount: 0,
      executionTime: 1,
      vectorColumns: hosted.vectorColumns,
    };
    expect(served.vectorColumns).toEqual({
      embedding: { kind: "dense", dtype: "float32", dimension: 768 },
      keywords: { kind: "sparse", dtype: "float32", dimension: null, sparseEncoding: "indices-values" },
    });
  });
});
