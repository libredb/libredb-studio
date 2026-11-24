/**
 * The call vocabularies are stated once, in the manifest schema (docs/providers/CONTRACT.md, clause C-4), and the SDK's
 * runtime constants are their copy: `CONSOLE_FACETS` holds the optional console facets `$defs/consoleCalls` declares,
 * and `EXECUTE_REQUEST_FIELDS` the optional request fields `$defs/executeRequestField` names, each in schema order.
 * `TRANSACTION_ACTIONS` names the actions a `console.transaction` request may carry (clause C-57). `OBJECTS_FACETS`
 * holds the object facets `$defs/objectsCalls` declares, and `TREE_ACTIONS` names the actions an `objects.tree` request
 * may carry (clause C-61). `MAINTENANCE_FACETS` holds the maintenance facets `$defs/maintenanceCalls` declares, and
 * `MAINTENANCE_OPERATIONS` the operations `$defs/maintenanceOperation` names (clause C-67).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CONSOLE_FACETS,
  EXECUTE_REQUEST_FIELDS,
  MAINTENANCE_FACETS,
  MAINTENANCE_OPERATIONS,
  OBJECTS_FACETS,
  TRANSACTION_ACTIONS,
  TREE_ACTIONS,
} from "@libredb/provider-sdk/calls";

const SCHEMA = JSON.parse(
  readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"), "utf8"),
) as { $defs: Record<string, { properties?: Record<string, unknown>; enum?: unknown[] }> };

describe("the call vocabularies", () => {
  test("the console facets and execute's request fields are the schema's", () => {
    const consoleCalls = Object.keys(SCHEMA.$defs.consoleCalls?.properties ?? {});

    expect(consoleCalls).toContain("execute");
    expect<readonly string[]>([...CONSOLE_FACETS]).toEqual(consoleCalls.filter((name) => name !== "execute"));
    expect<readonly string[]>([...EXECUTE_REQUEST_FIELDS]).toEqual(
      (SCHEMA.$defs.executeRequestField?.enum ?? []).map(String),
    );
    expect(Object.isFrozen(CONSOLE_FACETS)).toBe(true);
    expect(Object.isFrozen(EXECUTE_REQUEST_FIELDS)).toBe(true);
  });

  test("the transaction actions are begin, commit, rollback and state", () => {
    expect<readonly string[]>([...TRANSACTION_ACTIONS]).toEqual(["begin", "commit", "rollback", "state"]);
    expect(Object.isFrozen(TRANSACTION_ACTIONS)).toBe(true);
  });

  test("the objects facets are the schema's", () => {
    expect<readonly string[]>([...OBJECTS_FACETS]).toEqual(Object.keys(SCHEMA.$defs.objectsCalls?.properties ?? {}));
    expect<readonly string[]>([...OBJECTS_FACETS]).toEqual(["tree"]);
    expect(Object.isFrozen(OBJECTS_FACETS)).toBe(true);
  });

  test("the tree actions are containers, count, list, describe and describeMany", () => {
    expect<readonly string[]>([...TREE_ACTIONS]).toEqual(["containers", "count", "list", "describe", "describeMany"]);
    expect(Object.isFrozen(TREE_ACTIONS)).toBe(true);
  });

  test("the maintenance facets are the schema's", () => {
    expect<readonly string[]>([...MAINTENANCE_FACETS]).toEqual(
      Object.keys(SCHEMA.$defs.maintenanceCalls?.properties ?? {}),
    );
    expect<readonly string[]>([...MAINTENANCE_FACETS]).toEqual(["run", "preview"]);
    expect(Object.isFrozen(MAINTENANCE_FACETS)).toBe(true);
  });

  test("the maintenance operations are the schema's", () => {
    expect<readonly string[]>([...MAINTENANCE_OPERATIONS]).toEqual(
      (SCHEMA.$defs.maintenanceOperation?.enum ?? []).map(String),
    );
    expect(MAINTENANCE_OPERATIONS).toHaveLength(11);
    expect(Object.isFrozen(MAINTENANCE_OPERATIONS)).toBe(true);
  });
});
