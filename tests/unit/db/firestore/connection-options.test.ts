/**
 * The Firestore connection fields of spec 4.1: Project ID required, Database ID optional with empty meaning
 * "(default)". The parameter is named config, as tests/unit/lib/db-ui-config.test.ts reads it.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  CONNECTION_SENTENCES as C,
  firestoreTargetOf,
  validateFirestoreConnection,
} from "@/lib/db/providers/document/firestore/connection-options";
import { FIRESTORE_TYPE } from "@/lib/db/providers/document/firestore/constants";
import { NAME_SENTENCES as N } from "@/lib/db/providers/document/firestore/names";

describe("validateFirestoreConnection", () => {
  test("a valid project, with no, empty, default and named database ids", () => {
    expect(validateFirestoreConnection({ database: "demo-libredb" })).toEqual([]);
    expect(validateFirestoreConnection({ database: "demo-libredb", schema: "" })).toEqual([]);
    expect(validateFirestoreConnection({ database: "demo-libredb", schema: "(default)" })).toEqual([]);
    expect(validateFirestoreConnection({ database: "example.com:my-project", schema: "orders" })).toEqual([]);
  });

  test("each refusal, in field order", () => {
    expect(validateFirestoreConnection({})).toEqual([C.projectMissing]);
    expect(validateFirestoreConnection({ database: "" })).toEqual([C.projectMissing]);
    expect(validateFirestoreConnection({ database: "Demo" })).toEqual([N.projectId]);
    expect(validateFirestoreConnection({ database: "demo-libredb", schema: "Orders" })).toEqual([N.databaseId]);
    expect(validateFirestoreConnection({ database: "Demo", schema: "Orders" })).toEqual([N.projectId, N.databaseId]);
    expect(validateFirestoreConnection({ database: 42 as unknown as string, schema: [] as unknown as string })).toEqual(
      [C.wrongType("database"), C.wrongType("schema")],
    );
    expect(validateFirestoreConnection({ database: null as unknown as string })).toEqual([C.projectMissing]);
  });

  test("the sentences", () => {
    expect(C.projectMissing).toBe("Project ID is required: the Google Cloud project that holds the Firestore database");
    expect(C.wrongType("schema")).toBe("The connection's schema must be a string");
  });
});

describe("firestoreTargetOf", () => {
  test("the default database when Database ID is empty, the named one otherwise", () => {
    expect(firestoreTargetOf({ database: "demo-libredb" })).toEqual({
      projectId: "demo-libredb",
      databaseId: "(default)",
    });
    expect(firestoreTargetOf({ database: "demo-libredb", schema: "" })).toEqual({
      projectId: "demo-libredb",
      databaseId: "(default)",
    });
    expect(firestoreTargetOf({ database: "demo-libredb", schema: "orders" })).toEqual({
      projectId: "demo-libredb",
      databaseId: "orders",
    });
  });

  test("throws the first refusal as a DatabaseConfigError", () => {
    let caught: unknown;
    try {
      firestoreTargetOf({ database: "Demo", schema: "Orders" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseConfigError);
    expect((caught as DatabaseConfigError).provider).toBe(FIRESTORE_TYPE);
    expect((caught as Error).message).toBe(N.projectId);
  });
});
