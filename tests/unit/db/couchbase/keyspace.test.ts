/**
 * Couchbase keyspace mapping (issue #262, decision 4)
 *
 * The schema explorer is flat, so bucket > scope > collection is flattened the
 * same way PostgreSQL flattens schema > table: the _default scope renders as a
 * bare collection name, every other scope renders as "scope.collection".
 *
 * Quoting is a security boundary: SQL++ has no bind parameter for identifiers,
 * so a keyspace path is built by string concatenation and an identifier that
 * carries a backtick must not be able to escape its own quoting.
 */
import { describe, test, expect } from "bun:test";
import {
  COUCHBASE_DEFAULT_SCOPE,
  keyspaceDisplayName,
  keyspaceFromDisplayName,
  keyspacePath,
  quoteIdentifier,
} from "@/lib/db/providers/document/couchbase/keyspace";

/**
 * Number of backticks that are NOT part of an escaped (doubled) pair.
 * A correctly quoted path has exactly two per segment and nothing else.
 */
function structuralBacktickCount(value: string): number {
  return value
    .replace(/``/g, "")
    .split("")
    .filter((char) => char === "`").length;
}

describe("keyspaceDisplayName", () => {
  test("renders a _default scope collection as the bare collection name", () => {
    expect(keyspaceDisplayName(COUCHBASE_DEFAULT_SCOPE, "hotel")).toBe("hotel");
  });

  test("renders any other scope as scope.collection", () => {
    expect(keyspaceDisplayName("inventory", "hotel")).toBe("inventory.hotel");
  });
});

describe("keyspaceFromDisplayName", () => {
  test("maps a bare collection name onto the _default scope", () => {
    expect(keyspaceFromDisplayName("travel", "hotel")).toEqual({
      bucket: "travel",
      scope: COUCHBASE_DEFAULT_SCOPE,
      collection: "hotel",
    });
  });

  test("splits a qualified display name into scope and collection", () => {
    expect(keyspaceFromDisplayName("travel", "inventory.hotel")).toEqual({
      bucket: "travel",
      scope: "inventory",
      collection: "hotel",
    });
  });

  test("splits on the first separator only, so extra dots stay with the collection", () => {
    expect(keyspaceFromDisplayName("travel", "inventory.hotel.eu")).toEqual({
      bucket: "travel",
      scope: "inventory",
      collection: "hotel.eu",
    });
  });

  test("round-trips a display name in both directions", () => {
    const keyspace = keyspaceFromDisplayName("travel", "inventory.hotel");
    expect(keyspaceDisplayName(keyspace.scope, keyspace.collection)).toBe("inventory.hotel");

    const defaultKeyspace = keyspaceFromDisplayName("travel", "hotel");
    expect(keyspaceDisplayName(defaultKeyspace.scope, defaultKeyspace.collection)).toBe("hotel");
  });
});

describe("quoteIdentifier", () => {
  test("wraps a plain identifier in backticks", () => {
    expect(quoteIdentifier("hotel")).toBe("`hotel`");
  });

  test("quotes reserved words such as bucket and scope", () => {
    // Verified against Couchbase Server 8.0.2: unquoted `bucket` / `scope` in a
    // system:keyspaces projection fails with error 3000 (syntax error).
    expect(quoteIdentifier("bucket")).toBe("`bucket`");
    expect(quoteIdentifier("scope")).toBe("`scope`");
  });

  test("doubles an embedded backtick so it cannot close the quoting", () => {
    expect(quoteIdentifier("ev`il")).toBe("`ev``il`");
  });

  test("doubles a trailing backtick", () => {
    expect(quoteIdentifier("x`")).toBe("`x```");
  });

  test("leaves single quotes and backslashes untouched", () => {
    expect(quoteIdentifier("o'brien\\x")).toBe("`o'brien\\x`");
  });
});

describe("keyspacePath", () => {
  test("quotes every segment of the executable path", () => {
    expect(keyspacePath({ bucket: "travel-sample", scope: "inventory", collection: "hotel" })).toBe(
      "`travel-sample`.`inventory`.`hotel`",
    );
  });

  test("quotes the _default scope explicitly rather than omitting it", () => {
    expect(keyspacePath({ bucket: "travel", scope: COUCHBASE_DEFAULT_SCOPE, collection: "hotel" })).toBe(
      "`travel`.`_default`.`hotel`",
    );
  });

  test("keeps a hostile collection name inside its quotes", () => {
    const path = keyspacePath({ bucket: "travel", scope: "_default", collection: "x` OR 1=1 --" });

    expect(path).toBe("`travel`.`_default`.`x`` OR 1=1 --`");
    // Two structural backticks per segment and no stray one that could end the
    // identifier early and turn the payload into executable SQL++.
    expect(structuralBacktickCount(path)).toBe(6);
  });

  test("keeps a hostile bucket and scope inside their quotes", () => {
    const path = keyspacePath({
      bucket: "b`ucket",
      scope: "s`cope",
      collection: "c`ollection",
    });

    expect(path).toBe("`b``ucket`.`s``cope`.`c``ollection`");
    expect(structuralBacktickCount(path)).toBe(6);
  });

  test("builds the path a display name maps to", () => {
    expect(keyspacePath(keyspaceFromDisplayName("travel", "inventory.hotel"))).toBe("`travel`.`inventory`.`hotel`");
  });
});
