/**
 * Which database one MCP tool call reads, on a connection that reaches a whole server (#1530).
 */

import { describe, test, expect, mock } from "bun:test";
import { McpDatabaseChoiceError, providerInDatabase } from "@/lib/mcp/tools/database-choice";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";

function pinned(): DatabaseProvider {
  return { type: "postgres", getCapabilities: () => ({}) } as unknown as DatabaseProvider;
}

function serverLevel(names: string[], forCatalog = mock(async (_catalog: string) => pinned())): DatabaseProvider {
  return {
    type: "postgres",
    getCapabilities: () => ({ catalogSessions: true }),
    listContainers: async () => names.map((name) => ({ path: [name], name, level: 0 })),
    forCatalog,
  } as unknown as DatabaseProvider;
}

describe("providerInDatabase", () => {
  test("a connection naming its own database is read as it is, and refuses another", async () => {
    const own = pinned();
    expect(await providerInDatabase(own, undefined)).toEqual({ kind: "chosen", provider: own });
    await expect(providerInDatabase(own, "shop")).rejects.toThrow(McpDatabaseChoiceError);
  });

  test("a call naming no database is told the databases it could name, at most fifty", async () => {
    const names = Array.from({ length: 52 }, (_, index) => `db${String(index).padStart(2, "0")}`);
    const refusal = providerInDatabase(serverLevel(names), undefined);
    await expect(refusal).rejects.toThrow(/one of: db00, db01, .*db49 and 2 more\./);
  });

  test("a role that can open no database is told so", async () => {
    await expect(providerInDatabase(serverLevel([]), undefined)).rejects.toThrow("can open none of them");
  });

  test("a named database is the session opened there", async () => {
    const session = pinned();
    const forCatalog = mock(async () => session);
    expect(await providerInDatabase(serverLevel(["shop"], forCatalog), "shop")).toEqual({
      kind: "chosen",
      provider: session,
    });
    expect(forCatalog).toHaveBeenCalledWith("shop");
  });

  test("a database the provider refuses to open is answered as the provider's refusal, and any other failure passes through", async () => {
    const refusal = new DatabaseConfigError(
      '"payroll" is not a database this PostgreSQL connection can open',
      "postgres",
    );
    const refused = mock(async () => {
      throw refusal;
    });
    expect(await providerInDatabase(serverLevel(["shop"], refused), "payroll")).toEqual({
      kind: "provider-refused",
      error: refusal,
    });
    const broken = mock(async () => {
      throw new Error("connection reset");
    });
    const failure = await providerInDatabase(serverLevel(["shop"], broken), "shop").catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(McpDatabaseChoiceError);
    expect((failure as Error).message).toBe("connection reset");
  });

  test("a provider that reaches a whole server and opens no database by name is refused in Studio's words, before it is asked", async () => {
    const provider = {
      type: "postgres",
      getCapabilities: () => ({ catalogSessions: true }),
      listContainers: async () => [],
    } as unknown as DatabaseProvider;
    await expect(providerInDatabase(provider, "shop")).rejects.toThrow(McpDatabaseChoiceError);
  });
});
