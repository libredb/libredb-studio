/**
 * The call vocabularies are stated once, in the manifest schema (docs/providers/CONTRACT.md, clause C-4), and the SDK's
 * runtime constants are their copy: `CONSOLE_FACETS` holds the optional console facets `$defs/consoleCalls` declares,
 * and `EXECUTE_REQUEST_FIELDS` the optional request fields `$defs/executeRequestField` names, each in schema order.
 * `TRANSACTION_ACTIONS` names the actions a `console.transaction` request may carry (clause C-57).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONSOLE_FACETS, EXECUTE_REQUEST_FIELDS, TRANSACTION_ACTIONS } from "@libredb/provider-sdk/calls";

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
});
