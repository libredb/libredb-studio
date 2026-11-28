import { describe, test, expect, mock } from "bun:test";
import { providerTreeTarget } from "@/lib/api/session-target";
import { assertNotWholeServer, catalogChoice, catalogSessionConnection, scopeToCatalog } from "@/lib/db/catalog-scope";
import { DatabaseConfigError, UnknownProviderError } from "@/lib/db/errors";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
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

/** The catalog sessions a provider declares, honoured only where Studio's record bounds them (M-57). */
describe("catalog choice bounded by Studio's record (M-57)", () => {
  const postgres = { id: "c", name: "c", type: "postgres", host: "h", database: "" } as DatabaseConnection;
  const clickhouse = { id: "c", name: "c", type: "clickhouse", host: "h", database: "" } as DatabaseConnection;
  const declared: ProviderCapabilities = { catalogSessions: true } as ProviderCapabilities;
  const absent = {} as ProviderCapabilities;

  function provider(connection: DatabaseConnection, capabilities: ProviderCapabilities) {
    const session = { type: connection.type } as unknown as DatabaseProvider;
    const forCatalog = mock(async () => session);
    const built = {
      type: connection.type,
      config: connection,
      getCapabilities: () => capabilities,
      forCatalog,
    } as unknown as DatabaseProvider;
    return { built, forCatalog, session };
  }

  test("catalogChoice honours catalog sessions only where the provider declares them, Studio's record holds the engine, and the connection names no database", () => {
    expect(catalogChoice(postgres, declared)).toBe("honoured");
    expect(catalogChoice({ ...postgres, database: undefined }, absent)).toBe("not-declared");
    expect(catalogChoice({ ...postgres, database: "app" }, declared)).toBe("names-database");
    expect(catalogChoice({ ...postgres, database: undefined, connectionString: "postgresql://h/app" }, declared)).toBe(
      "names-database",
    );
    expect(catalogChoice(clickhouse, declared)).toBe("engine-not-recorded");
    expect(catalogChoice({ ...clickhouse, database: "app" }, absent)).toBe("not-declared");
    expect(catalogChoice({ ...clickhouse, database: "app" }, declared)).toBe("engine-not-recorded");
  });

  test("catalogChoice refuses a type that names no provider, by name", () => {
    const unknown = { ...postgres, type: "not-a-type" } as unknown as DatabaseConnection;
    expect(() => catalogChoice(unknown, declared)).toThrow(UnknownProviderError);
  });

  test("a provider that declares catalog sessions on a connection naming a database is refused a catalog by name, and no session opens", async () => {
    const { built, forCatalog } = provider({ ...postgres, database: "app" }, declared);
    const refusal = await scopeToCatalog(built, "shop").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DatabaseConfigError);
    expect((refusal as Error).message).toBe(
      'This postgres connection runs every request in its own database and cannot run one in "shop": it names its own database, so Studio honours no session per database its provider declares',
    );
    expect(forCatalog).not.toHaveBeenCalled();
  });

  test("a provider that declares catalog sessions on an engine Studio's record does not hold is refused a catalog by name, and no session opens", async () => {
    const { built, forCatalog } = provider(clickhouse, declared);
    const refusal = await scopeToCatalog(built, "shop").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DatabaseConfigError);
    expect((refusal as Error).message).toBe(
      'This clickhouse connection runs every request in its own database and cannot run one in "shop": its provider declares a session per database, which Studio grants no clickhouse connection',
    );
    expect(forCatalog).not.toHaveBeenCalled();
  });

  test("a server-level connection of an engine Studio's record holds runs a request in the catalog's session", async () => {
    const { built, forCatalog, session } = provider(postgres, declared);
    expect(await scopeToCatalog(built, "shop")).toBe(session);
    expect(forCatalog).toHaveBeenCalledWith("shop");
  });

  test("assertNotWholeServer refuses a provider that declares catalog sessions, whatever Studio's record and the connection say", () => {
    const naming = { ...clickhouse, database: "app" };
    expect(() => assertNotWholeServer(providerTreeTarget(provider(naming, declared).built))).toThrow(
      DatabaseConfigError,
    );
    expect(() => assertNotWholeServer(providerTreeTarget(provider(naming, absent).built))).not.toThrow();
  });
});
