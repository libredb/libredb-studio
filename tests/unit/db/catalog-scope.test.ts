import { describe, test, expect } from "bun:test";
import { catalogSessionConnection, scopeToCatalog } from "@/lib/db/catalog-scope";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/** Running a request in one catalog of a server-level connection (#1530). */
describe("catalog scope", () => {
  test("a connection that declares no catalog sessions refuses a catalog, whatever it implements", async () => {
    const pinned = { type: "postgres", getCapabilities: () => ({}), forCatalog: async () => undefined };
    await expect(scopeToCatalog(pinned as unknown as DatabaseProvider, "shop")).rejects.toThrow(DatabaseConfigError);
  });

  test("a session's connection is the same connection in the named database", () => {
    const connection = { id: "c", name: "c", type: "postgres", host: "h", database: "" } as DatabaseConnection;
    expect(catalogSessionConnection(connection, "shop")).toEqual({ ...connection, database: "shop" });
  });
});
