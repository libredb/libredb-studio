/**
 * Which connections a caller may see and open (spec 4.2, 5.2, 9.3): the dispatcher behind the managed route and
 * `resolveConnection`.
 *
 * Without governance it answers what the seed connections always answered for the caller's role. Under governance
 * it answers from the snapshot alone, for the caller's identity provider subject, whatever the role, and only while
 * the snapshot can be served. Snapshots are built directly with tests/helpers/governance/granted-snapshot.ts, so each
 * case states which subject holds which grant.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import path from "node:path";
import { SETTINGS_REGISTRY } from "@/lib/governance/settings-registry";
import { recordGovernanceFailure, recordGovernanceSnapshot, resetGovernanceState } from "@/lib/governance/state";
import {
  GOVERNANCE_UNAVAILABLE_MESSAGE,
  GovernanceUnavailableError,
  visibleConnectionById,
  visibleConnections,
} from "@/lib/governance/visible";
import { getManagedConnections, getSeedConnectionById, type ManagedConnection, resetCache } from "@/lib/seed";
import {
  admittedConnection,
  grantedSnapshot,
  READ_CREDENTIAL,
  WRITE_CREDENTIAL,
} from "../../../helpers/governance/granted-snapshot";

const FIXTURES = path.resolve(import.meta.dir, "../../../fixtures/seed-connections");

const T = Date.parse("2026-10-15T08:00:00.000Z");

const ENV: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: undefined,
  GOVERNANCE_REFRESH_MS: undefined,
  GOVERNANCE_MAX_STALENESS_MS: undefined,
  SEED_CONFIG_PATH: path.join(FIXTURES, "multi-role-config.yaml"),
  ADMIN_PG_PASS: "admin-secret",
  USER_MYSQL_PASS: "user-secret",
  SHARED_PG_PASS: "shared-secret",
  BOTH_PG_PASS: "both-secret",
};

let saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved = {};
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    setEnv(name, value);
  }
  resetCache();
  // A frozen clock: freshness, grant expiry and the createdAt of every seed record all read it.
  setSystemTime(new Date(T));
});

afterEach(() => {
  setSystemTime();
  resetGovernanceState();
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  resetCache();
});

const ALICE = { role: "user", username: "alice@example.com", idpSubject: "alice-subject" };
const ADMIN = { role: "admin", username: "admin@example.com", idpSubject: "admin-subject" };

/** The fields a governed record carries that tell the cases apart. */
const credentialOf = (connection: ManagedConnection | null) => {
  const { id, user, password, queryTimeout, literal, grantLevel } = (connection ?? {}) as Partial<ManagedConnection> & {
    readonly grantLevel?: unknown;
  };
  return { id, user, password, queryTimeout, literal, grantLevel };
};

describe("without governance", () => {
  test("lists exactly what getManagedConnections lists for the caller's role, whatever the subject", async () => {
    expect(await visibleConnections(ALICE)).toEqual(await getManagedConnections(["user"]));
    expect(await visibleConnections(ADMIN, { credential: "read" })).toEqual(await getManagedConnections(["admin"]));
  });

  test("finds exactly what getSeedConnectionById finds for the caller's role", async () => {
    expect(await visibleConnectionById(ALICE, "everyone")).toEqual(await getSeedConnectionById("everyone", ["user"]));
    expect(await visibleConnectionById(ALICE, "admin-only")).toBeNull();
    expect((await visibleConnectionById(ADMIN, "admin-only", { credential: "read" }))?.host).toBe("admin-pg.internal");
  });

  test("reads no governance snapshot: a snapshot that cannot be served changes nothing", async () => {
    recordGovernanceSnapshot(grantedSnapshot([], [], T - 3_600_000));
    expect((await visibleConnections(ALICE)).map((connection) => connection.seedId)).toEqual([
      "user-only",
      "everyone",
      "admin-and-user",
    ]);
  });
});

