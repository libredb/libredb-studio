/**
 * The level above the deepest, as every provider that declares a grounding walk scope marks it.
 *
 * The grounding walk reads one fact off that level: which parent is the session's. `scopeReadsUnder` in
 * `src/lib/db/container-walk.ts` reads below a parent marked `isSessionDefault`, so a failed listing below it ends the
 * capture rather than being named as not read, and `whenNoDefault` reads the children of that same parent. A scoped
 * provider that marked its deepest default and not the parent above it would lose both with no failing test of its own:
 * its session's catalog, failing to list, would be named as not read, and the run grounded on nothing of the session's.
 *
 * So each scoped provider with a level above the deepest is driven here through its provider class's own
 * `listContainers`, connected on one session through the seam its own tests use: Snowflake over the scripted node
 * transport, which answers its connect, SHOW DATABASES and SHOW SCHEMAS, and Apache Spark over the recorded transport,
 * which answers from the captures of a session in spark_catalog.studio. A provider class that stops passing the mark
 * through to either level the walk reads fails here by name. Kubernetes and RabbitMQ declare one container level, so no
 * parent is ever listed and `scopeReadsUnder` is never asked; their depth is held instead. The census builds every
 * shipped provider unconnected, as the capability censuses do, and fails on a provider that declares a scope and is
 * not held here, so a new scoped provider arrives with its proof. The check itself is proven both ways: each
 * provider's listing passes it, and that listing with the mark dropped at either level fails it by name, as does a
 * planted listing that stops marking the parent.
 */
