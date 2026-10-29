/**
 * The Kubernetes discovery export: the document docker/discover-kubernetes.mjs writes into its export Secret, and
 * the parser Studio reads the projected file with.
 *
 * The file is untrusted input: it is refused whole when it does not match the schema, by its size before it is
 * parsed, and a refusal names a field path and an issue code, never text the file chose, because the values are
 * database passwords. Nothing in it can set a connection's roles, managed flag, MCP opt-in or TLS mode: the schema
 * declares none of them.
 */
import { describe, expect, it } from "bun:test";
import {
  KUBERNETES_DISCOVERY_EXPORT_VERSION,
  KUBERNETES_DISCOVERY_FILE_MAX_BYTES,
  KUBERNETES_DISCOVERY_PROBLEMS,
  KUBERNETES_DISCOVERY_SECRET_KEYS,
  parseKubernetesDiscoveryExport,
  type KubernetesDiscoveryExport,
} from "@/lib/seed/kubernetes-discovery-export";
import { buildExport, CONTRACT, LIMITS } from "../../../docker/discover-kubernetes.mjs";

const NOW = "2026-10-28T08:00:00.000Z";
const PASSWORD = "not-a-real-password-orders";

function database(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "cnpg",
    resource: { metadata: { namespace: "team-a", name: "orders" } },
    secret: { name: "orders-app", data: { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" } },
    ...overrides,
  };
}

/** A Crunchy PGO PostgresCluster's row for its user analyst, as the exporter writes it. */
function pgoDatabase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "pgo",
    resource: { metadata: { namespace: "team-b", name: "analytics" }, spec: { users: [{ name: "analyst" }] } },
    secret: {
      name: "analytics-pguser-analyst",
      data: {
        user: "analyst",
        password: PASSWORD,
        host: "analytics-primary.team-b.svc",
        port: "5432",
        dbname: "analytics",
      },
    },
    ...overrides,
  };
}

/** A MongoDB Community resource's row for its user appuser, as the exporter writes it. */
function mongoDatabase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "mongo",
    resource: {
      metadata: { namespace: "team-m", name: "catalog" },
      spec: { users: [{ name: "appuser", db: "admin", roles: [{ db: "catalog" }] }] },
    },
    secret: {
      name: "catalog-admin-appuser",
      data: {
        "connectionString.standard": "mongodb://catalog-0.catalog-svc.team-m.svc.cluster.local:27017/admin",
        username: "appuser",
        password: PASSWORD,
      },
    },
    ...overrides,
  };
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    platform: "kubernetes",
    generatedAt: NOW,
    checkedAt: NOW,
    status: { ok: true },
    namespaces: [{ name: "team-a", status: { ok: true } }],
    databases: [database()],
    ...overrides,
  };
}

function parse(value: unknown) {
  return parseKubernetesDiscoveryExport(JSON.stringify(value));
}

function refusal(value: unknown): string {
  const result = parse(value);
  if (result.ok) throw new Error("the export was accepted");
  return result.reason;
}

