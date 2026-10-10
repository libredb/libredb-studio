/**
 * What the S3 provider declares before it connects: every capability written out, the labels,
 * `prepareQuery`, and a construction that touches no transport.
 */
import { describe, expect, test } from "bun:test";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { S3_KEY_SCAN } from "@/lib/db/providers/objectstore/s3/key-scan";
import { S3_LABELS } from "@/lib/db/providers/objectstore/s3/labels";
import { S3_OBJECT_KINDS } from "@/lib/db/providers/objectstore/s3/objects";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { s3Connection } from "../../../helpers/s3-connection";

/** A provider whose transport factory would fail the test if anything asked it for a transport. */
function declaredOnly(): { readonly provider: S3Provider; readonly asked: () => number } {
  let asked = 0;
  const provider = new S3Provider(
    s3Connection({ host: "not a host" }),
    {},
    {},
    {
      createTransport: () => {
        asked += 1;
        throw new Error("a declaration asked for a transport");
      },
    },
  );
  return { provider, asked: () => asked };
}

describe("declarations", () => {
  test("every capability member, each a decision", () => {
    const { provider, asked } = declaredOnly();
    expect(provider.getCapabilities()).toEqual({
      queryLanguage: "json",
      queryDialect: "s3",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 9000,
      statementTerminator: "none",
      containerLevels: [],
      objectKinds: S3_OBJECT_KINDS,
      keyScan: S3_KEY_SCAN,
      schemaRefreshPattern: "(?!)",
    });
    expect(asked()).toBe(0);
  });

  test("the labels are a copy of S3_LABELS", () => {
    const { provider } = declaredOnly();
    expect(provider.getLabels()).toEqual(S3_LABELS);
    expect(provider.getLabels()).not.toBe(S3_LABELS);
  });

  test("prepareQuery adds no limit and no page", () => {
    const { provider } = declaredOnly();
    expect(provider.prepareQuery("aws s3 ls")).toEqual({
      query: "aws s3 ls",
      wasLimited: false,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
    });
  });

  test("construction validates nothing and opens nothing", () => {
    const { provider, asked } = declaredOnly();
    expect(provider.isConnected()).toBe(false);
    expect(provider.connectWarnings()).toEqual([]);
    expect(asked()).toBe(0);
  });
});