import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { scopeReadsUnder, sessionDefaultContainer } from "@/lib/db/container-walk";
import { createDatabaseProvider } from "@/lib/db/factory";
import { containerDepth } from "@/lib/db/object-kinds";
import { SnowflakeProvider } from "@/lib/db/providers/sql/snowflake/index";
import { SparkProvider } from "@/lib/db/providers/sql/spark/index";
import type { Container, DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import type { SparkCaptureName } from "../../../live/spark-evidence-plan";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import { resultAnswer } from "../../../helpers/snowflake-answers";
import { fakeClock, scriptedTransports, testDeps } from "../../../helpers/snowflake-node-transport";
import { roleAnswer, SUBMIT } from "../../../helpers/snowflake-statements";
import { recordedSparkTransport } from "../../../helpers/spark-fixtures";

/** A provider's `listContainers` on one session: the top level, or the level below `parent`. */
type Listing = (parent?: readonly string[]) => Promise<readonly Container[]>;

/** A provider connected on one session through its own seam: its listing, and `done`, which disconnects it. */
interface Connected {
  readonly listing: Listing;
  readonly done: () => Promise<void>;
}

/** A session's deepest container, and a provider connected on that session. */
interface ParentProof {
  readonly sessionDefault: readonly string[];
  readonly connected: () => Promise<Connected>;
}

/** The provider class's own `listContainers`, the method the walk calls. */
const listingOf =
  (provider: DatabaseProvider): Listing =>
  (parent) =>
    parent === undefined ? provider.listContainers() : provider.listContainers(parent);

/** A Snowflake answer of one `name` column, as SHOW DATABASES and SHOW SCHEMAS answer. */
const names = (...rows: string[]) =>
  resultAnswer({ columns: [{ name: "name", type: "text" }], rows: rows.map((name) => [name]) });

/**
 * A Spark connect with a Catalog and a Namespace, as the integration replay records it: the version read and the
 * probe's release, the metadata session's setup with SET CATALOG and USE NAMESPACE, and SHOW CURRENT NAMESPACE answering
 * spark_catalog.studio; then SHOW CATALOGS, the configured catalog keys and SHOW NAMESPACES of spark_catalog.
 */
const SPARK_STUDIO_SESSION: readonly SparkCaptureName[] = [
  "connect-version",
  "release-session",
  "connect-session-setup",
  "set-catalog",
  "use-namespace",
  "connect-current-namespace-studio",
  "show-catalogs",
  "config-catalog-keys",
  "show-namespaces",
];

/** Every shipped provider that declares `agentWalkScope`: one container level, or the proof of its parent's mark. */
const HELD: Readonly<Partial<Record<DatabaseType, "one level" | ParentProof>>> = {
  kubernetes: "one level",
  rabbitmq: "one level",
  // A connection whose Database is `sales` and whose Schema is `public`, which Snowflake folds to upper case.
  snowflake: {
    sessionDefault: ["SALES", "PUBLIC"],
    connected: async () => {
      const transports = scriptedTransports();
      const provider = new SnowflakeProvider(
        {
          id: "sf",
          name: "Snowflake",
          type: "snowflake",
          host: "myorg-myacct",
          user: "studio_svc",
          role: "STUDIO_RO",
          warehouse: "STUDIO_WH",
          database: "sales",
          schema: "public",
          authMethod: "pat",
          password: ["stand", "in", "pat"].join("-"),
          createdAt: new Date(0),
        } as DatabaseConnection,
        {},
        testDeps(transports, fakeClock()),
      );
      // The connect statement's warehouse row, then the role check answering the configured role.
      transports.answer(
        SUBMIT,
        resultAnswer({
          columns: ["name", "state", "size", "auto_resume"].map((name) => ({ name, type: "text" })),
          rows: [["STUDIO_WH", "STARTED", "X-Small", "true"]],
        }),
        roleAnswer("STUDIO_RO"),
      );
      await provider.connect();
      transports.answer(SUBMIT, names("ANALYTICS", "OTHER", "SALES"), names("INFORMATION_SCHEMA", "PUBLIC", "RAW"));
      return { listing: listingOf(provider), done: () => provider.disconnect() };
    },
  },
  // A session in spark_catalog.studio, beside the configured catalog Spark has not loaded.
  spark: {
    sessionDefault: ["spark_catalog", "studio"],
    connected: async () => {
      const transport = recordedSparkTransport("4.2.0", SPARK_STUDIO_SESSION);
      const provider = new SparkProvider(
        {
          id: "spark",
          name: "spark",
          type: "spark",
          host: "127.0.0.1",
          port: 15002,
          database: "spark_catalog",
          schema: "studio",
        } as DatabaseConnection,
        {},
        { transport },
      );
      await provider.connect();
      return {
        listing: listingOf(provider),
        done: async () => {
          await provider.disconnect();
          // A request no capture answered: the replay invents no answer.
          expect(transport.missed).toStrictEqual([]);
        },
      };
    },
  },
};

const ONE_LEVEL = Object.entries(HELD).flatMap(([type, held]) => (held === "one level" ? [type] : []));
const PROVEN = Object.entries(HELD).flatMap(([type, held]) =>
  held === undefined || held === "one level" ? [] : [[type, held] as const],
);

/** A container as a provider class that stopped passing the mark through would answer it: every field but the mark. */
const unmarked = (container: Container): Container =>
  Object.fromEntries(Object.entries(container).filter(([key]) => key !== "isSessionDefault")) as unknown as Container;

/** `listing` with the mark dropped from every container of one level the walk reads: the top, or the one below. */
const withoutMark =
  (listing: Listing, level: "top level" | "level below"): Listing =>
  async (parent) => {
    const answer = await listing(parent);
    return (parent === undefined) === (level === "top level") ? answer.map(unmarked) : answer;
  };

/** Each proven provider with the mark dropped at each level the walk reads, and the finding that names it. */
const DROPPED = PROVEN.flatMap(([type, proof]) => {
  const parent = JSON.stringify(proof.sessionDefault.slice(0, -1));
  return [
    [type, "top level", `the top level marks [] as the session's, not ${parent}`, proof] as const,
    [
      type,
      "level below",
      `below ${parent} the session's container is not ${JSON.stringify(proof.sessionDefault)}`,
      proof,
    ] as const,
  ];
});

/** A shipped provider's declarations, read off it unconnected. */
async function declarations(type: DatabaseType): Promise<ProviderCapabilities> {
  return (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
}

/**
 * What the walk needs of a scoped provider's listing and did not get, empty when it got all of it: one container of
 * the top level marked as the session's, the parent of `sessionDefault`; the scope reading below it; and
 * `sessionDefault` marked below it. The second holds for every marked parent while `scopeReadsUnder` reads the mark,
 * so it is the finding a `scopeReadsUnder` that stopped reading it would meet.
 */
async function parentMarkFindings(
  scope: ProviderCapabilities["agentWalkScope"],
  listing: Listing,
  sessionDefault: readonly string[],
): Promise<string[]> {
  const parent = sessionDefault.slice(0, -1);
  const marked = (await listing()).filter((container) => container.isSessionDefault === true);
  if (marked.length !== 1 || JSON.stringify(marked[0].path) !== JSON.stringify(parent)) {
    return [
      `the top level marks ${JSON.stringify(marked.map((container) => container.path))} as the session's, not ${JSON.stringify(parent)}`,
    ];
  }
  const below = sessionDefaultContainer(await listing(parent));
  return [
    ...(scopeReadsUnder(scope, marked[0]) ? [] : [`the scope reads nothing below ${JSON.stringify(parent)}`]),
    ...(JSON.stringify(below) === JSON.stringify(sessionDefault)
      ? []
      : [`below ${JSON.stringify(parent)} the session's container is not ${JSON.stringify(sessionDefault)}`]),
  ];
}

describe("the shipped providers that declare a grounding walk scope", () => {
  test("are exactly the ones held here, so a new one arrives with its proof", async () => {
    const declared = await Promise.all(SHIPPED_DATABASE_TYPES.map(declarations));
    const scoped: string[] = SHIPPED_DATABASE_TYPES.filter(
      (_type, index) => declared[index].agentWalkScope !== undefined,
    );

    expect(scoped.sort()).toStrictEqual(Object.keys(HELD).sort());
  });

  test.each(ONE_LEVEL)("%s declares one container level, so the walk lists no parent", async (type) => {
    expect(containerDepth(await declarations(type as DatabaseType))).toBe(1);
  });

  test.each(PROVEN)(
    "%s marks the session's parent, the one its scope reads below and its deepest default sits in",
    async (type, proof) => {
      const capabilities = await declarations(type as DatabaseType);
      const { listing, done } = await proof.connected();
      try {
        expect(containerDepth(capabilities)).toBe(2);
        expect(await parentMarkFindings(capabilities.agentWalkScope, listing, proof.sessionDefault)).toStrictEqual([]);
      } finally {
        await done();
      }
    },
  );

  test.each(DROPPED)(
    "%s's own listing with the mark dropped at the %s fails by name",
    async (type, level, finding, proof) => {
      const capabilities = await declarations(type as DatabaseType);
      const { listing, done } = await proof.connected();
      try {
        expect(
          await parentMarkFindings(capabilities.agentWalkScope, withoutMark(listing, level), proof.sessionDefault),
        ).toStrictEqual([finding]);
      } finally {
        await done();
      }
    },
  );
});

describe("the check refuses a listing that stops marking the session's parent", () => {
  const scope: ProviderCapabilities["agentWalkScope"] = {
    mode: "session-default",
    whenNoDefault: { walk: "parent-default-children" },
  };
  const SESSION = ["spark_catalog", "studio"];
  /** A two-level listing: the top level as given, and below any parent its `studio` marked as the session's. */
  const planted =
    (top: readonly Container[], marksBelow = true): Listing =>
    async (parent) =>
      parent === undefined
        ? top
        : [
            { path: [parent[0], "default"], name: "default", level: 1 },
            marksBelow
              ? { path: [parent[0], "studio"], name: "studio", level: 1, isSessionDefault: true }
              : { path: [parent[0], "studio"], name: "studio", level: 1 },
          ];
  const catalog = (name: string, isSessionDefault?: true): Container =>
    isSessionDefault === undefined
      ? { path: [name], name, level: 0 }
      : { path: [name], name, level: 0, isSessionDefault };

  test("the deepest default marked and its parent not", async () => {
    expect(
      await parentMarkFindings(scope, planted([catalog("spark_catalog"), catalog("lake")]), SESSION),
    ).toStrictEqual(['the top level marks [] as the session\'s, not ["spark_catalog"]']);
  });

  test("two parents marked", async () => {
    expect(
      await parentMarkFindings(scope, planted([catalog("spark_catalog", true), catalog("lake", true)]), SESSION),
    ).toStrictEqual(['the top level marks [["spark_catalog"],["lake"]] as the session\'s, not ["spark_catalog"]']);
  });

  test("another parent marked", async () => {
    expect(
      await parentMarkFindings(scope, planted([catalog("spark_catalog"), catalog("lake", true)]), SESSION),
    ).toStrictEqual(['the top level marks [["lake"]] as the session\'s, not ["spark_catalog"]']);
  });

  test("the parent marked and nothing below it", async () => {
    expect(
      await parentMarkFindings(scope, planted([catalog("spark_catalog", true), catalog("lake")], false), SESSION),
    ).toStrictEqual(['below ["spark_catalog"] the session\'s container is not ["spark_catalog","studio"]']);
  });
});
