/**
 * Opening a seed id with the Kubernetes access review on (src/lib/seed/resolve-connection.ts).
 *
 * Every miss answers the one 404 CONNECTION_NOT_FOUND, as governance does: an unknown id, a connection the review keeps
 * from the caller, one whose review failed, and a seed the caller's role may not see, which answers 403 with the review
 * off and so would confirm that the id exists. No unfiltered lookup runs, and each miss is audited as
 * `permission_denied` / `connection_not_granted` on target `kubernetes-access/connection`, metered per account.
 *
 * The seed file is the multi-role fixture; two connections that name their Kubernetes Secret are added beside it through
 * the seed lookup, as a Kubernetes discovery source would add them. The review runs against a fake API server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { type FakeKubernetesApi, startFakeKubernetesApi } from "../../helpers/kubernetes-access/fake-api";
import * as seedIndex from "@/lib/seed";
import type { ManagedConnection } from "@/lib/seed/types";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { resetAccessReviewDecisions } from "@/lib/kubernetes-access/decisions";
import { recordGroups, resetGroupRecords } from "@/lib/kubernetes-access/groups";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";

const FIXTURES = path.resolve(import.meta.dir, "../../fixtures/seed-connections");
const ISSUER = "https://rancher.example.com/oidc";
const ALICE = { role: "user", username: "u-alice", idpSubject: "u-alice", idpIssuer: ISSUER };

function reviewed(id: string, namespace: string, secret: string): ManagedConnection {
  return {
    id: `seed:${id}`,
    seedId: id,
    name: `${namespace}/${id} (CloudNativePG)`,
    type: "postgres",
    host: `${id}-rw.${namespace}.svc`,
    port: 5432,
    database: "app",
    user: "app",
    password: "example-only-password",
    managed: true,
    roles: ["*"],
    createdAt: new Date(0),
    literal: true,
    kubernetesSecret: { namespace, name: secret },
  };
}

const REVIEWED: Readonly<Record<string, ManagedConnection>> = {
  "k8s-cnpg-orders": reviewed("k8s-cnpg-orders", "team-a", "orders-app"),
  "k8s-cnpg-analytics": reviewed("k8s-cnpg-analytics", "team-b", "analytics-app"),
};

const NOT_FOUND = {
  name: "SeedConnectionError",
  message: "Connection not found: it does not exist or is not granted to you",
  statusCode: 404,
  code: "CONNECTION_NOT_FOUND",
};

const ENV: Readonly<Record<string, string>> = {
  SEED_CONFIG_PATH: path.join(FIXTURES, "multi-role-config.yaml"),
  ADMIN_PG_PASS: "admin-secret",
  USER_MYSQL_PASS: "user-secret",
  SHARED_PG_PASS: "shared-secret",
  BOTH_PG_PASS: "both-secret",
  KUBERNETES_ACCESS_REVIEW: "on",
  AUTH_SESSION_TTL_SECONDS: "900",
};

const original = seedIndex.getSeedConnectionById;
let api: FakeKubernetesApi;
let lookup: ReturnType<typeof spyOn>;
let unfiltered: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;

/** The audit lines written to stdout so far, parsed. */
const auditLines = () =>
  (log.mock.calls as unknown[][]).map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

const failureOf = (attempt: Promise<unknown>) => attempt.catch((thrown: unknown) => thrown);

beforeAll(async () => {
  api = await startFakeKubernetesApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
  api.reset();
  api.useEnv();
  api.grants = [
    { user: "u-alice", verb: "get", apiGroup: "", resource: "secrets", namespace: "team-a", name: "orders-app" },
  ];
  seedIndex.resetCache();
  resetAccessReviewDecisions();
  resetGroupRecords();
  clearRateLimitState();
  recordGroups(ISSUER, "u-alice", []);
  lookup = spyOn(seedIndex, "getSeedConnectionById").mockImplementation(async (id: string, roles: string[]) => {
    const found = REVIEWED[id];
    return found === undefined ? original(id, roles) : { ...found };
  });
  unfiltered = spyOn(seedIndex, "getSeedConnectionByIdUnfiltered");
  log = spyOn(console, "log").mockImplementation(() => {});
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  lookup.mockRestore();
  unfiltered.mockRestore();
  log.mockRestore();
  warn.mockRestore();
  api.restoreEnv();
  for (const name of Object.keys(ENV)) delete process.env[name];
  seedIndex.resetCache();
  resetAccessReviewDecisions();
  resetGroupRecords();
  clearRateLimitState();
});

describe("with the review on", () => {
  test("a reviewed connection the review allows opens, with its values as written", async () => {
    const opened = await resolveConnection({ connectionId: "seed:k8s-cnpg-orders" }, ALICE);
    expect(opened).toMatchObject({ id: "seed:k8s-cnpg-orders", password: "example-only-password", literal: true });
  });

  test("a denied reviewed id, an unknown id and a seed the role may not see answer the same 404, with no unfiltered lookup", async () => {
    const denied = await failureOf(resolveConnection({ connectionId: "seed:k8s-cnpg-analytics" }, ALICE));
    const unknown = await failureOf(resolveConnection({ connectionId: "seed:no-such-connection" }, ALICE));
    const hiddenByRole = await failureOf(resolveConnection({ connectionId: "seed:admin-only" }, ALICE));
    const claimed = await failureOf(
      resolveConnection(
        { connection: { id: "seed:k8s-cnpg-analytics", name: "Copy", type: "postgres", createdAt: new Date(0) } },
        ALICE,
      ),
    );
    for (const error of [denied, unknown, hiddenByRole, claimed]) {
      expect(error).toBeInstanceOf(SeedConnectionError);
      expect(error).toMatchObject(NOT_FOUND);
    }
    expect(unfiltered).not.toHaveBeenCalled();
  });

  test("a review that fails answers the same 404", async () => {
    api.answer = { status: 500, body: "{}" };
    expect(await failureOf(resolveConnection({ connectionId: "seed:k8s-cnpg-orders" }, ALICE))).toMatchObject(
      NOT_FOUND,
    );
  });

  test("a session without a groups record answers the same 404, and no review runs", async () => {
    resetGroupRecords();
    expect(await failureOf(resolveConnection({ connectionId: "seed:k8s-cnpg-orders" }, ALICE))).toMatchObject(
      NOT_FOUND,
    );
    expect(api.seen).toHaveLength(0);
  });

  test("a miss is audited on its own target, metered on the anon bucket per account", async () => {
    for (let attempt = 0; attempt < 7; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each miss spends the bucket in turn.
      await failureOf(resolveConnection({ connectionId: "seed:k8s-cnpg-analytics" }, ALICE));
    }
    const lines = auditLines();
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).toMatchObject({
        event: "permission_denied",
        action: "denied",
        outcome: "failure",
        actor: "u-alice",
        route: "kubernetes-access/connection",
        reason: "connection_not_granted",
        connection: "k8s-cnpg-analytics",
      });
    }
  });
});

describe("with the review off", () => {
  test("a seed the role may not see still answers 403, which is why the review needs the uniform 404", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    const error = await failureOf(resolveConnection({ connectionId: "seed:admin-only" }, ALICE));
    expect(error).toMatchObject({ statusCode: 403 });
    expect(unfiltered).toHaveBeenCalled();
  });
});
