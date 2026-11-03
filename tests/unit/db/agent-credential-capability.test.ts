import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { CONNECTION_FIELDS, SEED_AGENT_CREDENTIAL } from "@/lib/db/connection-fields";
import { createDatabaseProvider } from "@/lib/db/factory";
import { SearchHttpTransport } from "@/lib/db/providers/sql/search/http-transport";
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

/**
 * `SEED_AGENT_CREDENTIAL` (src/lib/db/connection-fields.ts) against the two sources it follows: the built provider's
 * `agentCredential` and the engine's `CONNECTION_FIELDS` row. The expected row is derived here from those two, the
 * actual one is the hand-written table, so a provider that changes its form fails this until the row follows.
 *
 * The rows a provider with no declared form is given no agent credential by, each with its reason. They are the only
 * rows accepted without a matching form: a user and a password together is what the factory asks such a provider for,
 * and these engines either have no field to put one in or would not be narrowed by it.
 */
const NO_AGENT_CREDENTIAL: Readonly<Partial<Record<DatabaseType, string>>> = {
  sqlite: "no password field: a file opened by path has no principal",
  duckdb: "no password field: a file opened by path has no principal",
  mtconnect: "no password field: the agent reads an unauthenticated HTTP endpoint",
  modbus: "no password field: Modbus TCP defines no authentication",
  sparkplug: "no password field: the broker connection is anonymous",
  spark: "a password field and no user field: the Spark provider refuses any user, so a pair cannot open",
  oxia: "a password field and no user field: the Oxia provider refuses any user, so a pair cannot open",
  firestore:
    "a password field and no user field: the service-account key is the whole credential, and a user is ignored",
  snmp: "a password field and no user field: the community is the whole credential, and a user is ignored",
  snowflake:
    "a user and a password, but the key-pair sign-in ignores the password and every statement runs as the connection's role, so the pair narrows no privilege",
};

/** The row the census expects from the provider's form and the engine's field row, before the named exceptions. */
function expectedRow(
  form: AgentCredentialForm | undefined,
  fields: readonly string[],
): "pair" | "dedicated-pair" | "secret" | null {
  if (form === "none") return null;
  if (form === "token" || form === "service-account-key") return "secret";
  if (form === "dedicated-user") return "dedicated-pair";
  return fields.includes("user") && fields.includes("password") ? "pair" : null;
}

describe("SEED_AGENT_CREDENTIAL against each provider's form and field row", () => {
  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s takes the seed agent credential its provider's form gives",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const form = provider.getCapabilities().agentCredential;
      const derived = expectedRow(form, CONNECTION_FIELDS[type]);
      const expected = NO_AGENT_CREDENTIAL[type] === undefined ? derived : null;
      expect(SEED_AGENT_CREDENTIAL[type]?.form ?? null).toBe(expected);
    },
  );

  test("every named exception is a provider with no declared form, and none is a row the derivation already gives", async () => {
    for (const type of Object.keys(NO_AGENT_CREDENTIAL) as DatabaseType[]) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      expect(provider.getCapabilities().agentCredential, type).toBeUndefined();
      const fields = CONNECTION_FIELDS[type];
      const reason = NO_AGENT_CREDENTIAL[type] ?? "";
      if (reason.startsWith("no password field")) expect(fields.includes("password"), type).toBe(false);
      if (reason.startsWith("a password field and no user field")) {
        expect(fields.includes("password") && !fields.includes("user"), type).toBe(true);
      }
      if (reason.startsWith("a user and a password")) expect(expectedRow(undefined, fields), type).toBe("pair");
    }
  });

  test("only Elasticsearch names a field that supersedes the agent's user and password", () => {
    const superseding = Object.fromEntries(
      SHIPPED_DATABASE_TYPES.flatMap((type) => {
        const fields = SEED_AGENT_CREDENTIAL[type]?.supersededBy ?? [];
        return fields.length === 0 ? [] : [[type, fields]];
      }),
    );
    // src/lib/db/providers/sql/search/http-transport.ts: the API key pair is sent in preference to user and password.
    expect(superseding).toEqual({ elasticsearch: ["apiKeyId", "apiKeySecret"] });
  });

  test("the Elasticsearch transport signs with the API key pair when a user and password stand beside it", () => {
    const transport = new SearchHttpTransport("elasticsearch", {
      ...CENSUS_CONNECTION.elasticsearch,
      apiKeyId: "not-a-real-key-id",
      apiKeySecret: "not-a-real-key-secret",
      user: "agent_reader",
      password: "not-a-real-password",
    });
    const authorization = (transport as unknown as { readonly authorization?: string }).authorization ?? "";
    expect(authorization.startsWith("ApiKey ")).toBe(true);
  });
});
