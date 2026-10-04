import { describe, expect, test } from "bun:test";
import { declaredEntityOperations, maintenanceControl, type ProviderCapabilities } from "@/lib/db/types";
import { SYNTHETIC_ENTITY_CAPABILITIES } from "../../fixtures/maintenance-entity-operations";

/**
 * The two per-row extensions of spec 3.11 as the one gate reads them: `maintenanceControl` carries a `"typed-target"`
 * confirmation and `preview: true` exactly where a spec declares them, and `declaredEntityOperations` lists every
 * declared operation outside `MaintenanceType` that a per-row control may offer, in declaration order.
 */

const capabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities =>
  ({ ...SYNTHETIC_ENTITY_CAPABILITIES, ...overrides }) as ProviderCapabilities;

describe("maintenanceControl and the per-row extensions (spec 3.11)", () => {
  test("a typed target and a preview travel with the answer, each on its own", () => {
    expect(maintenanceControl(capabilities(), "compact", "perEntity")).toStrictEqual({
      offered: true,
      label: "Load Object",
      confirmation: "typed-target",
      preview: true,
    });
    expect(maintenanceControl(capabilities(), "disarm", "perEntity")).toStrictEqual({
      offered: true,
      label: "Release Object",
      confirmation: "typed-target",
    });
  });

  test("the whole-database answer of a per-row operation carries them and stays refused", () => {
    expect(maintenanceControl(capabilities(), "compact", "global")).toStrictEqual({
      offered: false,
      label: "Load Object",
      confirmation: "typed-target",
      preview: true,
    });
  });

  test("a spec that declares neither answers no such key", () => {
    expect(Object.keys(maintenanceControl(capabilities(), "analyze", "perEntity"))).toEqual(["offered", "label"]);
  });
});

describe("declaredEntityOperations (spec 3.11)", () => {
  test("every declared per-row operation outside MaintenanceType, in declaration order, under its own label", () => {
    expect(declaredEntityOperations(capabilities())).toEqual([
      { type: "disarm", label: "Release Object" },
      { type: "compact", label: "Load Object" },
    ]);
  });

  test("a MaintenanceType member is never listed, per row or not: each surface draws those from its own candidates", () => {
    const types = declaredEntityOperations(capabilities()).map((operation) => operation.type);
    expect(types).not.toContain("analyze");
  });

  test("a whole-database operation outside MaintenanceType is not a per-row control", () => {
    const types = declaredEntityOperations(capabilities()).map((operation) => operation.type);
    expect(types).not.toContain("defragment");
  });

  test("an operation declared twice is listed once", () => {
    expect(declaredEntityOperations(capabilities({ maintenanceOperations: ["compact", "disarm", "compact"] }))).toEqual(
      [
        { type: "compact", label: "Load Object" },
        { type: "disarm", label: "Release Object" },
      ],
    );
  });

  test("an operation that names its kinds is listed for a row of those kinds, and for a caller that names no kind", () => {
    const kinded = capabilities({
      maintenanceOperationSpecs: {
        ...SYNTHETIC_ENTITY_CAPABILITIES.maintenanceOperationSpecs,
        compact: { ...SYNTHETIC_ENTITY_CAPABILITIES.maintenanceOperationSpecs.compact, kinds: ["table"] },
      },
    });
    const types = (kind?: string) => declaredEntityOperations(kinded, kind).map((operation) => operation.type);

    expect(types("table")).toEqual(["disarm", "compact"]);
    expect(types("view")).toEqual(["disarm"]);
    // The Operations and Tables tabs list tables and name no kind, as they do for their MaintenanceType candidates.
    expect(types()).toEqual(["disarm", "compact"]);
  });

  test("unknown capabilities, an engine with no maintenance and an operation with no spec offer nothing", () => {
    expect(declaredEntityOperations(undefined)).toEqual([]);
    expect(declaredEntityOperations(capabilities({ supportsMaintenance: false }))).toEqual([]);
    // With no spec there is no label, and an operation outside MaintenanceType has no generic verb to fall back on.
    expect(declaredEntityOperations(capabilities({ maintenanceOperationSpecs: {} }))).toEqual([]);
  });

  test("etcd's own declaration, whole-database cards only, lists nothing", () => {
    expect(
      declaredEntityOperations(
        capabilities({
          maintenanceOperations: ["compact", "defragment", "disarm"],
          maintenanceOperationSpecs: {
            compact: { label: "Compact history", perEntity: false, global: true },
            defragment: { label: "Defragment", perEntity: false, global: true },
            disarm: { label: "Disarm alarms", perEntity: false, global: true },
          },
        }),
      ),
    ).toEqual([]);
  });
});
