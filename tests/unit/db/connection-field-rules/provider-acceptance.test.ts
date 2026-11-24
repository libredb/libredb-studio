/**
 * The shared field rules (src/lib/db/connection-field-rules.ts) take every value their engine's provider takes: the
 * test-connection path refuses with them before a provider is built, so a rule stricter than its provider would make
 * Test Connection refuse a connection that opening the same seed in the editor accepts.
 *
 * The oracle is the provider itself: every connection of the corpus (tests/helpers/field-rule-corpus.ts) the rules
 * refuse is built through the real factory and connected to the loopback address on port 1, where nothing answers, so a
 * refusal raised as a `DatabaseConfigError` is one raised before any socket, and anything else means the provider took
 * the value and dialled. Only the connections the rules refuse are dialled, and each engine's base once, as the control
 * that a refusal is the field's own and not the base's.
 *
 * Snowflake is left out: its endpoint is a public host by construction, so no Snowflake connection can be dialled on
 * loopback. Its Account check is `connect()`'s own function by identity and its required sentences are the account
 * module's own, which tests/unit/lib/db/connection-form.test.ts and tests/unit/lib/db-ui-config.test.ts hold.
 *
 * Kubernetes refuses plain HTTP unless KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT is on, which this file sets for its own
 * process before the factory loads, and restores after.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { connectionFieldRefusal } from "@/lib/db/connection-field-rules";
import { DatabaseConfigError } from "@/lib/db/errors";
import { readClusterEndpoint } from "@/lib/db/providers/platform/kubernetes/connection-options";
import { buildSparkConnectionOptions } from "@/lib/db/providers/sql/spark/connection-options";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { fieldRuleBase, fieldRuleCorpus, fieldRuleEngines } from "../../../helpers/field-rule-corpus";

const LOOPBACK_PLAINTEXT = "KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT";
const previousLoopbackPlaintext = process.env[LOOPBACK_PLAINTEXT];
process.env[LOOPBACK_PLAINTEXT] = "true";
afterAll(() => {
  if (previousLoopbackPlaintext === undefined) delete process.env[LOOPBACK_PLAINTEXT];
  else process.env[LOOPBACK_PLAINTEXT] = previousLoopbackPlaintext;
});
const { createDatabaseProvider } = await import("@/lib/db/factory");

/** The engines the oracle can dial on loopback: every engine with field rules but Snowflake. */
const DIALLED: readonly DatabaseType[] = fieldRuleEngines().filter((type) => type !== "snowflake");

const REFUSED = "refused before a socket";

/**
 * What the provider answers `connection`: `REFUSED` when its build or its connect raises a `DatabaseConfigError`,
 * else what happened, named. Each error is taken by a plain await in try and catch.
 */
async function providerAnswer(connection: DatabaseConnection): Promise<string> {
  let provider: Awaited<ReturnType<typeof createDatabaseProvider>>;
  try {
    provider = await createDatabaseProvider(connection, { queryTimeout: 2000 }, {});
  } catch (error) {
    return error instanceof DatabaseConfigError ? REFUSED : `the build threw ${String(error)}`;
  }
  let answer: string;
  try {
    await provider.connect();
    answer = "connected";
  } catch (error) {
    answer = error instanceof DatabaseConfigError ? REFUSED : `reached the socket: ${String(error)}`;
  }
  await provider.disconnect();
  return answer;
}

describe("the shared field rules against their providers", () => {
  test("each engine's base connection passes its provider's checks and reaches the loopback socket", async () => {
    expect(DIALLED).toEqual(["databend", "kubernetes", "rabbitmq", "s3", "spark"]);
    for (const type of DIALLED) {
      // oxlint-disable-next-line no-await-in-loop -- one dial at a time, so each answer is its own connection's.
      const answer = await providerAnswer(fieldRuleBase(type));
      expect({ type, reached: answer.startsWith("reached the socket: ") }).toEqual({ type, reached: true });
    }
  });

  test("every connection the shared field rules refuse, its engine's provider refuses before it opens a socket", async () => {
    const accepted: string[] = [];
    let refused = 0;
    for (const entry of fieldRuleCorpus()) {
      if (!DIALLED.includes(entry.type)) continue;
      if (connectionFieldRefusal(CONNECTION_FORM[entry.type], entry.connection) === undefined) continue;
      refused += 1;
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const answer = await providerAnswer(entry.connection);
      if (answer !== REFUSED) accepted.push(`${entry.label}: ${answer}`);
    }
    expect(accepted).toEqual([]);
    // The control that the corpus reaches the rules at all.
    expect(refused).toBeGreaterThan(500);
  });

  test("a whitespace-only Kubernetes Namespaces or Spark Namespace passes the shared rules and its provider reads it as none", () => {
    for (const namespaces of [" ", "  ", "\t", " , ", ","]) {
      const connection = { ...fieldRuleBase("kubernetes"), namespaces } as DatabaseConnection;
      expect({ namespaces, refusal: connectionFieldRefusal(CONNECTION_FORM.kubernetes, connection) }).toEqual({
        namespaces,
        refusal: undefined,
      });
      const endpoint = readClusterEndpoint(connection, {
        queryTimeout: 30_000,
        appVersion: null,
        egress: ALLOWS_PRIVATE_HOSTS,
      });
      expect({ namespaces, read: endpoint.namespaces }).toEqual({ namespaces, read: undefined });
    }
    for (const schema of [" ", "  ", "\t", "\n"]) {
      const connection = { ...fieldRuleBase("spark"), schema } as DatabaseConnection;
      expect({ schema, refusal: connectionFieldRefusal(CONNECTION_FORM.spark, connection) }).toEqual({
        schema,
        refusal: undefined,
      });
      const options = buildSparkConnectionOptions(connection, { queryTimeout: 30_000 });
      expect({ schema, has: "namespace" in options }).toEqual({ schema, has: false });
    }
  });
});
