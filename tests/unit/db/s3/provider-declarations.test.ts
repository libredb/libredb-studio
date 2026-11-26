/**
 * What the S3 provider declares before it connects: every capability written out, the labels,
 * `prepareQuery`, and a construction that touches no transport.
 */
import { describe, expect, test } from "bun:test";
import { legacyEngineGrants } from "@/lib/db/claim-grants";
import { summarizeWriteReach } from "@/lib/db/write-reach";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { S3_KEY_SCAN } from "@/lib/db/providers/objectstore/s3/key-scan";
import { S3_METADATA_ONLY } from "@/lib/db/providers/objectstore/s3/agent-metadata-read";
import { S3_LABELS } from "@/lib/db/providers/objectstore/s3/labels";
import { S3_OBJECT_KINDS } from "@/lib/db/providers/objectstore/s3/objects";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { s3Connection } from "../../../helpers/s3-connection";
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { type DatabaseConnection } from "@/lib/types";
import { legacyRegisterEngines, legacyRegisterTable } from "../../../helpers/legacy-register";

/** The engines whose legacy row of the grant register grants agent execution, in catalog order. */
const AGENT_EXECUTION = legacyRegisterEngines("agentExecution");

const agentCredentialRequired = legacyRegisterTable("agentCredentialRequired");
const exposable = legacyRegisterTable("exposable");
const statementRead = legacyRegisterTable("statementRead");

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
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      writeReach: {
        editor: {
          reach: "absent",
          proof: { module: "src/lib/db/providers/objectstore/s3/console/commands.ts", symbol: "S3_COMMAND_TABLE" },
        },
        objectEdit: { reach: "absent" },
        maintenance: { reach: "absent" },
        transaction: { reach: "absent" },
      },
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 9000,
      statementTerminator: "none",
      containerLevels: [],
      objectKinds: S3_OBJECT_KINDS,
      keyScan: S3_KEY_SCAN,
      schemaRefreshPattern: "(?!)",
      metadataOnly: S3_METADATA_ONLY,
      agentCredential: "dedicated-user",
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

test("s3's readOnlyEnforced grant equals the summary of the declared write reach", () => {
  expect(legacyEngineGrants("s3").readOnlyEnforced).toBe(true);
  expect(legacyEngineGrants("s3").readOnlyEnforced).toBe(
    summarizeWriteReach(declaredOnly().provider.getCapabilities().writeReach) !== "open",
  );
});

/** An unsigned connection to a loopback endpoint: every builder check passes, so an override isolates one rule. */
const CONNECTION = {
  id: "s3-doc",
  name: "S3 test",
  type: "s3",
  host: "localhost",
  port: 9000,
  user: "",
  password: "",
} as DatabaseConnection;
/** The provider every declaration case reads; it has no transport, so a call that would send fails loudly. */
const provider = new S3Provider(
  CONNECTION,
  {},
  { egress: ALLOWS_PRIVATE_HOSTS },
  {
    createTransport: () => {
      throw new Error("this test never connects");
    },
  },
);

describe("the records, the Keys panel, the labels and the maintenance refusal", () => {
  test("S3 is enforced read-only, exposed over MCP under an agent key, and run by the agent", () => {
    expect(legacyEngineGrants("s3").readOnlyEnforced).toBe(true);
    expect(exposable.s3).toBe(true);
    expect(statementRead.s3).toBe(true);
    expect(agentCredentialRequired.s3).toBe(true);
    expect(AGENT_EXECUTION).toContain("s3");
  });

  test("the Keys panel declares no result pagination, no container levels and the bucket as its root", () => {
    const capabilities = provider.getCapabilities();
    expect(capabilities.supportsResultPagination).toBe(false);
    expect(capabilities.containerLevels).toEqual([]);
    const keyScan = capabilities.keyScan;
    expect(keyScan?.levels?.rootKind).toBe("bucket");
  });

  test("the built provider's labels are S3_LABELS", () => {
    expect(provider.getLabels()).toEqual(S3_LABELS);
  });

  test("runMaintenance() is refused with the vacuum label's sentence", async () => {
    await expect(provider.runMaintenance()).rejects.toThrow(S3_LABELS.vacuumGlobalDesc);
  });
});
