import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `ProviderCapabilities.agentCredential` across every shipped provider.
 *
 * `acquireExecutionProfileProvider` reads the declaration from the provider it builds and decides from it whether
 * `agentPassword` alone is a complete agent credential. A provider declaring it by mistake would turn a SQL engine's
 * half-configured credential, refused today, into an agent that logs in as the connection's user with another
 * password; a provider losing it would refuse every Kubernetes agent token. So the census pins which engines declare
 * it, and that the value is the literal `"token"` or absent.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a constructor, the reading
 * `CENSUS_CONNECTION` documents.
 */
const TOKEN_ENGINES: ReadonlySet<DatabaseType> = new Set<DatabaseType>(["kubernetes"]);

describe("agentCredential against each provider's own declaration", () => {
  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s declares the token form only where the agent takes a token",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      expect(provider.getCapabilities().agentCredential).toBe(TOKEN_ENGINES.has(type) ? "token" : undefined);
    },
  );
});
