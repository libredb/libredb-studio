/**
 * The row-menu gates over the inputs the dialect registry did not exist for, each answered as before it
 * (vector-family spec 3.8): a dialect declared beside SQL, a dialect only a host's own declaration can name, and
 * capabilities that have not arrived.
 */
import { describe, expect, test } from "bun:test";
import {
  offersCodeGeneration,
  offersColumnProfiling,
  offersCountQuery,
  type ProviderCapabilities,
} from "@/lib/db/types";

function makeCaps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    queryLanguage: "json",
    supportsExplain: false,
    supportsExternalQueryLimiting: false,
    supportsCreateTable: false,
    supportsInlineRowEdit: false,
    supportsMaintenance: false,
    maintenanceOperations: [],
    supportsConnectionString: false,
    schemaRefreshPattern: "",
    defaultPort: null,
    ...overrides,
  };
}

const gates = (caps: ProviderCapabilities | undefined) => ({
  profile: offersColumnProfiling(caps),
  code: offersCodeGeneration(caps),
  count: offersCountQuery(caps),
});

describe("a dialect declared beside SQL", () => {
  test("is offered Profile and the code generator but withheld its count, the asymmetry kept on purpose", () => {
    // offersColumnProfiling reads a dialect only beside "json"; offersCountQuery reads any declared dialect.
    for (const dialect of ["libredb", "redis"] as const) {
      expect(gates(makeCaps({ queryLanguage: "sql", queryDialect: dialect }))).toEqual({
        profile: true,
        code: true,
        count: false,
      });
    }
    for (const dialect of ["kafka", "etcd"] as const) {
      expect(gates(makeCaps({ queryLanguage: "sql", queryDialect: dialect }))).toEqual({
        profile: true,
        code: false,
        count: false,
      });
    }
  });
});

describe("a host declaring a dialect this release has no record for", () => {
  test("is withheld Profile and the count and offered the code generator, as before the registry", () => {
    for (const dialect of ["a-later-engine", "constructor", "toString", "__proto__"]) {
      const caps = makeCaps({ queryDialect: dialect as ProviderCapabilities["queryDialect"] });
      expect(gates(caps)).toEqual({ profile: false, code: true, count: false });
      expect(gates({ ...caps, queryLanguage: "promql" })).toEqual({ profile: false, code: false, count: false });
      expect(gates({ ...caps, queryLanguage: "influxql" })).toEqual({ profile: false, code: false, count: false });
    }
  });
});

describe("a host declaring a dialect that is not a string", () => {
  test("gets the answers of a dialect with no record and never throws, as before the registry", () => {
    // An own-key lookup would read `["kafka"]` as `kafka` and withhold the code generator, and throw on an object
    // whose `toString` is not callable; before the registry every such value missed every comparison.
    for (const dialect of [{ toString: 0 }, ["kafka"], ["etcd"], 42, true] as const) {
      const caps = makeCaps({ queryDialect: dialect as unknown as ProviderCapabilities["queryDialect"] });
      expect(gates(caps)).toEqual({ profile: false, code: true, count: false });
    }
  });
});

describe("capabilities that have not arrived", () => {
  test("offer nothing, while provider-meta is in flight or after it failed", () => {
    expect(gates(undefined)).toEqual({ profile: false, code: false, count: false });
  });
});
