import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import {
  declaredEntityOperations,
  maintenanceControl,
  type MaintenanceOperation,
  type MaintenanceType,
  type ProviderCapabilities,
  type ProviderLabels,
} from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * What every shipped provider's per-row maintenance controls offer, pinned before the maintenance extensions of spec
 * 3.11 land and held unchanged after them.
 *
 * The four per-row surfaces ask `maintenanceControl` one question each: the Operations tab (`TABLE_ACTIONS`) and the
 * monitoring Tables tab (`MAINTENANCE_ACTIONS`) over the same five candidates in the same order, and both row menus
 * over `analyze` and the provider's `vacuumActionOperation` redirect. The table below is the one measured over these
 * questions at `42050550` (R46 C3): ten type-ids offer per-row controls on the two tabs, nine on the row menus, and
 * none declares a per-row operation outside `MaintenanceType`. Four type-ids joined after that measurement: `neo4j`
 * (#1239) offers none, `db2` (#1238) offers analyze and optimize on both, `qdrant` (vector-family spec 6.7)
 * offers none, since it declares no maintenance, and `milvus` (vector-family spec 5.8) offers Load and Release per
 * collection, the first per-row operations outside `MaintenanceType`, which the surfaces offer through
 * `declaredEntityOperations` rather than through these questions. Db2 also names the kinds its two
 * operations run on, which these questions do not pass: they ask as a table row does. Nothing here connects:
 * `CENSUS_CONNECTION` builds each provider unconnected, and `getCapabilities()` and `getLabels()` are declarations.
 */

/** The candidates of both tabs, in their display order. */
const ROW_CANDIDATES: readonly MaintenanceType[] = ["analyze", "vacuum", "optimize", "reindex", "check"];

/** The six members of `MaintenanceType`, the operations every surface already has candidates for. */
const MAINTENANCE_TYPE_MEMBERS: readonly MaintenanceOperation[] = [
  "vacuum",
  "analyze",
  "reindex",
  "kill",
  "optimize",
  "check",
];

interface SurfaceRow {
  /** The per-row controls of the Operations tab and of the Tables tab, which ask the same candidates. */
  readonly tabs: string;
  /** The maintenance items of both row menus. */
  readonly tree: string;
  /** Declared operations outside `MaintenanceType` that a per-row control could offer. */
  readonly outsideMaintenanceType: string;
}

function surfacesOf(capabilities: ProviderCapabilities, labels: ProviderLabels): SurfaceRow {
  const vacuumOperation = labels.vacuumActionOperation ?? "vacuum";
  return {
    tabs: ROW_CANDIDATES.filter((type) => maintenanceControl(capabilities, type, "perEntity").offered).join(","),
    tree: [
      maintenanceControl(capabilities, "analyze", "perEntity").offered ? "analyze" : null,
      maintenanceControl(capabilities, vacuumOperation, "perEntity").offered ? `vacuum(${vacuumOperation})` : null,
    ]
      .filter((item) => item !== null)
      .join("+"),
    outsideMaintenanceType: capabilities.maintenanceOperations
      .filter(
        (operation) =>
          !MAINTENANCE_TYPE_MEMBERS.includes(operation) &&
          maintenanceControl(capabilities, operation, "perEntity").offered,
      )
      .join(","),
  };
}

const NONE: SurfaceRow = { tabs: "", tree: "", outsideMaintenanceType: "" };

/** R46 C3's measured table, one row per shipped type-id. */
const EXPECTED: Readonly<Record<DatabaseType, SurfaceRow>> = {
  postgres: { tabs: "analyze,vacuum,reindex", tree: "analyze+vacuum(vacuum)", outsideMaintenanceType: "" },
  mysql: { tabs: "analyze,optimize,check", tree: "analyze+vacuum(optimize)", outsideMaintenanceType: "" },
  sqlite: { tabs: "analyze,reindex", tree: "analyze", outsideMaintenanceType: "" },
  libsql: { tabs: "reindex", tree: "", outsideMaintenanceType: "" },
  duckdb: { tabs: "analyze,vacuum", tree: "analyze+vacuum(vacuum)", outsideMaintenanceType: "" },
  oracle: { tabs: "analyze,optimize", tree: "analyze+vacuum(optimize)", outsideMaintenanceType: "" },
  mssql: { tabs: "analyze,optimize", tree: "analyze+vacuum(optimize)", outsideMaintenanceType: "" },
  clickhouse: { tabs: "analyze,optimize", tree: "analyze+vacuum(optimize)", outsideMaintenanceType: "" },
  druid: NONE,
  trino: NONE,
  cassandra: NONE,
  elasticsearch: NONE,
  opensearch: NONE,
  mongodb: { tabs: "analyze,vacuum,check", tree: "analyze+vacuum(vacuum)", outsideMaintenanceType: "" },
  couchbase: { tabs: "analyze,reindex", tree: "analyze", outsideMaintenanceType: "" },
  redis: NONE,
  prometheus: NONE,
  kafka: NONE,
  etcd: NONE,
  neo4j: NONE,
  milvus: { tabs: "", tree: "", outsideMaintenanceType: "load,release" },
  db2: { tabs: "analyze,optimize", tree: "analyze+vacuum(optimize)", outsideMaintenanceType: "" },
  qdrant: NONE,
  libredb: NONE,
};

describe("every shipped provider's per-row maintenance controls (R46 C3)", () => {
  test("the table names every shipped type-id and nothing else", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s offers what the measured table pins", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(surfacesOf(provider.getCapabilities(), provider.getLabels())).toEqual(EXPECTED[type]);
  });

  test("11 of 24 type-ids offer per-row controls on the two tabs, 10 on the row menus, one outside MaintenanceType", () => {
    const rows = Object.values(EXPECTED);
    expect(rows.length).toBe(24);
    expect(rows.filter((row) => row.tabs !== "").length).toBe(11);
    expect(rows.filter((row) => row.tree !== "").length).toBe(10);
    expect(rows.filter((row) => row.outsideMaintenanceType !== "").length).toBe(1);
  });
});

/**
 * Milvus is the one shipped provider that declares them (vector-family spec 5.8): Load and Release per collection,
 * each with a preview, Release behind the typed collection name, and the engine user named in the audit rows.
 */
const MILVUS_EXTENSIONS = {
  entityOperations: [
    { type: "load", label: "Load" },
    { type: "release", label: "Release" },
  ],
  previews: 2,
  typedTargets: 1,
  previewMaintenance: "function",
  engineUser: "function",
} as const;

describe("only milvus declares a maintenance extension of spec 3.11", () => {
  test.each([...SHIPPED_DATABASE_TYPES])("%s", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    const capabilities = provider.getCapabilities();
    const specs = Object.values(capabilities.maintenanceOperationSpecs ?? {});
    expect({
      entityOperations: declaredEntityOperations(capabilities),
      previews: specs.filter((spec) => spec?.preview === true).length,
      typedTargets: specs.filter((spec) => spec?.confirmation === "typed-target").length,
      previewMaintenance: typeof provider.previewMaintenance,
      engineUser: typeof provider.engineUser,
    }).toEqual(
      type === "milvus"
        ? MILVUS_EXTENSIONS
        : {
            entityOperations: [],
            previews: 0,
            typedTargets: 0,
            previewMaintenance: "undefined",
            engineUser: "undefined",
          },
    );
  });
});