describe("under governance", () => {
  const ORDERS = admittedConnection("orders", { name: "Orders", write: true });
  const BILLING = admittedConnection("billing", { name: "Billing" });
  const CRM = admittedConnection("crm", { name: "CRM", write: true });

  beforeEach(() => {
    process.env.GOVERNANCE_SOURCE = "postgres";
  });

  test("an admin sees only its own grants", async () => {
    recordGovernanceSnapshot(
      grantedSnapshot(
        [ORDERS, BILLING, CRM],
        [
          { subject: ADMIN.idpSubject, connection: BILLING, level: "read" },
          { subject: ALICE.idpSubject, connection: ORDERS, level: "write" },
          { subject: ALICE.idpSubject, connection: CRM, level: "read" },
        ],
      ),
    );

    expect((await visibleConnections(ADMIN)).map((connection) => connection.id)).toEqual(["seed:billing"]);
    expect(await visibleConnectionById(ADMIN, "orders")).toBeNull();
    expect(await visibleConnectionById(ADMIN, "crm")).toBeNull();
    expect((await visibleConnectionById(ADMIN, "billing"))?.id).toBe("seed:billing");
  });

  test("a read grant carries the read credential and a write grant the write credential, with the timeout and both markers", async () => {
    recordGovernanceSnapshot(
      grantedSnapshot(
        [ORDERS, CRM],
        [
          { subject: ALICE.idpSubject, connection: ORDERS, level: "write" },
          { subject: ALICE.idpSubject, connection: CRM, level: "read" },
        ],
      ),
    );

    expect(credentialOf(await visibleConnectionById(ALICE, "orders"))).toEqual({
      id: "seed:orders",
      ...WRITE_CREDENTIAL,
      queryTimeout: 60000,
      literal: true,
      grantLevel: "write",
    });
    // CRM has a write credential, and a read grant never reaches it.
    expect(credentialOf(await visibleConnectionById(ALICE, "crm"))).toEqual({
      id: "seed:crm",
      ...READ_CREDENTIAL,
      queryTimeout: 60000,
      literal: true,
      grantLevel: "read",
    });
    expect((await visibleConnections(ALICE)).map(credentialOf)).toEqual([
      { id: "seed:crm", ...READ_CREDENTIAL, queryTimeout: 60000, literal: true, grantLevel: "read" },
      { id: "seed:orders", ...WRITE_CREDENTIAL, queryTimeout: 60000, literal: true, grantLevel: "write" },
    ]);
  });

  test("credential read always carries the read credential, whatever the grant", async () => {
    recordGovernanceSnapshot(
      grantedSnapshot([ORDERS], [{ subject: ALICE.idpSubject, connection: ORDERS, level: "write" }]),
    );

    expect(credentialOf(await visibleConnectionById(ALICE, "orders", { credential: "read" }))).toEqual({
      id: "seed:orders",
      ...READ_CREDENTIAL,
      queryTimeout: 60000,
      literal: true,
      grantLevel: "read",
    });
    expect((await visibleConnections(ALICE, { credential: "read" })).map(credentialOf)).toEqual([
      { id: "seed:orders", ...READ_CREDENTIAL, queryTimeout: 60000, literal: true, grantLevel: "read" },
    ]);
    expect(credentialOf(await visibleConnectionById(ALICE, "orders", { credential: "grant" })).grantLevel).toBe(
      "write",
    );
  });

  test("the timeout is the default of the query.timeoutMs runtime setting", async () => {
    recordGovernanceSnapshot(
      grantedSnapshot([BILLING], [{ subject: ALICE.idpSubject, connection: BILLING, level: "read" }]),
    );
    const setting = SETTINGS_REGISTRY.find((definition) => definition.key === "query.timeoutMs");

    expect((await visibleConnectionById(ALICE, "billing"))?.queryTimeout).toBe(setting?.default as number);
  });

  test("a grant whose expires_at has passed by Studio's clock is neither listed nor found, with no reload", async () => {
    recordGovernanceSnapshot(
      grantedSnapshot(
        [ORDERS, BILLING],
        [
          { subject: ALICE.idpSubject, connection: ORDERS, level: "write", expiresAt: T + 1000 },
          { subject: ALICE.idpSubject, connection: BILLING, level: "read", expiresAt: null },
        ],
      ),
    );
    expect((await visibleConnections(ALICE)).map((connection) => connection.seedId)).toEqual(["billing", "orders"]);

    setSystemTime(new Date(T + 1000));

    expect((await visibleConnections(ALICE)).map((connection) => connection.seedId)).toEqual(["billing"]);
    expect(await visibleConnectionById(ALICE, "orders")).toBeNull();
    expect((await visibleConnectionById(ALICE, "billing"))?.seedId).toBe("billing");
  });

  test("an id no connection has and an id granted to another subject are the same miss", async () => {
    recordGovernanceSnapshot(
      grantedSnapshot([ORDERS], [{ subject: ADMIN.idpSubject, connection: ORDERS, level: "read" }]),
    );

    expect(await visibleConnectionById(ALICE, "orders")).toBeNull();
    expect(await visibleConnectionById(ALICE, "no-such-connection")).toBeNull();
    expect(await visibleConnections(ALICE)).toEqual([]);
  });

  test("a session without an identity provider subject sees nothing, whatever its role", async () => {
    recordGovernanceSnapshot(grantedSnapshot([ORDERS], [{ subject: "", connection: ORDERS, level: "read" }]));

    const principals = [
      { role: "admin", username: "admin@example.com" },
      { role: "user", username: "alice@example.com", idpSubject: "" },
    ];

    expect(await Promise.all(principals.map((principal) => visibleConnections(principal)))).toEqual([[], []]);
    expect(await Promise.all(principals.map((principal) => visibleConnectionById(principal, "orders")))).toEqual([
      null,
      null,
    ]);
  });

  test("lists by name, then by id, whatever order the grants arrived in", async () => {
    const second = admittedConnection("b-orders", { name: "Orders" });
    const first = admittedConnection("a-orders", { name: "Orders" });
    recordGovernanceSnapshot(
      grantedSnapshot(
        [ORDERS, BILLING, CRM, second, first],
        [ORDERS, second, CRM, first, BILLING].map((connection) => ({
          subject: ALICE.idpSubject,
          connection,
          level: "read" as const,
        })),
      ),
    );

    expect((await visibleConnections(ALICE)).map((connection) => connection.seedId)).toEqual([
      "billing",
      "crm",
      "a-orders",
      "b-orders",
      "orders",
    ]);
  });

  test("hands out a copy: changing it leaves the snapshot's record as it was", async () => {
    recordGovernanceSnapshot(
      grantedSnapshot([BILLING], [{ subject: ALICE.idpSubject, connection: BILLING, level: "read" }]),
    );

    const listed = (await visibleConnections(ALICE))[0];
    delete listed.password;
    const found = await visibleConnectionById(ALICE, "billing");
    if (found !== null) found.host = "elsewhere.example.internal";

    expect(BILLING.read.password).toBe(READ_CREDENTIAL.password);
    expect(BILLING.read.host).toBe("billing.db.example.internal");
    expect((await visibleConnectionById(ALICE, "billing"))?.password).toBe(READ_CREDENTIAL.password);
  });

  test("a write grant on a connection without a write credential is a broken snapshot, and it throws", async () => {
    // The loader grants write only where this instance opened the write envelope, so only a broken snapshot does this.
    recordGovernanceSnapshot(
      grantedSnapshot([BILLING], [{ subject: ALICE.idpSubject, connection: BILLING, level: "write" }]),
    );

    await expect(visibleConnectionById(ALICE, "billing")).rejects.toThrow(
      'The governance snapshot grants write on connection "billing", which has no write credential',
    );
    await expect(visibleConnections(ALICE)).rejects.toThrow(/which has no write credential/);
    // The read credential is still reachable where the caller asks for it.
    expect(credentialOf(await visibleConnectionById(ALICE, "billing", { credential: "read" })).user).toBe("reader");
  });

  test("a degraded snapshot is still served", async () => {
    recordGovernanceSnapshot(
      grantedSnapshot([BILLING], [{ subject: ALICE.idpSubject, connection: BILLING, level: "read" }], T - 40_000),
    );
    recordGovernanceFailure({ at: T, kind: "transient", code: "ECONNREFUSED", detail: "connect ECONNREFUSED" });

    expect((await visibleConnections(ALICE)).map((connection) => connection.seedId)).toEqual(["billing"]);
  });

  describe("every state that cannot be served throws GovernanceUnavailableError, 503 GOVERNANCE_UNAVAILABLE", () => {
    const states: readonly [string, () => void][] = [
      ["loading: nothing has loaded yet", () => {}],
      [
        "unavailable: the snapshot is GOVERNANCE_MAX_STALENESS_MS old",
        () => recordGovernanceSnapshot(grantedSnapshot([BILLING], [], T - 120_000)),
      ],
      [
        "misconfigured: the latest load lacked a privilege, even with a fresh snapshot",
        () => {
          recordGovernanceSnapshot(grantedSnapshot([BILLING], [], T));
          recordGovernanceFailure({ at: T, kind: "misconfigured", code: "42501", detail: "bridge.grants_v1: denied" });
        },
      ],
      [
        "incompatible: no common contract version",
        () => recordGovernanceFailure({ at: T, kind: "incompatible", code: null, detail: "no common version" }),
      ],
    ];

    for (const [state, arrange] of states) {
      test(state, async () => {
        arrange();

        const errors = await Promise.all(
          [visibleConnections(ALICE), visibleConnectionById(ALICE, "billing")].map((attempt) =>
            attempt.catch((thrown: unknown) => thrown),
          ),
        );
        for (const error of errors) {
          expect(error).toBeInstanceOf(GovernanceUnavailableError);
          expect(error).toMatchObject({
            name: "GovernanceUnavailableError",
            message: GOVERNANCE_UNAVAILABLE_MESSAGE,
            statusCode: 503,
            code: "GOVERNANCE_UNAVAILABLE",
          });
        }
      });
    }
  });
});
