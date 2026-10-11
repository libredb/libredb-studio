import { afterEach, describe, expect, test } from "bun:test";
import { DB_UI_CONFIG, getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";
import { declareConnectionImport } from "../../helpers/synthetic-connection-import";

/**
 * Which shipped entries declare a connection import. A declaration puts a paste box for credentials in the dialog,
 * so the list is written out here, and an entry that gains or loses one changes this test in the same commit.
 */
const DECLARING: readonly DatabaseType[] = ["kubernetes"];

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

describe("connectionImport", () => {
  test("is declared by exactly the listed entries", () => {
    const declaring = (Object.keys(DB_UI_CONFIG) as DatabaseType[]).filter(
      (type) => getDBConfig(type).connectionImport !== undefined,
    );
    expect(declaring).toEqual([...DECLARING]);
  });

  test("the test helper declares an import on one entry and its undo takes it away again", async () => {
    const importer = () => ({ contexts: [], refusals: [] });
    restores.push(declareConnectionImport("etcd", { label: "Import", load: async () => importer }));
    expect(getDBConfig("etcd").connectionImport?.label).toBe("Import");
    expect(await getDBConfig("etcd").connectionImport?.load()).toBe(importer);
    for (const restore of restores.splice(0)) restore();
    expect(Object.hasOwn(getDBConfig("etcd"), "connectionImport")).toBe(false);
  });
});
