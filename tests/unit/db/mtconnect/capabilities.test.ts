/**
 * What the provider declares about itself, asserted flag by flag and then as a closed set.
 *
 * This suite exists because the declaration had none, and because of the shape a declaration test
 * fails in. Asserting eight false flags as one array of eight falses cannot tell which flag is
 * which: swap two of them in the source and the array still matches. So every flag is named, and
 * then the KEY SET is pinned as well, so that a member cannot enter the declaration silently.
 *
 * The provider class cannot be constructed here, because `DatabaseConnection.type` is a closed
 * union that does not yet carry this type id, which is the last step of the provider's PR. The
 * capability object is read off the prototype instead, which is enough: the method takes no
 * argument and reads no connection field.
 */
import { describe, expect, test } from "bun:test";
import { resolveTabType } from "@/lib/editor/tab-language";
import type { ProviderCapabilities } from "@/lib/db/types";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import {
  MTCONNECT_ABSENT_SURFACES,
  MTCONNECT_DEFAULT_PORT,
  MTCONNECT_OBJECT_KINDS,
} from "@/lib/db/providers/industrial/mtconnect/capabilities";

/** The declaration, read without a connection: `getCapabilities` reads none. */
const capabilities = MTConnectProvider.prototype.getCapabilities.call({}) as ProviderCapabilities;

describe("every flag by name", () => {
  test("the eight that are false are false, each named", () => {
    // Named one at a time on purpose. `[false, false, ...]` would pass with any two swapped.
    expect(capabilities.supportsExplain).toBe(false);
    expect(capabilities.supportsExternalQueryLimiting).toBe(false);
    expect(capabilities.supportsCreateTable).toBe(false);
    expect(capabilities.supportsInlineRowEdit).toBe(false);
    expect(capabilities.supportsTestDataGeneration).toBe(false);
    expect(capabilities.supportsResultPagination).toBe(false);
    expect(capabilities.supportsTransactions).toBe(false);
    expect(capabilities.supportsMaintenance).toBe(false);
    expect(capabilities.supportsConnectionString).toBe(false);
    expect(capabilities.declaresForeignKeys).toBe(false);
    expect(capabilities.tablesAreDerivedGroupings).toBe(false);
  });

  test("read-only is declared as a structural fact, not as a mode", () => {
    // MEASURED on the pinned agent: with `AllowPut = true` the agent's own Swagger grows from 15
    // operations to 39. So the guarantee cannot rest on an agent setting, and this flag says it
    // rests on the client's shape instead.
    expect(capabilities.enforcesReadOnly).toBe(true);
    expect(capabilities.maintenanceOperations).toEqual([]);
  });

  /**
   * The cost of registering late, closed (K-184).
   *
   * A provider whose `queryDialect` is absent falls through the tab-type ladder to the JSON rung,
   * so until the union member landed this provider's console would have been typed `mongodb` and
   * read as a MongoDB aggregation: `resolveTabType` reads the dialect FIRST and `queryLanguage`
   * only after. That is measured here in both directions rather than described, so the day someone
   * drops the dialect to make a registry conflict go away, this fails and names what it costs.
   */
  test("the tab type is this provider's own, and without the dialect it would be MongoDB's", () => {
    expect(resolveTabType(capabilities)).toBe("mtconnect");
    const withoutDialect = { ...capabilities, queryDialect: undefined } as ProviderCapabilities;
    expect(resolveTabType(withoutDialect)).toBe("mongodb");
  });

  test("the dialect is declared, and the language beside it is the slot it has to sit in", () => {
    // The dialect is what every reader that matters consults: it names the grammar the text really
    // is, one request line from a closed table of nine routes.
    expect(capabilities.queryDialect).toBe("mtconnect");
    // And `"json"` because a dialect is declared, not because the text is JSON. The field is a
    // closed union of five languages and a request line is none of them; kubectl and S3 declare the
    // same pair for a command line. Pinned here so that a reader of this file is not left thinking
    // the provider claims to speak JSON.
    expect(capabilities.queryLanguage).toBe("json");
  });

  test("the port and the refresh pattern are the measured ones", () => {
    expect(capabilities.defaultPort).toBe(MTCONNECT_DEFAULT_PORT);
    expect(MTCONNECT_DEFAULT_PORT).toBe(5000);
    // No read changes what the tree shows, so nothing ever asks for a refresh.
    expect(capabilities.schemaRefreshPattern).toBe("(?!)");
    expect(new RegExp(capabilities.schemaRefreshPattern ?? "").test("anything")).toBe(false);
  });

  test("one container level, the device, in the shape the repository declares", () => {
    expect(capabilities.containerLevels).toEqual([{ id: "schema", label: "Device", labelPlural: "Devices" }]);
    expect(capabilities.containerPathShapes).toBe("exact");
  });

  test("three object kinds, and no Keys panel surface", () => {
    expect(capabilities.objectKinds).toBe(MTCONNECT_OBJECT_KINDS);
    expect(capabilities.objectKinds?.map((kind) => kind.id)).toEqual(["dataitem", "condition", "asset"]);
    expect(capabilities.keyScan).toBeUndefined();
  });
});

