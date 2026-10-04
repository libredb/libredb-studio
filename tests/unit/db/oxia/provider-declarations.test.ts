/**
 * What the Oxia provider declares before it connects (SB2-9.1, SB2-9.2): every capability written out, the labels,
 * `prepareQuery`, the methods it does not have, and a construction that touches no socket.
 */
import { describe, expect, test } from "bun:test";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { OXIA_KEY_SCAN } from "@/lib/db/providers/keyvalue/oxia/key-scan";
import { OXIA_LABELS } from "@/lib/db/providers/keyvalue/oxia/labels";
import { OXIA_OBJECT_KINDS } from "@/lib/db/providers/keyvalue/oxia/objects";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { oxiaConnection } from "../../../helpers/oxia-connection";

/** A provider whose factory would fail the test if anything asked it for a client. */
function declaredOnly(): { readonly provider: OxiaProvider; readonly asked: () => number } {
  let asked = 0;
  const provider = new OxiaProvider(oxiaConnection(), {}, {}, () => {
    asked += 1;
    throw new Error("a declaration asked for a client");
  });
  return { provider, asked: () => asked };
}

describe("getCapabilities (SB2-9.1)", () => {
  test("every member is written, each a decision", () => {
    const { provider } = declaredOnly();
    expect(provider.getCapabilities()).toEqual({
      queryLanguage: "json",
      queryDialect: "oxia",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 6648,
      statementTerminator: "none",
      containerLevels: [],
      objectKinds: OXIA_OBJECT_KINDS,
      keyScan: OXIA_KEY_SCAN,
      schemaRefreshPattern: "(?!)",
    });
  });

  test("the absent members are absent: no explain format, no maintenance specs, no identifier quoting", () => {
    const capabilities = declaredOnly().provider.getCapabilities();
    for (const member of [
      "explainFormat",
      "maintenanceOperationSpecs",
      "identifierQuoting",
      "previewProjection",
      "containerPathShapes",
      "singleWriterFile",
    ]) {
      expect({ member, present: member in capabilities }).toEqual({ member, present: false });
    }
    expect(capabilities.objectKinds).toBe(OXIA_OBJECT_KINDS);
    expect(capabilities.keyScan).toBe(OXIA_KEY_SCAN);
  });

  test("the refresh pattern matches no command, so a read never reloads the tree", () => {
    const pattern = new RegExp(declaredOnly().provider.getCapabilities().schemaRefreshPattern, "i");
    for (const text of ["get /a", "list --prefix /", "put a b", ""]) expect(pattern.test(text)).toBe(false);
  });
});

describe("labels and prepareQuery (SB2-9.2)", () => {
  test("getLabels answers a copy of OXIA_LABELS", () => {
    const labels = declaredOnly().provider.getLabels();
    expect(labels).toEqual({ ...OXIA_LABELS });
    expect(labels).not.toBe(OXIA_LABELS);
  });

  test("the command carries its own bound: nothing is added, and there is no page two", () => {
    expect(declaredOnly().provider.prepareQuery("list --limit 5")).toEqual({
      query: "list --limit 5",
      wasLimited: false,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
    });
  });
});

describe("construction and presence", () => {
  test("a provider built for its declarations asks for no client and is not connected", () => {
    const { provider, asked } = declaredOnly();
    provider.getCapabilities();
    provider.getLabels();
    expect(asked()).toBe(0);
    expect(provider.isConnected()).toBe(false);
  });

  test("no presence-detected method that would do nothing, and the ones it has are found", () => {
    const { provider } = declaredOnly();
    for (const method of [
      "getPoolStats",
      "queryReadOnly",
      "endOpenQueryTransaction",
      "beginTransaction",
      "commitTransaction",
      "rollbackTransaction",
      "buildObjectEdit",
      "applyObjectEdit",
      "previewMaintenance",
    ]) {
      expect({ method, present: method in provider }).toEqual({ method, present: false });
    }
    for (const method of ["cancelQuery", "scanKeysPage", "readObjectSource"]) {
      expect({ method, present: method in provider }).toEqual({ method, present: true });
    }
  });
});