describe("parseKubernetesDiscoveryExport", () => {
  it("accepts an export of one namespace and one CloudNativePG database", () => {
    const result = parse(document());
    expect(result.ok).toBe(true);
    const value = (result as { ok: true; value: KubernetesDiscoveryExport }).value;
    expect(value.databases[0]).toEqual({
      kind: "cnpg",
      resource: { metadata: { namespace: "team-a", name: "orders" } },
      secret: { name: "orders-app", data: { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" } },
    });
  });

  it.each([["api_unreachable"], ["credentials_unavailable"], ["unauthorized"], ["api_error"], ["limit_exceeded"]])(
    "accepts the exporter's status code %p",
    (code) => {
      expect(parse(document({ status: { ok: false, code, message: "m" } })).ok).toBe(true);
    },
  );

  it("accepts the exporter's statuses: a failed scan, a forbidden namespace, a missing CRD, a namespace over a bound and Secret problems", () => {
    const result = parse(
      document({
        status: { ok: false, code: "api_error", httpStatus: 500, message: "the API server answered HTTP 500" },
        namespaces: [
          { name: "team-a", status: { ok: true } },
          { name: "team-b", status: { ok: false, code: "forbidden", httpStatus: 403, message: "forbidden" } },
          { name: "team-c", status: { ok: false, code: "crd_missing", httpStatus: 404, message: "not found" } },
          { name: "team-d", status: { ok: false, code: "limit_exceeded", message: "too large to list" } },
        ],
        databases: [
          database(),
          database({ secret: { name: "orders-app", problem: "not_found" } }),
          database({ secret: { name: "orders-app", problem: "forbidden" } }),
          database({ secret: { name: "orders-app", problem: "invalid_value", key: "password" } }),
          database({ secret: { name: "orders-app", problem: "not_owned" } }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("keeps the contract's resource fields and drops every other field the file carries", () => {
    const result = parse(
      document({
        databases: [
          database({
            resource: {
              apiVersion: "postgresql.cnpg.io/v1",
              metadata: { namespace: "prod", name: "billing-db", labels: { team: "billing" } },
              spec: { instances: 3, bootstrap: { initdb: { database: "billing", secret: { name: "billing-owner" } } } },
            },
            secret: { name: "billing-owner", data: { username: "billing_owner", password: PASSWORD } },
            roles: ["*"],
            mcp: true,
          }),
        ],
      }),
    );
    const value = (result as { ok: true; value: KubernetesDiscoveryExport }).value;
    expect(value.databases[0]).toEqual({
      kind: "cnpg",
      resource: {
        metadata: { namespace: "prod", name: "billing-db" },
        spec: { bootstrap: { initdb: { database: "billing", secret: { name: "billing-owner" } } } },
      },
      secret: { name: "billing-owner", data: { username: "billing_owner", password: PASSWORD } },
    });
  });

  it("drops a Secret key the contract does not keep", () => {
    const result = parse(
      document({
        databases: [
          database({ secret: { name: "orders-app", data: { username: "orders", password: PASSWORD, uri: "x" } } }),
        ],
      }),
    );
    const value = (result as { ok: true; value: KubernetesDiscoveryExport }).value;
    expect(value.databases[0].secret).toEqual({
      name: "orders-app",
      data: { username: "orders", password: PASSWORD },
    });
  });

  it("refuses a file over the byte limit by its size, before parsing it", () => {
    const raw = " ".repeat(KUBERNETES_DISCOVERY_FILE_MAX_BYTES + 1);
    expect(KUBERNETES_DISCOVERY_FILE_MAX_BYTES).toBe(1024 * 1024);
    expect(parseKubernetesDiscoveryExport(raw)).toEqual({
      ok: false,
      reason: `the file is ${KUBERNETES_DISCOVERY_FILE_MAX_BYTES + 1} bytes, over the ${KUBERNETES_DISCOVERY_FILE_MAX_BYTES}-byte limit`,
    });
  });

  it("refuses text that is not JSON", () => {
    expect(parseKubernetesDiscoveryExport("{")).toEqual({ ok: false, reason: "the file is not valid JSON" });
  });

  it("refuses another platform's export, such as CapRover's", () => {
    expect(refusal(document({ platform: "caprover" }))).toBe(
      "the file does not match the export schema at platform (invalid_value)",
    );
  });

  // A version 1 export was written by an exporter that checks no Service and no Secret type, owner or key set.
  it("refuses version 1, and any other version than 2", () => {
    expect(KUBERNETES_DISCOVERY_EXPORT_VERSION).toBe(2);
    for (const version of [1, 3, "2"]) {
      expect(refusal(document({ version }))).toContain("version (invalid_value)");
    }
  });

  it("is the version the exporter writes", () => {
    const written = buildExport({
      now: Date.parse(NOW),
      status: { ok: true },
      generatedAt: NOW,
      namespaces: [],
      databases: [],
    });
    expect(written.version).toBe(KUBERNETES_DISCOVERY_EXPORT_VERSION);
  });

  it("accepts each kind with its own kept keys and strips others", () => {
    const cnpgData = { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" };
    const pgoData = {
      user: "analyst",
      password: PASSWORD,
      host: "analytics-primary.team-b.svc",
      port: "5432",
      dbname: "analytics",
    };
    const mongoData = {
      "connectionString.standard": "mongodb://catalog-0.catalog-svc.team-m.svc.cluster.local:27017/admin",
      username: "appuser",
      password: PASSWORD,
    };
    // Every row's own keys, plus every other row's, plus keys no row keeps; the rows share no value here.
    const extra = {
      ...cnpgData,
      ...pgoData,
      ...mongoData,
      "connectionString.standardSrv": "x",
      uri: "x",
      verifier: "x",
    };
    const pick = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, extra[key as keyof typeof extra]]));
    const result = parse(
      document({
        databases: [
          database({ secret: { name: "orders-app", data: extra } }),
          database({ kind: "edbpg", secret: { name: "orders-app", data: extra } }),
          pgoDatabase({ secret: { name: "analytics-pguser-analyst", data: extra } }),
          mongoDatabase({ secret: { name: "catalog-admin-appuser", data: extra } }),
        ],
      }),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.databases.map((entry) => [entry.kind, entry.secret.data])).toEqual([
      ["cnpg", pick(Object.keys(cnpgData))],
      ["edbpg", pick(Object.keys(cnpgData))],
      ["pgo", pick(Object.keys(pgoData))],
      ["mongo", pick(Object.keys(mongoData))],
    ]);
  });

  it("keeps each kind's resource fields and drops every other field", () => {
    const result = parse(
      document({
        databases: [
          pgoDatabase({
            resource: {
              metadata: { namespace: "team-b", name: "analytics", uid: "u" },
              spec: { users: [{ name: "analyst", databases: ["analytics"], options: "SUPERUSER" }], port: 5433 },
            },
          }),
          pgoDatabase({ resource: { metadata: { namespace: "team-b", name: "metrics" } } }),
          mongoDatabase({
            resource: {
              metadata: { namespace: "team-m", name: "catalog" },
              spec: {
                members: 3,
                users: [
                  {
                    name: "appuser",
                    db: "admin",
                    connectionStringSecretName: "catalog-app",
                    passwordSecretRef: { name: "appuser-password" },
                    roles: [{ name: "readWrite", db: "catalog" }],
                    additionalConnectionStringConfig: { proxyHost: "x" },
                  },
                ],
                security: { tls: { enabled: true, certificateKeySecretRef: { name: "x" } }, authentication: {} },
                statefulSet: { spec: { serviceName: "catalog-hl", replicas: 3 } },
              },
            },
          }),
        ],
      }),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.databases.map((entry) => entry.resource)).toEqual([
      { metadata: { namespace: "team-b", name: "analytics" }, spec: { users: [{ name: "analyst" }] } },
      { metadata: { namespace: "team-b", name: "metrics" } },
      {
        metadata: { namespace: "team-m", name: "catalog" },
        spec: {
          users: [
            { name: "appuser", db: "admin", connectionStringSecretName: "catalog-app", roles: [{ db: "catalog" }] },
          ],
          security: { tls: { enabled: true } },
          statefulSet: { spec: { serviceName: "catalog-hl" } },
        },
      },
    ]);
  });

  it("refuses an unknown kind", () => {
    for (const kind of ["mysql", "CNPG", ""]) {
      expect(refusal(document({ databases: [database({ kind })] }))).toBe(
        "the file does not match the export schema at databases.0.kind (invalid_union)",
      );
    }
  });

  it("refuses a user name outside the pattern or with a slash", () => {
    const pgoUser = (name: string) =>
      pgoDatabase({ resource: { metadata: { namespace: "team-b", name: "analytics" }, spec: { users: [{ name }] } } });
    const mongoUser = (name: string) =>
      mongoDatabase({
        resource: { metadata: { namespace: "team-m", name: "catalog" }, spec: { users: [{ name, roles: [] }] } },
      });
    // PGO's user names are also DNS labels: lowercase letters, digits and inner hyphens.
    for (const name of ["ana/lyst", "", "a".repeat(64), "Analyst", "ana_lyst", "ana lyst"]) {
      expect(refusal(document({ databases: [pgoUser(name)] }))).toBe(
        "the file does not match the export schema at databases.0.resource.spec.users.0.name (invalid_format)",
      );
    }
    expect(parse(document({ databases: [pgoUser("a".repeat(63))] })).ok).toBe(true);
    for (const name of ["app/user", "", "a".repeat(64), "app user", "app:user"]) {
      expect(refusal(document({ databases: [mongoUser(name)] }))).toBe(
        "the file does not match the export schema at databases.0.resource.spec.users.0.name (invalid_format)",
      );
    }
    for (const name of ["App_User.1@corp+x-y", "a".repeat(63)]) {
      expect(parse(document({ databases: [mongoUser(name)] })).ok).toBe(true);
    }
  });

  it("refuses a MongoDB database name outside its pattern, a Service name that is not a DNS-1035 label, and over 64 roles", () => {
    const mongo = (user: Record<string, unknown>, spec: Record<string, unknown> = {}) =>
      document({
        databases: [
          mongoDatabase({
            resource: {
              metadata: { namespace: "team-m", name: "catalog" },
              spec: { users: [{ name: "appuser", roles: [], ...user }], ...spec },
            },
          }),
        ],
      });
    expect(refusal(mongo({ db: "ad.min" }))).toBe(
      "the file does not match the export schema at databases.0.resource.spec.users.0.db (invalid_format)",
    );
    expect(refusal(mongo({ roles: [{ db: "cat/alog" }] }))).toBe(
      "the file does not match the export schema at databases.0.resource.spec.users.0.roles.0.db (invalid_format)",
    );
    expect(refusal(mongo({ roles: Array.from({ length: 65 }, () => ({ db: "catalog" })) }))).toBe(
      "the file does not match the export schema at databases.0.resource.spec.users.0.roles (too_big)",
    );
    expect(parse(mongo({ roles: Array.from({ length: 64 }, () => ({ db: "catalog" })) })).ok).toBe(true);
    for (const serviceName of ["1catalog", "Catalog", "catalog.svc", "a".repeat(64)]) {
      expect(refusal(mongo({}, { statefulSet: { spec: { serviceName } } }))).toBe(
        "the file does not match the export schema at databases.0.resource.spec.statefulSet.spec.serviceName (invalid_format)",
      );
    }
  });

  it("refuses a row that names more or fewer than its one user", () => {
    const users = (list: unknown[]) =>
      document({
        databases: [
          pgoDatabase({ resource: { metadata: { namespace: "team-b", name: "analytics" }, spec: { users: list } } }),
        ],
      });
    expect(refusal(users([]))).toBe(
      "the file does not match the export schema at databases.0.resource.spec.users (too_small)",
    );
    expect(refusal(users([{ name: "a" }, { name: "b" }]))).toBe(
      "the file does not match the export schema at databases.0.resource.spec.users (too_big)",
    );
    expect(
      refusal(
        document({ databases: [mongoDatabase({ resource: { metadata: { namespace: "team-m", name: "catalog" } } })] }),
      ),
    ).toBe("the file does not match the export schema at databases.0.resource.spec (invalid_type)");
  });

  it("accepts every problem code, and a key only from the kept keys", () => {
    expect([...KUBERNETES_DISCOVERY_PROBLEMS]).toEqual([
      "not_found",
      "forbidden",
      "not_owned",
      "invalid_value",
      "reserved_name",
      "wrong_type",
      "unexpected_key",
      "missing_key",
      "no_database",
      "other_namespace",
      "unsupported_name",
      "service_not_found",
      "service_forbidden",
      "service_external_name",
      "service_not_controlled",
      "service_invalid_name",
    ]);
    for (const problem of KUBERNETES_DISCOVERY_PROBLEMS) {
      const secret = problem === "unsupported_name" ? { problem } : { name: "catalog-admin-appuser", problem };
      expect(parse(document({ databases: [mongoDatabase({ secret })] })).ok).toBe(true);
    }
    expect(refusal(document({ databases: [database({ secret: { name: "orders-app", problem: "gone" } })] }))).toBe(
      "the file does not match the export schema at databases.0.secret.problem (invalid_value)",
    );
    for (const key of KUBERNETES_DISCOVERY_SECRET_KEYS) {
      const secret = { name: "catalog-admin-appuser", problem: "missing_key", key };
      expect(parse(document({ databases: [mongoDatabase({ secret })] })).ok).toBe(true);
    }
    expect(
      refusal(
        document({
          databases: [mongoDatabase({ secret: { name: "catalog-admin-appuser", problem: "missing_key", key: "uri" } })],
        }),
      ),
    ).toBe("the file does not match the export schema at databases.0.secret.key (invalid_value)");
  });

  // MongoDB Community names a user's Secret <name>-<db>-<user> after normalizing it, which discovery does not compute.
  it("name is absent exactly with unsupported_name", () => {
    const secret = (value: Record<string, unknown>) => document({ databases: [mongoDatabase({ secret: value })] });
    expect(parse(secret({ problem: "unsupported_name" })).ok).toBe(true);
    expect(refusal(secret({ name: "catalog-admin-appuser", problem: "unsupported_name" }))).toBe(
      "the file does not match the export schema at databases.0.secret (custom)",
    );
    expect(refusal(secret({ problem: "not_found" }))).toBe(
      "the file does not match the export schema at databases.0.secret (custom)",
    );
    expect(refusal(secret({ data: { username: "appuser" } }))).toBe(
      "the file does not match the export schema at databases.0.secret (custom)",
    );
  });

  it("names the first issue's path and code, counts the rest, and never quotes a value", () => {
    const reason = refusal(
      document({
        databases: [
          database({
            secret: { name: "orders-app", data: { username: "orders", password: `${PASSWORD}${"x".repeat(1024)}` } },
          }),
          database({ kind: "mysql" }),
        ],
      }),
    );
    expect(reason).toBe(
      "the file does not match the export schema at databases.0.secret.data.password (too_big) (and 1 more)",
    );
    expect(reason).not.toContain(PASSWORD);
  });

  it("names the top level when the document is not an object", () => {
    expect(refusal([])).toBe("the file does not match the export schema at the top level (invalid_type)");
  });

  it("refuses a namespace or a resource name that is not a Kubernetes name, so no host is built from one", () => {
    expect(refusal(document({ namespaces: [{ name: "Team_A", status: { ok: true } }] }))).toBe(
      "the file does not match the export schema at namespaces.0.name (invalid_format)",
    );
    expect(
      refusal(document({ databases: [database({ resource: { metadata: { namespace: "a.b", name: "orders" } } })] })),
    ).toBe("the file does not match the export schema at databases.0.resource.metadata.namespace (invalid_format)");
    expect(
      refusal(
        document({ databases: [database({ resource: { metadata: { namespace: "team-a", name: "orders/x" } } })] }),
      ),
    ).toBe("the file does not match the export schema at databases.0.resource.metadata.name (invalid_format)");
  });

  it("data and problem never together: refuses a Secret entry with both, or with neither", () => {
    expect(
      refusal(document({ databases: [database({ secret: { name: "orders-app", data: {}, problem: "not_found" } })] })),
    ).toBe("the file does not match the export schema at databases.0.secret (custom)");
    expect(refusal(document({ databases: [database({ secret: { name: "orders-app" } })] }))).toBe(
      "the file does not match the export schema at databases.0.secret (custom)",
    );
  });

  it("refuses more than 500 databases or 256 namespaces with one issue, before checking any element", () => {
    expect(refusal(document({ databases: Array.from({ length: 501 }, () => 0) }))).toBe(
      "the file does not match the export schema at databases (too_big)",
    );
    expect(refusal(document({ namespaces: Array.from({ length: 257 }, () => 0) }))).toBe(
      "the file does not match the export schema at namespaces (too_big)",
    );
  });

  it("refuses a status message over 512 characters", () => {
    expect(refusal(document({ status: { ok: false, code: "api_error", message: "m".repeat(513) } }))).toBe(
      "the file does not match the export schema at status.message (too_big)",
    );
  });

  /*
   * The schema repeats the exporter's bounds as literals (LIMITS in docker/discover-kubernetes.mjs): whatever the
   * exporter writes at its bound must parse here, and one past it must not.
   */
  describe("the exporter's bounds", () => {
    it("accepts as many databases and namespaces as the exporter writes, and refuses one more", () => {
      const databases = Array.from({ length: LIMITS.databases }, () => database());
      const namespaces = Array.from({ length: LIMITS.namespaces }, (_, index) => ({
        name: `n${index}`,
        status: { ok: true },
      }));
      expect(parse(document({ databases, namespaces })).ok).toBe(true);
      expect(parse(document({ databases: [...databases, database()] })).ok).toBe(false);
      expect(parse(document({ namespaces: [...namespaces, { name: "one-more", status: { ok: true } }] })).ok).toBe(
        false,
      );
    });

    it("accepts a value of the exporter's byte bound and a message of its length, and refuses longer ones", () => {
      const value = "v".repeat(LIMITS.valueBytes);
      const secret = (password: string) => ({ name: "orders-app", data: { username: "orders", password } });
      expect(parse(document({ databases: [database({ secret: secret(value) })] })).ok).toBe(true);
      expect(parse(document({ databases: [database({ secret: secret(`${value}v`) })] })).ok).toBe(false);
      const status = (message: string) => ({ ok: false, code: "api_error", message });
      expect(parse(document({ status: status("m".repeat(LIMITS.messageChars)) })).ok).toBe(true);
      expect(parse(document({ status: status("m".repeat(LIMITS.messageChars + 1)) })).ok).toBe(false);
    });

    it("reads a file of the exporter's size bound, and keeps only keys some contract row keeps", () => {
      expect(LIMITS.exportBytes).toBeLessThanOrEqual(KUBERNETES_DISCOVERY_FILE_MAX_BYTES);
      expect<string[]>([...KUBERNETES_DISCOVERY_SECRET_KEYS]).toEqual([
        "username",
        "password",
        "dbname",
        "port",
        "user",
        "host",
        "connectionString.standard",
      ]);
      const kept: string[] = CONTRACT.flatMap((row: { secretKeys: readonly string[] }) => [...row.secretKeys]);
      for (const key of kept) expect<string[]>([...KUBERNETES_DISCOVERY_SECRET_KEYS]).toContain(key);
    });
  });

  describe("before the first successful scan", () => {
    const first = { generatedAt: null, status: { ok: false, code: "api_error", message: "no answer yet" } };

    it("accepts an error status with no namespaces and no databases", () => {
      expect(parse(document({ ...first, namespaces: [], databases: [] })).ok).toBe(true);
    });

    it("refuses databases, namespaces or an ok status", () => {
      expect(refusal(document({ ...first, namespaces: [] }))).toBe(
        "the file does not match the export schema at databases (custom)",
      );
      expect(refusal(document({ ...first, databases: [] }))).toBe(
        "the file does not match the export schema at namespaces (custom)",
      );
      expect(refusal(document({ generatedAt: null, namespaces: [], databases: [] }))).toBe(
        "the file does not match the export schema at status (custom)",
      );
    });
  });
});
