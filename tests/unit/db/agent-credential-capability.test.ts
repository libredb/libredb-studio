import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { AgentCredentialForm } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * `ProviderCapabilities.agentCredential` across every shipped provider.
 *
 * `acquireExecutionProfileProvider` reads the declaration from the provider it builds and decides from it which agent
 * credential is complete. A provider declaring a form by mistake would change what its agent signs in as: the token
 * form would turn a SQL engine's half-configured credential, refused today, into an agent that logs in as the
 * connection's user with another password, and `"none"` would refuse a credential the engine needs. A provider losing
 * its form would refuse every Kubernetes agent token. So the census pins which engines declare which form, and that
 * every other engine declares none, the user-and-password form.
 *
 * `"dedicated-user"` has no row: no shipped engine declares it yet (Snowflake's key-pair sign-in reads `privateKey`,
 * which the agent credential does not reach), so a row appears here with the engine that does.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a constructor, the reading
 * `CENSUS_CONNECTION` documents.
 */
const DECLARED_FORMS: Readonly<Partial<Record<DatabaseType, AgentCredentialForm>>> = {
  kubernetes: "token",
  qdrant: "token",
  weaviate: "token",
  libsql: "token",
  influxdb3: "token",
  bigquery: "service-account-key",
  libredb: "none",
};

describe("agentCredential against each provider's own declaration", () => {
  test.each([...SHIPPED_DATABASE_TYPES])("%s declares the agent credential form the census names", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(provider.getCapabilities().agentCredential).toBe(DECLARED_FORMS[type]);
  });
});
