/**
 * Spark's spelling of names and namespaces, and the provider's fixed values, which every other module reads from
 * constants.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  SPARK_ARROW_CHUNK_BYTES,
  SPARK_ARROW_MAX_RECORDS_PER_BATCH,
  SPARK_BATCH_OVERHEAD_BYTES,
  SPARK_CLIENT_TYPE,
  SPARK_CONTROL_DEADLINE_MS,
  SPARK_DEFAULT_PORT,
  SPARK_DESCRIBE_OBJECTS_MAX,
  SPARK_ERROR_CAUSE_MAX_CHARS,
  SPARK_ERROR_CAUSES_MAX,
  SPARK_HEARTBEAT_DEADLINE_MS,
  SPARK_HEARTBEAT_INTERVAL_MS,
  SPARK_INTROSPECT_IN_FLIGHT_MAX,
  SPARK_IP_SERVER_NAME,
  SPARK_IPC_METADATA_MAX_BYTES,
  SPARK_METADATA_SESSION_CONF,
  SPARK_MIN_VERSION,
  SPARK_NAMESPACE_MAX_PARTS,
  SPARK_NAMESPACE_WALK_MAX,
  SPARK_RECEIVE_CAP_BYTES,
  SPARK_REFUSED_SESSION_MAP_MAX,
  SPARK_RESULT_BYTE_BUDGET,
  SPARK_RUN_TAG_PREFIX,
  SPARK_SCHEMA_MAX_DEPTH,
  SPARK_SCHEMA_MAX_FIELDS,
  SPARK_SESSION_CATALOG,
  SPARK_SESSION_CONF,
  SPARK_STATUS_DETAILS_MAX_BYTES,
  SPARK_STATUS_DETAILS_MAX_ENTRIES,
  SPARK_STATUS_DETAILS_VALUE_MAX_BYTES,
  SPARK_STREAM_MAX_RECEIVED_BYTES,
  SPARK_USER_CONTEXT,
  SPARK_VERSION_TEXT_MAX_CHARS,
} from "@/lib/db/providers/sql/spark/constants";
import {
  parseNamespaceSpelling,
  qualifiedName,
  quoteSparkName,
  SPARK_CATALOG_PATTERN,
  SPARK_NAMESPACE_PATTERN,
  SPARK_TOKEN_PATTERN,
  spellNamespace,
  spellSparkName,
} from "@/lib/db/providers/sql/spark/namespace";

describe("the fixed values", () => {
  test("ports, names, identity and the floor", () => {
    expect(SPARK_DEFAULT_PORT).toBe(15002);
    expect(SPARK_IP_SERVER_NAME).toBe("spark.invalid");
    expect(SPARK_SESSION_CATALOG).toBe("spark_catalog");
    expect(SPARK_MIN_VERSION).toEqual({ major: 4, minor: 1, patch: 0 });
    expect(SPARK_USER_CONTEXT).toEqual({ user_id: "libredb-studio", user_name: "libredb-studio" });
    expect(SPARK_CLIENT_TYPE).toBe("libredb-studio");
    expect(SPARK_RUN_TAG_PREFIX).toBe("libredb-studio-");
  });

  test("sizes, budgets and bounds", () => {
    expect(SPARK_RECEIVE_CAP_BYTES).toBe(16_777_216);
    expect(SPARK_ARROW_CHUNK_BYTES).toBe(4_194_304);
    expect(SPARK_ARROW_MAX_RECORDS_PER_BATCH).toBe(1_000);
    expect(SPARK_RESULT_BYTE_BUDGET).toBe(16_777_216);
    expect(SPARK_BATCH_OVERHEAD_BYTES).toBe(1_024);
    expect(SPARK_STREAM_MAX_RECEIVED_BYTES).toBe(33_554_432);
    expect(SPARK_IPC_METADATA_MAX_BYTES).toBe(1_048_576);
    expect(SPARK_SCHEMA_MAX_DEPTH).toBe(64);
    expect(SPARK_SCHEMA_MAX_FIELDS).toBe(10_000);
    expect(SPARK_NAMESPACE_WALK_MAX).toBe(1_000);
    expect(SPARK_NAMESPACE_MAX_PARTS).toBe(8);
    expect(SPARK_DESCRIBE_OBJECTS_MAX).toBe(1_000);
    expect(SPARK_INTROSPECT_IN_FLIGHT_MAX).toBe(8);
    expect(SPARK_ERROR_CAUSES_MAX).toBe(5);
    expect(SPARK_ERROR_CAUSE_MAX_CHARS).toBe(1_024);
    expect(SPARK_VERSION_TEXT_MAX_CHARS).toBe(64);
    expect(SPARK_STATUS_DETAILS_MAX_BYTES).toBe(65_536);
    expect(SPARK_STATUS_DETAILS_MAX_ENTRIES).toBe(16);
    expect(SPARK_STATUS_DETAILS_VALUE_MAX_BYTES).toBe(8_192);
    expect(SPARK_REFUSED_SESSION_MAP_MAX).toBe(256);
  });

  test("times", () => {
    expect(SPARK_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(SPARK_HEARTBEAT_DEADLINE_MS).toBe(5_000);
    expect(SPARK_CONTROL_DEADLINE_MS).toBe(10_000);
  });

  test("the session settings, in the order every new session receives them", () => {
    expect(SPARK_SESSION_CONF).toEqual([
      ["spark.sql.variable.substitute", "false"],
      ["spark.sql.execution.arrow.compression.codec", "none"],
      ["spark.sql.execution.arrow.useLargeVarTypes", "false"],
      ["spark.connect.session.resultChunking.maxChunkSize", "4194304"],
      ["spark.sql.execution.arrow.maxRecordsPerBatch", "1000"],
      ["spark.connect.progress.reportInterval", "2s"],
      ["spark.sql.connect.enrichError.enabled", "true"],
    ]);
    expect(SPARK_METADATA_SESSION_CONF).toEqual([
      ["spark.sql.legacy.keepCommandOutputSchema", "false"],
      ["spark.sql.debug.maxToStringFields", "10000"],
    ]);
    expect(SPARK_SESSION_CONF[3]?.[1]).toBe(String(SPARK_ARROW_CHUNK_BYTES));
    expect(SPARK_SESSION_CONF[4]?.[1]).toBe(String(SPARK_ARROW_MAX_RECORDS_PER_BATCH));
    expect(SPARK_METADATA_SESSION_CONF[1]?.[1]).toBe(String(SPARK_SCHEMA_MAX_FIELDS));
  });
});

describe("quoteSparkName and spellSparkName", () => {
  test("quoting always backticks and doubles a backtick inside", () => {
    expect(quoteSparkName("plain")).toBe("`plain`");
    expect(quoteSparkName("a`b")).toBe("`a``b`");
    expect(quoteSparkName("``")).toBe("``````");
    expect(quoteSparkName("dot.ted")).toBe("`dot.ted`");
  });

  test("spelling leaves bare only a letter or _ followed by letters, digits or _, as Spark's quoteIfNeeded", () => {
    for (const bare of ["a", "_x", "studio", "A1_b"]) expect(spellSparkName(bare)).toBe(bare);
    for (const [name, spelled] of [
      ["1a", "`1a`"],
      ["a b", "`a b`"],
      ["a.b", "`a.b`"],
      ["#tag", "`#tag`"],
      ["a`b", "`a``b`"],
      ["çatal", "`çatal`"],
      ["", "``"],
    ] as const) {
      expect(spellSparkName(name)).toBe(spelled);
    }
  });
});

describe("parseNamespaceSpelling", () => {
  test("reads 1 to 8 parts, bare or backticked, a doubled backtick as one", () => {
    expect(parseNamespaceSpelling("studio")).toEqual(["studio"]);
    expect(parseNamespaceSpelling("a.b.c")).toEqual(["a", "b", "c"]);
    expect(parseNamespaceSpelling("`a.b`.c")).toEqual(["a.b", "c"]);
    expect(parseNamespaceSpelling("`a``b`")).toEqual(["a`b"]);
    expect(parseNamespaceSpelling("`a b`.`#tag`")).toEqual(["a b", "#tag"]);
    expect(parseNamespaceSpelling("`çatal`")).toEqual(["çatal"]);
    expect(parseNamespaceSpelling("a.b.c.d.e.f.g.h")).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  test.each(["", ".", "a.", ".a", "a..b", "1a", "a b", "``", "`a", "`a`b", "a.b.c.d.e.f.g.h.i", "a-b", "a.`b", " a"])(
    "refuses %p",
    (text) => {
      expect(parseNamespaceSpelling(text)).toBeUndefined();
    },
  );

  test("agrees with SPARK_NAMESPACE_PATTERN on every sample, so the dialog and the provider refuse the same texts", () => {
    const samples = [
      "studio",
      "a.b",
      "`a.b`.c",
      "`a``b`",
      "``",
      "a.",
      "1a",
      "a.b.c.d.e.f.g.h",
      "a.b.c.d.e.f.g.h.i",
      "`x`.`y`.`z`",
      "`a`b`",
      "`a```",
      "a-b",
      "",
    ];
    for (const text of samples) {
      expect({ text, parsed: parseNamespaceSpelling(text) !== undefined }).toEqual({
        text,
        parsed: SPARK_NAMESPACE_PATTERN.test(text),
      });
    }
  });

  test("spellNamespace is its inverse: parsing a spelling gives the parts back", () => {
    const cases: readonly (readonly string[])[] = [
      ["studio"],
      ["a.b", "c"],
      ["a`b"],
      ["#tag", "select", "a b"],
      ["çatal", "_x1"],
      ["a", "b", "c", "d", "e", "f", "g", "h"],
    ];
    for (const parts of cases) expect(parseNamespaceSpelling(spellNamespace(parts))).toEqual(parts);
    expect(spellNamespace(["a.b", "c"])).toBe("`a.b`.c");
    expect(spellNamespace(parseNamespaceSpelling("`studio`") ?? [])).toBe("studio");
  });
});

describe("qualifiedName", () => {
  test("joins the catalog, the namespace spelling and the name, each spelled as Spark spells it", () => {
    expect(qualifiedName("spark_catalog", "studio")).toBe("`spark_catalog`.studio");
    expect(qualifiedName("spark_catalog", "studio", "every_type")).toBe("`spark_catalog`.studio.`every_type`");
    expect(qualifiedName("my-cat", "`a.b`.c", "#tag")).toBe("`my-cat`.`a.b`.c.`#tag`");
  });
});

describe("the field patterns the dialog copies", () => {
  test("the catalog pattern takes one name of 1 to 255 characters without a dot or a control character", () => {
    for (const ok of ["spark_catalog", "my-cat", "çatal", "x".repeat(255)])
      expect(SPARK_CATALOG_PATTERN.test(ok)).toBe(true);
    for (const refused of ["", "a.b", "a\tb", "a\nb", "x".repeat(256)])
      expect(SPARK_CATALOG_PATTERN.test(refused)).toBe(false);
  });

  test("the token pattern takes printable ASCII with no space at either end, the characters grpc-js takes in a non-binary header value", () => {
    expect(SPARK_TOKEN_PATTERN.test("")).toBe(true);
    expect(SPARK_TOKEN_PATTERN.test("a b-c/d=")).toBe(true);
    expect(SPARK_TOKEN_PATTERN.test("a b")).toBe(true);
    expect(SPARK_TOKEN_PATTERN.test("abc")).toBe(true);
    // A space at either end, the all-space token included.
    for (const refused of [" ", "  ", " abc", "abc "]) expect(SPARK_TOKEN_PATTERN.test(refused)).toBe(false);
    // U+0021 to U+007E each on its own, and U+0020 to U+007E together between two non-space ends.
    const printable = Array.from({ length: 0x7f - 0x20 }, (_, index) => String.fromCharCode(0x20 + index)).join("");
    expect(printable.length).toBe(95);
    expect(SPARK_TOKEN_PATTERN.test(`x${printable}x`)).toBe(true);
    for (const char of printable.slice(1)) expect(SPARK_TOKEN_PATTERN.test(char)).toBe(true);
    // Both ends of the range, then a line break, a NUL, a non-ASCII letter, a no-break space and a tab.
    for (const refused of ["a\u001fb", "a\u007fb", "a\rb", "a\nb", "a\0b", "caf\u00e9", "a\u00a0b", "a\tb"])
      expect(SPARK_TOKEN_PATTERN.test(refused)).toBe(false);
  });

  test("each pattern is spelled exactly", () => {
    expect(SPARK_CATALOG_PATTERN.source).toBe("^[^.\\p{Cc}]{1,255}$");
    expect(SPARK_CATALOG_PATTERN.flags).toBe("u");
    expect(SPARK_NAMESPACE_PATTERN.source).toBe(
      "^(?:[A-Za-z_][A-Za-z0-9_]*|`(?:[^`]|``)+`)(?:\\.(?:[A-Za-z_][A-Za-z0-9_]*|`(?:[^`]|``)+`)){0,7}$",
    );
    expect(SPARK_NAMESPACE_PATTERN.flags).toBe("");
    expect(SPARK_TOKEN_PATTERN.source).toBe("^(?:[\\x21-\\x7E](?:[\\x20-\\x7E]*[\\x21-\\x7E])?)?$");
    expect(SPARK_TOKEN_PATTERN.flags).toBe("");
  });
});
