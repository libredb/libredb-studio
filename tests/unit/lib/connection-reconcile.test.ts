import { describe, expect, test } from "bun:test";
import { reconcileConnections } from "@/lib/connection-reconcile";
import type { DatabaseConnection } from "@/lib/types";

type ConnectionRow = DatabaseConnection & { roles?: string[] };

const connection = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  id: "seed:orders",
  seedId: "orders",
  name: "Orders",
  type: "postgres",
  managed: true,
  createdAt: new Date(0),
  ...overrides,
});

describe("reconcileConnections", () => {
  test("an unchanged answer keeps the array and its rows", () => {
    const previous = [
      connection({ roles: ["admin"], ssl: { mode: "verify-ca", rejectUnauthorized: true, caCert: "certificate" } }),
    ];
    const next = [
      connection({ roles: ["admin"], ssl: { mode: "verify-ca", rejectUnauthorized: true, caCert: "certificate" } }),
    ];

    expect(reconcileConnections(previous, next)).toBe(previous);
    expect(reconcileConnections(previous, previous)).toBe(previous);
  });

  test("an unchanged empty answer keeps the array", () => {
    const previous: DatabaseConnection[] = [];
    expect(reconcileConnections(previous, [])).toBe(previous);
  });

  test("an editable seed keeps its object when the server stamps a new createdAt", () => {
    const previous = [connection({ managed: false })];
    const next = [connection({ managed: false, createdAt: new Date(1000) })];

    expect(reconcileConnections(previous, next)).toBe(previous);
  });

  test("a timestamp change without seedId replaces the row even when managed is true", () => {
    const previous = [connection({ id: "own", seedId: undefined })];
    const next = [connection({ id: "own", seedId: undefined, createdAt: new Date(1000) })];

    expect(reconcileConnections(previous, next)[0]).toBe(next[0]);
  });

  test("an unchanged user timestamp compares by value", () => {
    const previous = [connection({ id: "own", seedId: undefined, managed: false })];
    const next = [connection({ id: "own", seedId: undefined, managed: false })];

    expect(reconcileConnections(previous, next)).toBe(previous);
  });

  test("a reorder lands with both rows reused", () => {
    const previous = [connection(), connection({ id: "seed:catalog", seedId: "catalog", name: "Catalog" })];
    const next = [{ ...previous[1] }, { ...previous[0] }];
    const result = reconcileConnections(previous, next);

    expect(result).not.toBe(previous);
    expect(result[0]).toBe(previous[1]);
    expect(result[1]).toBe(previous[0]);
  });

  test("new and withdrawn rows keep the surviving row's identity", () => {
    const previous = [connection()];
    const added = connection({ id: "seed:catalog", seedId: "catalog" });
    const result = reconcileConnections(previous, [{ ...previous[0] }, added]);

    expect(result[0]).toBe(previous[0]);
    expect(result[1]).toBe(added);
    expect(reconcileConnections(result, [{ ...previous[0] }])[0]).toBe(previous[0]);
    expect(reconcileConnections(result, [])).toEqual([]);
  });

  test("changed fields, nested values and field counts replace only the changed row", () => {
    const previous = [
      connection({ roles: ["admin"], ssl: { mode: "verify-ca", rejectUnauthorized: true, caCert: "certificate" } }),
    ];
    const changes: Partial<ConnectionRow>[] = [
      { name: "Renamed" },
      { host: "new.example" },
      { roles: ["viewer"] },
      { roles: [] },
      { ssl: { mode: "verify-ca", rejectUnauthorized: true, caCert: "changed" } },
      { ssl: { mode: "verify-ca", rejectUnauthorized: true } },
      { ssl: undefined },
    ];
    for (const overrides of changes) {
      const next = [{ ...previous[0], ...overrides }];
      expect(reconcileConnections(previous, next)[0]).toBe(next[0]);
    }
  });
});
