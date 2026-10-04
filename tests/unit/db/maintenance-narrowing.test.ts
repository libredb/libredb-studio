import { describe, expect, test } from "bun:test";
import {
  maintenanceControl,
  narrowMaintenance,
  withConnectedMaintenance,
  type MaintenanceDeclaration,
  type ProviderCapabilities,
} from "@/lib/db/types";

/**
 * The declaration a PostgreSQL-wire connection starts from, and what each measured server leaves of
 * it (#1387). The measured answers are the ones taken on 2026-10-04: CockroachDB v26.3.2 runs
 * `ANALYZE <table>` and refuses the bare `ANALYZE`, `VACUUM` and `REINDEX` in both forms.
 */
const POSTGRES_DECLARATION: Required<MaintenanceDeclaration> = {
  maintenanceOperations: ["vacuum", "analyze", "reindex", "kill"],
  maintenanceOperationSpecs: {
    vacuum: { label: "Vacuum Table", perEntity: true, global: true },
    analyze: { label: "Analyze Table", perEntity: true, global: true },
    reindex: { label: "Reindex Table", perEntity: true, global: true },
    kill: { label: "Terminate Backend", perEntity: false, global: false },
  },
};

const ACCEPTED = { perEntity: true, global: true } as const;
const REFUSED = { perEntity: false, global: false } as const;

describe("narrowMaintenance (#1387)", () => {
  test("not measured answers the declaration unchanged", () => {
    expect(narrowMaintenance(POSTGRES_DECLARATION, undefined)).toBe(POSTGRES_DECLARATION);
  });

  test("a server that accepts everything keeps every operation", () => {
    expect(
      narrowMaintenance(POSTGRES_DECLARATION, { vacuum: ACCEPTED, analyze: ACCEPTED, reindex: ACCEPTED }),
    ).toStrictEqual(POSTGRES_DECLARATION);
  });

  test("CockroachDB keeps a per-row Analyze and loses Vacuum and Reindex", () => {
    const narrowed = narrowMaintenance(POSTGRES_DECLARATION, {
      vacuum: REFUSED,
      analyze: { perEntity: true, global: false },
      reindex: REFUSED,
    });

    expect(narrowed.maintenanceOperations).toEqual(["analyze", "kill"]);
    expect(narrowed.maintenanceOperationSpecs).toStrictEqual({
      analyze: { label: "Analyze Table", perEntity: true, global: false },
      kill: { label: "Terminate Backend", perEntity: false, global: false },
    });
  });

  test("an operation the measurement does not name keeps its declaration", () => {
    const narrowed = narrowMaintenance(POSTGRES_DECLARATION, { vacuum: REFUSED, analyze: REFUSED, reindex: REFUSED });
    expect(narrowed.maintenanceOperations).toEqual(["kill"]);
  });

  test("a measured placement never widens what the provider declared", () => {
    const narrowed = narrowMaintenance(
      {
        maintenanceOperations: ["check"],
        maintenanceOperationSpecs: { check: { label: "Check", perEntity: true, global: false } },
      },
      { check: ACCEPTED },
    );
    expect(narrowed.maintenanceOperationSpecs.check).toStrictEqual({ label: "Check", perEntity: true, global: false });
  });

  test("an operation with no spec is kept as declared", () => {
    const narrowed = narrowMaintenance(
      { maintenanceOperations: ["vacuum"], maintenanceOperationSpecs: {} },
      { vacuum: REFUSED },
    );
    expect(narrowed).toStrictEqual({ maintenanceOperations: ["vacuum"], maintenanceOperationSpecs: {} });
  });
});

describe("withConnectedMaintenance (#1387)", () => {
  const declared = {
    supportsMaintenance: true,
    supportsExplain: true,
    ...POSTGRES_DECLARATION,
  } as unknown as ProviderCapabilities;

  test("the connected provider's maintenance replaces the declared half and nothing else", () => {
    const merged = withConnectedMaintenance(declared, {
      maintenanceOperations: ["analyze"],
      maintenanceOperationSpecs: { analyze: { label: "Analyze Table", perEntity: true, global: false } },
    });

    expect(merged?.supportsExplain).toBe(true);
    expect(maintenanceControl(merged, "analyze", "perEntity").offered).toBe(true);
    expect(maintenanceControl(merged, "analyze", "global").offered).toBe(false);
    expect(maintenanceControl(merged, "vacuum", "perEntity").offered).toBe(false);
  });

  test("either side absent answers the declared capabilities as they are", () => {
    expect(withConnectedMaintenance(declared, undefined)).toBe(declared);
    expect(withConnectedMaintenance(undefined, POSTGRES_DECLARATION)).toBeUndefined();
  });
});