describe("the declaration is a closed set", () => {
  /**
   * Every key the declaration carries, pinned.
   *
   * Naming each flag above catches a changed value. It does not catch a NEW key, and a new
   * capability key is how a provider quietly acquires a surface it was never reviewed for. This is
   * the half that catches that.
   */
  const EXPECTED_KEYS = [
    "containerLevels",
    "containerPathShapes",
    "declaresForeignKeys",
    "defaultPort",
    "enforcesReadOnly",
    "maintenanceOperations",
    "objectKinds",
    "queryDialect",
    "queryLanguage",
    "schemaRefreshPattern",
    "statementTerminator",
    "supportsConnectionString",
    "supportsCreateTable",
    "supportsExplain",
    "supportsExternalQueryLimiting",
    "supportsInlineRowEdit",
    "supportsMaintenance",
    "supportsResultPagination",
    "supportsTestDataGeneration",
    "supportsTransactions",
    "tablesAreDerivedGroupings",
  ] as const;

  test("the key set is exactly this, so a new key cannot enter unreviewed", () => {
    expect(Object.keys(capabilities).sort()).toEqual([...EXPECTED_KEYS]);
  });

  test("the keys this provider deliberately does NOT declare are absent, each named", () => {
    // Each absence is a decision recorded elsewhere, so each is asserted rather than assumed.
    expect(capabilities.keyScan).toBeUndefined(); // decision K-134: no Keys panel surface
    expect(capabilities.agentWalkScope).toBeUndefined(); // MEASURED: it cannot express what MT-S10 wants
    expect(capabilities.explainFormat).toBeUndefined(); // no explain, so no format
    expect(capabilities.identifierQuoting).toBeUndefined(); // the text is not SQL
    expect(capabilities.readsFileAccessPosture).toBeUndefined(); // the provider reads no local file
    expect(capabilities.singleWriterFile).toBeUndefined(); // there is no file
    expect(capabilities.supportsColumnProfiling).toBeUndefined();
    expect(capabilities.supportsQueryCancel).toBeUndefined();
  });

  /**
   * The absence LIST the provider publishes, held against the declaration itself.
   *
   * `MTCONNECT_ABSENT_SURFACES` names eleven surfaces this provider answers nothing for, and it was
   * read by no code and no test at all: `knip` reported it as an unused export, which is the same
   * family as the version constant that claimed a rule nothing applied. A list of absences nobody
   * checks is prose. Three of its entries have a capability key of their own and are checked above;
   * the rest are answered by a method, so the list is held here as a list: it says eleven things,
   * every one of them is a name this file or `index.ts` accounts for, and it carries no duplicate.
   */
  test("the published list of absent surfaces is the list, and nothing has quietly joined it", () => {
    expect(MTCONNECT_ABSENT_SURFACES).toHaveLength(11);
    expect(new Set(MTCONNECT_ABSENT_SURFACES).size).toBe(11);
    // The three that ARE capability keys resolve to an absent key, so the list and the declaration
    // cannot drift apart on those: a surface named here while declared there would fail.
    expect(capabilities.explainFormat).toBeUndefined();
    expect(MTCONNECT_ABSENT_SURFACES).toContain("explain");
    expect(capabilities.supportsResultPagination).toBe(false);
    expect(MTCONNECT_ABSENT_SURFACES).toContain("resultPagination");
    expect(capabilities.supportsConnectionString).toBe(false);
    expect(MTCONNECT_ABSENT_SURFACES).toContain("connectionString");
  });

  test("the set is not all one value, so a declaration of constants would fail here", () => {
    const values = Object.values(capabilities);
    expect(new Set(values.map((value) => typeof value)).size).toBeGreaterThan(1);
    expect(values.filter((value) => value === false).length).toBeGreaterThan(1);
    expect(values.filter((value) => value === true).length).toBe(1);
  });
});

/**
 * THE CLAIM THIS PROVIDER MAKES ABOUT ITS NEIGHBOURS, as the source states it.
 *
 * `capabilities.ts` argues that MTConnect declares no `keyScan` because every provider that does
 * has an UNBOUNDED keyspace, while a device model bounds this one. The argument is sound and the
 * sentence that carried it went stale anyway: it named six providers, OPC UA landed afterwards and
 * declared one, and nothing could see it - a numeral about OTHER providers is not held by any test
 * of theirs, and this provider's own suite never looked outside itself.
 *
 * So the census is taken from the built providers rather than written down. It is also the shape
 * that keeps working while four sibling providers are in flight: whichever of them declares a
 * key-space walk, this test counts it on the day it is read.
 */
describe("the key-space walk is declared by the providers with an unbounded keyspace", () => {
  test("MTConnect declares none, and the providers that do are counted from the real declarations", async () => {
    const declaring: string[] = [];
    for (const type of SHIPPED_DATABASE_TYPES) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      if (provider.getCapabilities().keyScan !== undefined) declaring.push(type);
    }
    // Named rather than counted: a count alone would hold while one engine replaced another, and
    // the sentence in `capabilities.ts` is an argument about WHICH keyspaces are unbounded.
    expect(declaring.sort()).toEqual(["etcd", "firestore", "mqtt", "opcua", "oxia", "redis", "s3"]);
    expect(declaring).not.toContain("mtconnect");
  });
});
