/**
 * The Kubernetes discovery contract: one row per supported kind, the connection id rule, and the seed connection each
 * exported database becomes (docs/SEED_CONNECTIONS.md, "Platform discovery (Kubernetes)").
 *
 * The golden fixture (tests/fixtures/kubernetes-discovery-golden.json) is read in place: the Rancher extension copies
 * it from a released tag, so a case that fails here is a link the extension would build to a connection Studio does
 * not list.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import golden from "../../fixtures/kubernetes-discovery-golden.json";
import { GOLDEN_CASES, type GoldenCase, goldenEntry, goldenRow } from "../../helpers/kubernetes-discovery-fixture";
import {
  CNPG_CLUSTER,
  EDB_CLUSTER,
  KUBERNETES_CONTRACT,
  kubernetesConnectionId,
  kubernetesIdKey,
  mapKubernetesDatabase,
  MONGODB_COMMUNITY,
  PGO_POSTGRES_CLUSTER,
} from "@/lib/seed/kubernetes-discovery-contract";
import {
  KUBERNETES_DISCOVERY_PROBLEMS,
  parseKubernetesDiscoveryExport,
  type KubernetesDiscoveredDatabase,
} from "@/lib/seed/kubernetes-discovery-export";

const PASSWORD = "not-a-real-password-orders";
const CLUSTER_DOMAIN = "SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN";
const INVALID_CLUSTER_DOMAIN =
  "SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN is not a DNS name: name the cluster's domain, such as cluster.local, in lowercase letters, digits and hyphens, with dots between its labels and none at either end";

const SVC_CLUSTER_DOMAIN =
  "SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN starts with the Services' subdomain, which every discovered host already carries: name the cluster domain itself, such as cluster.local";

const savedClusterDomain = process.env[CLUSTER_DOMAIN];

beforeEach(() => {
  delete process.env[CLUSTER_DOMAIN];
});

afterEach(() => {
  if (savedClusterDomain === undefined) delete process.env[CLUSTER_DOMAIN];
  else process.env[CLUSTER_DOMAIN] = savedClusterDomain;
});

function database(overrides: Partial<KubernetesDiscoveredDatabase> = {}): KubernetesDiscoveredDatabase {
  return {
    kind: "cnpg",
    resource: { metadata: { namespace: "team-a", name: "orders" } },
    secret: { name: "orders-app", data: { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" } },
    ...overrides,
  };
}

function refusalOf(entry: KubernetesDiscoveredDatabase): string {
  const result = mapKubernetesDatabase(entry);
  if (result.ok) throw new Error("the database was mapped");
  return result.reason;
}

/** The connection an entry maps to, or the refusal as a thrown error. */
function connectionOf(entry: KubernetesDiscoveredDatabase) {
  const result = mapKubernetesDatabase(entry);
  if (!result.ok) throw new Error(result.reason);
  return result.connection;
}

/** `data` without `key`. */
function without(data: Record<string, string>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(data).filter(([name]) => name !== key));
}

/** The first 32 hex characters of SHA-256 over `key`, written out here rather than taken from the module. */
function sha256Prefix(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** An entry as an export would carry it once Studio's parser has read it, so fields the schema drops are dropped. */
function parsedEntry(entry: Record<string, unknown>): KubernetesDiscoveredDatabase {
  const at = "2026-10-29T08:00:00.000Z";
  const parsed = parseKubernetesDiscoveryExport(
    JSON.stringify({
      version: 2,
      platform: "kubernetes",
      generatedAt: at,
      checkedAt: at,
      status: { ok: true },
      namespaces: [],
      databases: [entry],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value.databases[0];
}

describe("the contract table", () => {
  it("holds the CloudNativePG family's rows: CloudNativePG and EDB Postgres for Kubernetes", () => {
    expect(KUBERNETES_CONTRACT.slice(0, 2)).toEqual([CNPG_CLUSTER, EDB_CLUSTER]);
    const family = {
      version: "v1",
      kind: "Cluster",
      plural: "clusters",
      type: "postgres",
      perUser: false,
      secretType: "kubernetes.io/basic-auth",
      secretKeys: ["username", "password", "dbname", "port"],
    };
    expect(CNPG_CLUSTER).toMatchObject({
      ...family,
      slug: "cnpg",
      label: "CloudNativePG",
      group: "postgresql.cnpg.io",
    });
    expect(EDB_CLUSTER).toMatchObject({
      ...family,
      slug: "edbpg",
      label: "EDB Postgres for Kubernetes",
      group: "postgresql.k8s.enterprisedb.io",
    });
    for (const row of [CNPG_CLUSTER, EDB_CLUSTER]) {
      const resource = { metadata: { namespace: "a", name: "db" } };
      expect(row.user(resource)).toBeUndefined();
      expect(row.serviceName(resource)).toBe("db-rw");
      expect(row.ssl(resource)).toEqual({ mode: "require" });
    }
  });

  it("names the CloudNativePG credential Secret <name>-app, or the initdb Secret when one is set", () => {
    const resource = { metadata: { namespace: "a", name: "db" } };
    expect(CNPG_CLUSTER.secretName(resource)).toBe("db-app");
    expect(CNPG_CLUSTER.secretName({ ...resource, spec: { bootstrap: { initdb: { secret: {} } } } })).toBe("db-app");
    expect(
      CNPG_CLUSTER.secretName({ ...resource, spec: { bootstrap: { initdb: { secret: { name: "owner" } } } } }),
    ).toBe("owner");
  });
});

describe("kubernetesConnectionId", () => {
  it("kubernetesConnectionId is k8s-<slug>- and the first 32 hex of sha256 of the key", () => {
    const id = kubernetesConnectionId("cnpg", "team-a/orders");
    expect(id).toBe(`k8s-cnpg-${createHash("sha256").update("team-a/orders").digest("hex").slice(0, 32)}`);
    expect(id).toMatch(/^k8s-cnpg-[0-9a-f]{32}$/);
    expect(kubernetesConnectionId("pgo", "team-b/analytics/analyst")).toBe(
      `k8s-pgo-${sha256Prefix("team-b/analytics/analyst")}`,
    );
  });

  it("takes the digest from its seam, so a test can make two keys share an id", () => {
    expect(kubernetesConnectionId("cnpg", "team-a/orders", () => "f".repeat(64))).toBe(`k8s-cnpg-${"f".repeat(32)}`);
  });

  it("kubernetesIdKey adds /<user> for a per-user row", () => {
    expect(kubernetesIdKey("team-a", "orders")).toBe("team-a/orders");
    expect(kubernetesIdKey("team-b", "analytics", "analyst")).toBe("team-b/analytics/analyst");
  });

  it("the longest slug's id fits the seed id rule, whatever the names' length", () => {
    const longest = KUBERNETES_CONTRACT.map((row) => row.slug).reduce((a, b) => (b.length > a.length ? b : a));
    const id = kubernetesConnectionId(longest, kubernetesIdKey("n".repeat(63), "d".repeat(253), "u".repeat(63)));
    expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(id).toHaveLength(4 + longest.length + 1 + 32);
  });

  it("differs per namespace, name and user", () => {
    const ids = [
      kubernetesConnectionId("cnpg", kubernetesIdKey("team-a", "db")),
      kubernetesConnectionId("cnpg", kubernetesIdKey("team-b", "db")),
      kubernetesConnectionId("cnpg", kubernetesIdKey("team-a", "db2")),
      kubernetesConnectionId("pgo", kubernetesIdKey("team-a", "db", "u1")),
      kubernetesConnectionId("pgo", kubernetesIdKey("team-a", "db", "u2")),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("mapKubernetesDatabase", () => {
  it("maps a Cluster's <name>-app Secret: user, password, database and port from the Secret", () => {
    expect(mapKubernetesDatabase(database())).toEqual({
      ok: true,
      key: "team-a/orders",
      connection: {
        id: `k8s-cnpg-${sha256Prefix("team-a/orders")}`,
        name: "team-a/orders (CloudNativePG)",
        type: "postgres",
        host: "orders-rw.team-a.svc.cluster.local.",
        port: 5432,
        database: "orders",
        user: "orders",
        password: PASSWORD,
        group: "team-a",
        ssl: { mode: "require" },
        managed: true,
        roles: ["admin"],
      },
      secret: { namespace: "team-a", name: "orders-app" },
    });
  });

  it("takes the port the <name>-app Secret names", () => {
    const entry = database({
      secret: { name: "orders-app", data: { username: "orders", password: PASSWORD, dbname: "orders", port: "6432" } },
    });
    expect(mapKubernetesDatabase(entry)).toMatchObject({ ok: true, connection: { port: 6432 } });
  });

  it("maps a user-supplied initdb Secret: the database from initdb, else app, and port 5432", () => {
    const supplied = (initdb: Record<string, unknown>) =>
      database({
        resource: { metadata: { namespace: "prod", name: "billing-db" }, spec: { bootstrap: { initdb } } },
        // A dbname or port in a Secret the user supplied is not the contract's, so it is not read.
        secret: {
          name: "billing-owner",
          data: { username: "billing_owner", password: PASSWORD, dbname: "other", port: "1" },
        },
      });
    expect(mapKubernetesDatabase(supplied({ database: "billing", secret: { name: "billing-owner" } }))).toMatchObject({
      ok: true,
      connection: {
        database: "billing",
        port: 5432,
        user: "billing_owner",
        host: "billing-db-rw.prod.svc.cluster.local.",
      },
      secret: { namespace: "prod", name: "billing-owner" },
    });
    expect(mapKubernetesDatabase(supplied({ secret: { name: "billing-owner" } }))).toMatchObject({
      ok: true,
      connection: { database: "app", port: 5432 },
    });
  });

  // Discovered hosts are fully qualified names with a trailing dot, so the pod's DNS search path never applies.
  it("builds the host as the read-write Service's fully qualified name with a trailing dot", () => {
    const hostOf = () => {
      const result = mapKubernetesDatabase(database());
      if (!result.ok) throw new Error(result.reason);
      return result.connection.host;
    };
    expect(hostOf()).toBe("orders-rw.team-a.svc.cluster.local.");
    // A blank value is the default, as an unset one is.
    process.env[CLUSTER_DOMAIN] = "  ";
    expect(hostOf()).toBe("orders-rw.team-a.svc.cluster.local.");
  });

  it("ends the host in the cluster domain SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN names", () => {
    for (const value of ["corp.internal", " corp.internal ", "k8s"]) {
      process.env[CLUSTER_DOMAIN] = value;
      const result = mapKubernetesDatabase(database());
      if (!result.ok) throw new Error(result.reason);
      expect(result.connection.host).toBe(`orders-rw.team-a.svc.${value.trim()}.`);
    }
  });

  it("skips every database while SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN is not a DNS name, naming the variable, not the value", () => {
    const invalid = [
      "Cluster.Local",
      "cluster..local",
      ".cluster.local",
      "cluster.local.",
      "-cluster.local",
      "cluster-.local",
      "cluster_local",
      "cluster local",
      "cluster.local:53",
      "cluster.local/x",
      `${"a".repeat(64)}.local`,
      `${"a.".repeat(126)}ab`,
    ];
    for (const value of invalid) {
      process.env[CLUSTER_DOMAIN] = value;
      const reason = refusalOf(database());
      expect(reason).toBe(INVALID_CLUSTER_DOMAIN);
      expect(reason).not.toContain(value);
    }
    // A domain whose first label is svc would put the Services' subdomain in the host twice.
    for (const value of ["svc", "svc.cluster.local", " svc.corp.internal "]) {
      process.env[CLUSTER_DOMAIN] = value;
      const reason = refusalOf(database());
      expect(reason).toBe(SVC_CLUSTER_DOMAIN);
      expect(reason).not.toContain(value.trim());
    }
  });

  it("skips a database whose resource name is not a single DNS label, naming the field, not the value", () => {
    const name = "orders.attacker";
    const reason = refusalOf(
      database({
        resource: { metadata: { namespace: "team-a", name } },
        secret: {
          name: `${name}-app`,
          data: { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" },
        },
      }),
    );
    expect(reason).toBe("the resource's metadata.name is not a single DNS label, which the host's Service name needs");
    expect(reason).not.toContain(name);
  });

  it("skips a database whose host has a label over 63 characters, naming the field, not the value", () => {
    // A 61-character name is a valid label; with the -rw suffix its Service's label is 64 characters.
    const name = "a".repeat(61);
    const reason = refusalOf(
      database({
        resource: { metadata: { namespace: "team-a", name } },
        secret: {
          name: `${name}-app`,
          data: { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" },
        },
      }),
    );
    expect(reason).toBe("the host is not a DNS name: one of its labels is not 1 to 63 characters");
    expect(reason).not.toContain(name);
  });

  it("lists a database whose host labels are exactly 63 characters", () => {
    const name = "a".repeat(60);
    const result = mapKubernetesDatabase(
      database({
        resource: { metadata: { namespace: "team-a", name } },
        secret: {
          name: `${name}-app`,
          data: { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" },
        },
      }),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.connection.host).toBe(`${name}-rw.team-a.svc.cluster.local.`);
  });

  it("skips a database whose host is over 253 characters, naming the field, not the value", () => {
    // Without its trailing dot the host is 9 + 1 + 63 + 5 + domain characters: 253 lists, 254 does not.
    const namespace = "n".repeat(63);
    const fits = `${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(47)}`;
    const over = `${fits}d`;
    const hostWith = (domain: string) => {
      process.env[CLUSTER_DOMAIN] = domain;
      return mapKubernetesDatabase(database({ resource: { metadata: { namespace, name: "orders" } } }));
    };
    const listed = hostWith(fits);
    if (!listed.ok) throw new Error(listed.reason);
    expect(listed.connection.host?.length).toBe(254);
    const refused = hostWith(over);
    if (refused.ok) throw new Error("listed a host over 253 characters");
    expect(refused.reason).toBe("the host is not a DNS name: it is over 253 characters");
    expect(refused.reason).not.toContain(namespace);
  });

  it("forces the access fields in code: managed, the admin role, TLS required, no MCP, read-only mode or string", () => {
    const result = mapKubernetesDatabase(database());
    if (!result.ok) throw new Error(result.reason);
    expect(result.connection).toMatchObject({ managed: true, roles: ["admin"], ssl: { mode: "require" } });
    for (const field of ["mcp", "readOnly", "connectionString", "environment", "color"]) {
      expect(result.connection).not.toHaveProperty(field);
    }
  });

  it("skips an entry whose Secret name is not the one the contract names, so a review never asks about another", () => {
    expect(refusalOf(database({ secret: { name: "orders-superuser", data: { username: "postgres" } } }))).toBe(
      "the export names the credential Secret orders-superuser, where the contract names orders-app",
    );
  });

  it("names the Secret problem the exporter recorded", () => {
    const problem = (secret: KubernetesDiscoveredDatabase["secret"]) => refusalOf(database({ secret }));
    expect(problem({ name: "orders-app", problem: "not_found" })).toBe(
      "the credential Secret orders-app does not exist",
    );
    expect(problem({ name: "orders-app", problem: "forbidden" })).toBe(
      "the exporter may not read the credential Secret orders-app",
    );
    expect(problem({ name: "orders-app", problem: "invalid_value", key: "password" })).toBe(
      "the credential Secret orders-app holds a password that is over 1024 bytes or not UTF-8 text",
    );
    expect(problem({ name: "orders-app", problem: "invalid_value" })).toBe(
      "the credential Secret orders-app holds a value that is over 1024 bytes or not UTF-8 text",
    );
    expect(problem({ name: "orders-app", problem: "not_owned" })).toBe(
      "the credential Secret orders-app is neither owned by the Cluster nor labelled cnpg.io/cluster=orders, so the exporter did not export it",
    );
  });

  it("names the rule a user-supplied initdb Secret failed when the exporter did not export it", () => {
    const entry = database({
      resource: {
        metadata: { namespace: "prod", name: "billing-db" },
        spec: { bootstrap: { initdb: { secret: { name: "billing-owner" } } } },
      },
      secret: { name: "billing-owner", problem: "not_owned" },
    });
    expect(refusalOf(entry)).toBe(
      "the credential Secret billing-owner belongs to another resource or is not of type kubernetes.io/basic-auth, so the exporter did not export it",
    );
  });

  it("skips a Secret without a username, a password, or, for <name>-app, a dbname or a valid port", () => {
    const without = (data: Record<string, string>) => refusalOf(database({ secret: { name: "orders-app", data } }));
    const full = { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" };
    expect(without({ ...full, username: "" })).toBe("the credential Secret orders-app has no username");
    expect(without({ ...full, password: "" })).toBe("the credential Secret orders-app has no password");
    const omit = (key: keyof typeof full) => Object.fromEntries(Object.entries(full).filter(([name]) => name !== key));
    expect(without(omit("dbname"))).toBe("the credential Secret orders-app has no dbname");
    for (const data of [omit("port"), { ...full, port: "0" }, { ...full, port: "65536" }, { ...full, port: "54 32" }]) {
      expect(without(data)).toBe("the credential Secret orders-app has no valid port");
    }
  });

  // A namespace of 63 characters and a Cluster name of 50, the longest Kubernetes and CloudNativePG accept, are 114
  // characters with the slash, so `<namespace>/<name> (CloudNativePG)` would be over the seed schema's 128.
  it("lists a Cluster with long names, cutting the start of its name to fit the seed schema's 128 characters", () => {
    const named = (namespace: string, name: string) =>
      mapKubernetesDatabase(
        database({
          resource: { metadata: { namespace, name } },
          secret: { name: `${name}-app`, data: { username: "u", password: PASSWORD, dbname: "app", port: "5432" } },
        }),
      );
    const namespace = `team-${"a".repeat(58)}`;
    const name = `db-${"b".repeat(47)}`;
    const long = named(namespace, name);
    if (!long.ok) throw new Error(long.reason);
    expect(long.connection.name).toBe(`…${`${namespace}/${name}`.slice(3)} (CloudNativePG)`);
    expect(long.connection.name).toHaveLength(128);
    // The group shows the namespace whole, and the id is the namespace's and the name's, whatever the name shows.
    expect(long.connection).toMatchObject({
      group: namespace,
      id: kubernetesConnectionId("cnpg", kubernetesIdKey(namespace, name)),
    });

    // The longest name whose Service name is a DNS label, 60 characters and -rw.
    const longest = named(namespace, "d".repeat(60));
    if (!longest.ok) throw new Error(longest.reason);
    expect(longest.connection.name).toBe(`…${`${namespace}/${"d".repeat(60)}`.slice(13)} (CloudNativePG)`);
    expect(longest.connection.name).toHaveLength(128);

    // 111 characters of namespace and name fit whole.
    const fits = named(`ns-${"a".repeat(57)}`, "d".repeat(51));
    if (!fits.ok) throw new Error(fits.reason);
    expect(fits.connection.name).toBe(`ns-${"a".repeat(57)}/${"d".repeat(51)} (CloudNativePG)`);
    expect(fits.connection.name).toHaveLength(128);
  });

  // The export's schema already refuses an initdb database that is not a string; the seed schema checks the
  // connection again.
  it("skips a connection the seed schema refuses, naming the field and the issue, never a value", () => {
    const reason = refusalOf(
      database({
        resource: {
          metadata: { namespace: "team-a", name: "orders" },
          spec: { bootstrap: { initdb: { database: 42 as unknown as string, secret: { name: "orders-owner" } } } },
        },
        secret: { name: "orders-owner", data: { username: "u", password: PASSWORD } },
      }),
    );
    expect(reason).toBe("the connection is not valid: database (invalid_type)");
    expect(reason).not.toContain(PASSWORD);
  });
});

describe("the CloudNativePG family", () => {
  it("a CloudNativePG and an EDB cluster of one namespace and name have different ids", () => {
    const cnpg = connectionOf(database());
    const edb = connectionOf(database({ kind: "edbpg" }));
    expect(cnpg.id).toBe(`k8s-cnpg-${sha256Prefix("team-a/orders")}`);
    expect(edb.id).toBe(`k8s-edbpg-${sha256Prefix("team-a/orders")}`);
    expect(edb.id).not.toBe(cnpg.id);
  });

  it.each(
    GOLDEN_CASES.filter((c) => c.resource.apiVersion === "postgresql.cnpg.io/v1").map(
      (c) => [c.secretName, c] as const,
    ),
  )("EDB maps exactly as CloudNativePG except slug, group and label: %s", (_, c) => {
    const entry = (kind: "cnpg" | "edbpg") =>
      parsedEntry({ kind, resource: c.resource, secret: { name: c.secretName, data: c.secretData } });
    const cnpg = mapKubernetesDatabase(entry("cnpg"));
    const edb = mapKubernetesDatabase(entry("edbpg"));
    if (!cnpg.ok || !edb.ok) throw new Error("a golden case was refused");
    expect(EDB_CLUSTER.secretName(c.resource)).toBe(CNPG_CLUSTER.secretName(c.resource));
    expect(edb.secret).toEqual(cnpg.secret);
    expect(edb.key).toBe(cnpg.key);
    const { id: cnpgId, name: cnpgName, ...cnpgRest } = cnpg.connection;
    const { id: edbId, name: edbName, ...edbRest } = edb.connection;
    expect(edbRest).toEqual(cnpgRest);
    expect(edbId).toBe(`k8s-edbpg-${sha256Prefix(cnpg.key)}`);
    expect(cnpgId).toBe(`k8s-cnpg-${sha256Prefix(cnpg.key)}`);
    expect(edbName).toBe(cnpgName.replace("(CloudNativePG)", "(EDB Postgres for Kubernetes)"));
  });

  it("names EDB's own label in an ownership refusal", () => {
    expect(refusalOf(database({ kind: "edbpg", secret: { name: "orders-app", problem: "not_owned" } }))).toBe(
      "the credential Secret orders-app is neither owned by the Cluster nor labelled k8s.enterprisedb.io/cluster=orders, so the exporter did not export it",
    );
  });

  it("a CloudNativePG host key of <name>-rw maps to <name>-rw.<ns>.svc.cluster.local., and an initdb Secret without host maps to the computed host", () => {
    for (const host of ["orders-rw", "orders-rw.team-a.svc", "evil.example.com"]) {
      const entry = parsedEntry({
        kind: "cnpg",
        resource: { metadata: { namespace: "team-a", name: "orders" } },
        secret: {
          name: "orders-app",
          data: { username: "u", password: PASSWORD, dbname: "orders", port: "5432", host },
        },
      });
      expect(connectionOf(entry).host).toBe("orders-rw.team-a.svc.cluster.local.");
    }
    const supplied = parsedEntry({
      kind: "edbpg",
      resource: {
        metadata: { namespace: "prod", name: "billing-db" },
        spec: { bootstrap: { initdb: { secret: { name: "billing-owner" } } } },
      },
      secret: { name: "billing-owner", data: { username: "u", password: PASSWORD } },
    });
    expect(connectionOf(supplied).host).toBe("billing-db-rw.prod.svc.cluster.local.");
  });

  it("ssl.mode is require on every Postgres row whatever the export says", () => {
    for (const kind of ["cnpg", "edbpg"]) {
      const entry = parsedEntry({
        kind,
        ssl: { mode: "disable" },
        resource: { metadata: { namespace: "team-a", name: "orders" }, spec: { ssl: { mode: "disable" } } },
        secret: {
          name: "orders-app",
          data: { username: "u", password: PASSWORD, dbname: "orders", port: "5432", sslmode: "disable" },
        },
      });
      expect(connectionOf(entry).ssl).toEqual({ mode: "require" });
    }
  });

  it("every problem code has a reason naming no value", () => {
    const reasons = new Set<string>();
    for (const problem of KUBERNETES_DISCOVERY_PROBLEMS) {
      const secret =
        problem === "unsupported_name"
          ? { problem }
          : { name: "orders-app", problem, ...(problem === "missing_key" ? { key: "dbname" as const } : {}) };
      const reason = refusalOf(database({ secret } as Partial<KubernetesDiscoveredDatabase>));
      expect(reason).not.toContain(PASSWORD);
      expect(reason).not.toContain("not-a-real");
      reasons.add(reason);
    }
    expect(reasons.size).toBe(KUBERNETES_DISCOVERY_PROBLEMS.length);
  });

  it("explains each problem the exporter records", () => {
    const reason = (secret: Record<string, unknown>) =>
      refusalOf(database({ secret } as Partial<KubernetesDiscoveredDatabase>));
    expect(reason({ name: "orders-app", problem: "reserved_name" })).toBe(
      "the credential Secret orders-app has a name reserved for an operator's key material or internal credentials, so the exporter did not request it",
    );
    expect(reason({ name: "orders-app", problem: "wrong_type" })).toBe(
      "the credential Secret orders-app is not of type kubernetes.io/basic-auth, so the exporter discarded it",
    );
    expect(reason({ name: "orders-app", problem: "unexpected_key" })).toBe(
      "the credential Secret orders-app holds a key outside the CloudNativePG contract, so the exporter discarded it whole",
    );
    expect(reason({ name: "orders-app", problem: "missing_key", key: "dbname" })).toBe(
      "the credential Secret orders-app has no dbname",
    );
    expect(reason({ name: "orders-app", problem: "missing_key" })).toBe(
      "the credential Secret orders-app has no key the contract requires",
    );
    expect(reason({ name: "orders-app", problem: "service_not_found" })).toBe(
      "the Service orders-rw does not exist, so the exporter did not read the credential Secret",
    );
    expect(reason({ name: "orders-app", problem: "service_forbidden" })).toBe(
      "the exporter may not get the Service orders-rw: grant its ServiceAccount get on services in team-a",
    );
    expect(reason({ name: "orders-app", problem: "service_external_name" })).toBe(
      "the Service orders-rw is of type ExternalName, which can send the connection outside the namespace, so the exporter did not read the credential Secret",
    );
    expect(reason({ name: "orders-app", problem: "service_not_controlled" })).toBe(
      "the Service orders-rw has no selector and is not controlled by the Cluster orders, so the exporter did not read the credential Secret",
    );
    expect(reason({ name: "orders-app", problem: "service_invalid_name" })).toBe(
      "orders-rw cannot be a Service name (a DNS-1035 label of at most 63 characters), so no such Service exists",
    );
  });

  it("keys every mapping, refused or not, by its id key", () => {
    expect(mapKubernetesDatabase(database())).toMatchObject({ ok: true, key: "team-a/orders" });
    expect(mapKubernetesDatabase(database({ secret: { name: "orders-app", problem: "not_found" } }))).toMatchObject({
      ok: false,
      key: "team-a/orders",
    });
    process.env[CLUSTER_DOMAIN] = "Bad";
    expect(mapKubernetesDatabase(database())).toMatchObject({ ok: false, key: "team-a/orders" });
  });

  it("takes the id's digest from its seam", () => {
    const result = mapKubernetesDatabase(database(), () => "0".repeat(64));
    if (!result.ok) throw new Error(result.reason);
    expect(result.connection.id).toBe(`k8s-cnpg-${"0".repeat(32)}`);
  });
});

describe("the Crunchy PGO row", () => {
  const PGO_DATA = {
    user: "analyst",
    password: PASSWORD,
    host: "analytics-primary.team-b.svc",
    port: "5432",
    dbname: "analytics",
  };

  /** A PGO row of `analytics` in team-b for `user` (the default user when undefined), read through the parser. */
  function pgo(user: string | undefined, data: Record<string, string> = PGO_DATA, name = "analytics") {
    const secretUser = user ?? name;
    return parsedEntry({
      kind: "pgo",
      resource: {
        metadata: { namespace: "team-b", name },
        ...(user === undefined ? {} : { spec: { users: [{ name: user }] } }),
      },
      secret: { name: `${name}-pguser-${secretUser}`, data },
    });
  }

  it("is a per-user PostgreSQL row of PostgresClusters with Opaque Secrets", () => {
    expect(KUBERNETES_CONTRACT[2]).toBe(PGO_POSTGRES_CLUSTER);
    expect(PGO_POSTGRES_CLUSTER).toMatchObject({
      slug: "pgo",
      label: "Crunchy PGO",
      group: "postgres-operator.crunchydata.com",
      version: "v1beta1",
      kind: "PostgresCluster",
      plural: "postgresclusters",
      type: "postgres",
      perUser: true,
      secretType: "Opaque",
      secretKeys: ["user", "password", "host", "port", "dbname"],
    });
    const resource = { metadata: { namespace: "team-b", name: "analytics" }, spec: { users: [{ name: "analyst" }] } };
    expect(PGO_POSTGRES_CLUSTER.serviceName(resource)).toBe("analytics-primary");
    expect(PGO_POSTGRES_CLUSTER.secretName(resource)).toBe("analytics-pguser-analyst");
    expect(PGO_POSTGRES_CLUSTER.ssl(resource)).toEqual({ mode: "require" });
  });

  it("the default user is <name>", () => {
    const resource = { metadata: { namespace: "team-b", name: "metrics" } };
    expect(PGO_POSTGRES_CLUSTER.user(resource)).toBe("metrics");
    expect(PGO_POSTGRES_CLUSTER.secretName(resource)).toBe("metrics-pguser-metrics");
    const result = mapKubernetesDatabase(
      pgo(
        undefined,
        { ...PGO_DATA, user: "metrics", host: "metrics-primary.team-b.svc", dbname: "metrics" },
        "metrics",
      ),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.key).toBe("team-b/metrics/metrics");
    expect(result.connection).toMatchObject({
      id: `k8s-pgo-${sha256Prefix("team-b/metrics/metrics")}`,
      name: "team-b/metrics/metrics (Crunchy PGO)",
      host: "metrics-primary.team-b.svc.cluster.local.",
      database: "metrics",
      user: "metrics",
    });
    expect(result.secret).toEqual({ namespace: "team-b", name: "metrics-pguser-metrics" });
  });

  it("one row per spec.users entry keyed <ns>/<name>/<user>", () => {
    const analyst = mapKubernetesDatabase(pgo("analyst"));
    const reporter = mapKubernetesDatabase(pgo("reporter", { ...PGO_DATA, user: "reporter" }));
    if (!analyst.ok || !reporter.ok) throw new Error("a PGO user was refused");
    expect([analyst.key, reporter.key]).toEqual(["team-b/analytics/analyst", "team-b/analytics/reporter"]);
    expect(analyst.connection).toEqual({
      id: `k8s-pgo-${sha256Prefix("team-b/analytics/analyst")}`,
      name: "team-b/analytics/analyst (Crunchy PGO)",
      type: "postgres",
      host: "analytics-primary.team-b.svc.cluster.local.",
      port: 5432,
      database: "analytics",
      user: "analyst",
      password: PASSWORD,
      group: "team-b",
      ssl: { mode: "require" },
      managed: true,
      roles: ["admin"],
    });
    expect(reporter.connection.id).toBe(`k8s-pgo-${sha256Prefix("team-b/analytics/reporter")}`);
    expect(analyst.secret).toEqual({ namespace: "team-b", name: "analytics-pguser-analyst" });
    expect(reporter.secret).toEqual({ namespace: "team-b", name: "analytics-pguser-reporter" });
  });

  it("a host other than <name>-primary.<ns>.svc is refused without echoing it", () => {
    const forged = [
      "evil.example.com",
      "analytics-primary",
      "analytics-primary.team-a.svc",
      "metrics-primary.team-b.svc",
      "analytics-primary.team-b.svc.cluster.local.",
      "ANALYTICS-PRIMARY.team-b.svc",
      "analytics-replicas.team-b.svc",
      "analytics-primary.team-b.svc.corp.internal",
      "10.0.0.5",
    ];
    // The reason is one fixed text whatever the Secret holds, so it echoes none of it.
    for (const host of forged) {
      expect(refusalOf(pgo("analyst", { ...PGO_DATA, host }))).toBe(
        "the credential Secret analytics-pguser-analyst holds a host other than analytics-primary.team-b.svc",
      );
    }
    expect(refusalOf(pgo("analyst", { ...PGO_DATA, host: "" }))).toBe(
      "the credential Secret analytics-pguser-analyst has no host",
    );
  });

  it("a host of <name>-primary.<ns>.svc or <name>-primary.<ns>.svc.cluster.local connects to <name>-primary.<ns>.svc.cluster.local.", () => {
    for (const host of ["analytics-primary.team-b.svc", "analytics-primary.team-b.svc.cluster.local"]) {
      expect(connectionOf(pgo("analyst", { ...PGO_DATA, host })).host).toBe(
        "analytics-primary.team-b.svc.cluster.local.",
      );
    }
    process.env[CLUSTER_DOMAIN] = "corp.internal";
    for (const host of ["analytics-primary.team-b.svc", "analytics-primary.team-b.svc.corp.internal"]) {
      expect(connectionOf(pgo("analyst", { ...PGO_DATA, host })).host).toBe(
        "analytics-primary.team-b.svc.corp.internal.",
      );
    }
    expect(refusalOf(pgo("analyst", { ...PGO_DATA, host: "analytics-primary.team-b.svc.cluster.local" }))).toBe(
      "the credential Secret analytics-pguser-analyst holds a host other than analytics-primary.team-b.svc",
    );
  });

  it("a Secret without dbname is refused with its reason and never given a database", () => {
    const withoutDbname = without(PGO_DATA, "dbname");
    for (const data of [withoutDbname, { ...PGO_DATA, dbname: "" }]) {
      const result = mapKubernetesDatabase(pgo("analyst", data));
      expect(result).toEqual({
        ok: false,
        key: "team-b/analytics/analyst",
        reason: "the credential Secret analytics-pguser-analyst has no dbname",
      });
    }
  });

  it("a user other than the row's is refused", () => {
    for (const user of ["reporter", "postgres", "ANALYST", "analyst "]) {
      expect(refusalOf(pgo("analyst", { ...PGO_DATA, user }))).toBe(
        "the credential Secret analytics-pguser-analyst holds a user other than analyst",
      );
    }
    const withoutUser = without(PGO_DATA, "user");
    expect(refusalOf(pgo("analyst", withoutUser))).toBe("the credential Secret analytics-pguser-analyst has no user");
  });

  it("refuses a Secret without a password or a valid port", () => {
    expect(refusalOf(pgo("analyst", { ...PGO_DATA, password: "" }))).toBe(
      "the credential Secret analytics-pguser-analyst has no password",
    );
    const withoutPort = without(PGO_DATA, "port");
    for (const data of [
      withoutPort,
      { ...PGO_DATA, port: "0" },
      { ...PGO_DATA, port: "65536" },
      { ...PGO_DATA, port: "x" },
    ]) {
      expect(refusalOf(pgo("analyst", data))).toBe("the credential Secret analytics-pguser-analyst has no valid port");
    }
  });

  it("pgbouncer keys are never used", () => {
    const entry = pgo("analyst", {
      ...PGO_DATA,
      "pgbouncer-host": "evil.example.com",
      "pgbouncer-port": "6432",
      "pgbouncer-uri": "postgresql://analyst@evil.example.com:6432/analytics",
      "pgbouncer-jdbc-uri": "jdbc:postgresql://evil.example.com:6432/analytics",
    });
    expect(Object.keys(entry.secret.data ?? {}).sort()).toEqual(["dbname", "host", "password", "port", "user"]);
    expect(connectionOf(entry)).toMatchObject({ host: "analytics-primary.team-b.svc.cluster.local.", port: 5432 });
  });

  it("names the PostgresCluster in its ownership and Service refusals, and the user in no_database", () => {
    const refusal = (secret: Record<string, unknown>) =>
      refusalOf({ ...pgo("analyst"), secret } as KubernetesDiscoveredDatabase);
    expect(refusal({ name: "analytics-pguser-analyst", problem: "not_owned" })).toBe(
      "the credential Secret analytics-pguser-analyst is not owned by the PostgresCluster analytics, so the exporter did not export it",
    );
    expect(refusal({ name: "analytics-pguser-analyst", problem: "service_not_controlled" })).toBe(
      "the Service analytics-primary has no selector and is not controlled by the PostgresCluster analytics, so the exporter did not read the credential Secret",
    );
    expect(refusal({ name: "analytics-pguser-analyst", problem: "no_database" })).toBe(
      "the user analyst lists no database, so its credential Secret has no dbname and the exporter did not request it",
    );
    expect(refusal({ name: "analytics-pguser-analyst", problem: "wrong_type" })).toBe(
      "the credential Secret analytics-pguser-analyst is not of type Opaque, so the exporter discarded it",
    );
    expect(refusal({ name: "analytics-pguser-analyst", problem: "unexpected_key" })).toBe(
      "the credential Secret analytics-pguser-analyst holds a key outside the Crunchy PGO contract, so the exporter discarded it whole",
    );
  });
});

describe("the MongoDB Community row", () => {
  const HOST_0 = "catalog-0.catalog-svc.team-m.svc.cluster.local";
  const URI = `mongodb://appuser:${PASSWORD}@${HOST_0}:27017,catalog-1.catalog-svc.team-m.svc.cluster.local:27017/admin?replicaSet=catalog&ssl=false`;
  const MONGO_DATA = { "connectionString.standard": URI, username: "appuser", password: PASSWORD };

  /** A MongoDB row of `catalog` in team-m for user appuser, read through the parser; `spec` and `user` add to it. */
  function mongo(
    data: Record<string, string> = MONGO_DATA,
    user: Record<string, unknown> = {},
    spec: Record<string, unknown> = {},
  ) {
    return parsedEntry({
      kind: "mongo",
      resource: {
        metadata: { namespace: "team-m", name: "catalog" },
        spec: { users: [{ name: "appuser", db: "admin", roles: [{ db: "catalog" }], ...user }], ...spec },
      },
      secret: {
        name:
          (user.connectionStringSecretName as string | undefined) ??
          `catalog-${"db" in user ? ((user.db as string | undefined) ?? "admin") : "admin"}-appuser`,
        data,
      },
    });
  }

  const withUri = (uri: string) => mongo({ ...MONGO_DATA, "connectionString.standard": uri });

  it("is a per-user MongoDB row of MongoDBCommunity resources with Opaque Secrets", () => {
    expect(KUBERNETES_CONTRACT[3]).toBe(MONGODB_COMMUNITY);
    expect(MONGODB_COMMUNITY).toMatchObject({
      slug: "mongo",
      label: "MongoDB Community",
      group: "mongodbcommunity.mongodb.com",
      version: "v1",
      kind: "MongoDBCommunity",
      plural: "mongodbcommunity",
      type: "mongodb",
      perUser: true,
      secretType: "Opaque",
      secretKeys: ["connectionString.standard", "username", "password"],
    });
    const { resource } = mongo();
    expect(MONGODB_COMMUNITY.user(resource)).toBe("appuser");
    expect(MONGODB_COMMUNITY.serviceName(resource)).toBe("catalog-svc");
    expect(MONGODB_COMMUNITY.secretName(resource)).toBe("catalog-admin-appuser");
    expect(
      MONGODB_COMMUNITY.serviceName(
        mongo(MONGO_DATA, {}, { statefulSet: { spec: { serviceName: "catalog-hl" } } }).resource,
      ),
    ).toBe("catalog-hl");
    expect(
      MONGODB_COMMUNITY.secretName(mongo(MONGO_DATA, { connectionStringSecretName: "catalog-app" }).resource),
    ).toBe("catalog-app");
    // The user's database defaults to admin, as the operator's does.
    expect(MONGODB_COMMUNITY.secretName(mongo(MONGO_DATA, { db: undefined }).resource)).toBe("catalog-admin-appuser");
  });

  it("the first pod-record host and port of the URI, user db as authSource, first non-admin role db as database", () => {
    const result = mapKubernetesDatabase(mongo());
    expect(result).toEqual({
      ok: true,
      key: "team-m/catalog/appuser",
      connection: {
        id: `k8s-mongo-${sha256Prefix("team-m/catalog/appuser")}`,
        name: "team-m/catalog/appuser (MongoDB Community)",
        type: "mongodb",
        host: `${HOST_0}.`,
        port: 27017,
        database: "catalog",
        user: "appuser",
        password: PASSWORD,
        authSource: "admin",
        group: "team-m",
        ssl: { mode: "disable" },
        managed: true,
        roles: ["admin"],
      },
      secret: { namespace: "team-m", name: "catalog-admin-appuser" },
    });
    const second = withUri(`mongodb://appuser:x@catalog-2.catalog-svc.team-m.svc:27018,${HOST_0}:27017/admin`);
    expect(connectionOf(second)).toMatchObject({
      host: "catalog-2.catalog-svc.team-m.svc.cluster.local.",
      port: 27018,
    });
  });

  it("binds the first role database that is not admin, else the user's own database", () => {
    const database = (user: Record<string, unknown>) => connectionOf(mongo(MONGO_DATA, user));
    expect(database({ roles: [{ db: "admin" }, { db: "orders" }, { db: "catalog" }] })).toMatchObject({
      database: "orders",
      authSource: "admin",
    });
    expect(database({ roles: [{ db: "admin" }] })).toMatchObject({ database: "admin", authSource: "admin" });
    expect(database({ db: "appdb", roles: [] }).database).toBe("appdb");
    expect(database({ db: "appdb", roles: [] }).authSource).toBe("appdb");
    expect(database({ db: undefined, roles: [] })).toMatchObject({ database: "admin", authSource: "admin" });
  });

  it(".svc and .svc.cluster.local are accepted and both connect to the absolute pod name with the trailing dot", () => {
    for (const host of ["catalog-0.catalog-svc.team-m.svc", HOST_0]) {
      expect(connectionOf(withUri(`mongodb://appuser:x@${host}:27017/admin`)).host).toBe(`${HOST_0}.`);
    }
    process.env[CLUSTER_DOMAIN] = "corp.internal";
    for (const host of ["catalog-0.catalog-svc.team-m.svc", "catalog-0.catalog-svc.team-m.svc.corp.internal"]) {
      expect(connectionOf(withUri(`mongodb://appuser:x@${host}:27017/admin`)).host).toBe(
        "catalog-0.catalog-svc.team-m.svc.corp.internal.",
      );
    }
    expect(refusalOf(withUri(`mongodb://appuser:x@${HOST_0}:27017/admin`))).toBe(
      "the credential Secret catalog-admin-appuser names a host outside catalog-svc.team-m.svc",
    );
  });

  it("takes the hosts after the last @ of an authority that ends at the first / or ?, with or without credentials", () => {
    const hostOf = (uri: string) => connectionOf(withUri(uri)).host;
    expect(hostOf(`mongodb://${HOST_0}:27017/admin`)).toBe(`${HOST_0}.`);
    expect(hostOf(`mongodb://app@user:p@ss@${HOST_0}:27017?replicaSet=catalog`)).toBe(`${HOST_0}.`);
    expect(hostOf(`mongodb://appuser:x@${HOST_0}`)).toBe(`${HOST_0}.`);
    // A raw / in the credentials ends the authority early, so no host is the row's and it is refused.
    expect(refusalOf(withUri(`mongodb://appuser:pa/ss@${HOST_0}:27017/admin`))).toBe(
      "the credential Secret catalog-admin-appuser names a host outside catalog-svc.team-m.svc",
    );
  });

  it("follows a statefulSet serviceName override", () => {
    const entry = mongo(
      { ...MONGO_DATA, "connectionString.standard": "mongodb://appuser:x@catalog-0.catalog-hl.team-m.svc:27017/admin" },
      {},
      { statefulSet: { spec: { serviceName: "catalog-hl" } } },
    );
    expect(connectionOf(entry).host).toBe("catalog-0.catalog-hl.team-m.svc.cluster.local.");
    expect(refusalOf(mongo(MONGO_DATA, {}, { statefulSet: { spec: { serviceName: "catalog-hl" } } }))).toBe(
      "the credential Secret catalog-admin-appuser names a host outside catalog-hl.team-m.svc",
    );
  });

  it("27017 when the port is absent", () => {
    expect(connectionOf(withUri(`mongodb://appuser:x@${HOST_0}/admin`)).port).toBe(27017);
  });

  it("refuses a URI that is not mongodb://, names no host, or names a host or port outside the row", () => {
    const outside = "the credential Secret catalog-admin-appuser names a host outside catalog-svc.team-m.svc";
    const cases: [string, string][] = [
      [
        `mongodb+srv://appuser:x@catalog-svc.team-m.svc.cluster.local/admin`,
        "the credential Secret catalog-admin-appuser is not a mongodb:// connection string",
      ],
      [
        `MONGODB://appuser:x@${HOST_0}/admin`,
        "the credential Secret catalog-admin-appuser is not a mongodb:// connection string",
      ],
      [
        `postgresql://appuser:x@${HOST_0}/admin`,
        "the credential Secret catalog-admin-appuser is not a mongodb:// connection string",
      ],
      ["mongodb:///admin", "the credential Secret catalog-admin-appuser names no host"],
      ["mongodb://appuser:x@/admin", "the credential Secret catalog-admin-appuser names no host"],
      ["mongodb://appuser:x@?replicaSet=catalog", "the credential Secret catalog-admin-appuser names no host"],
      ["mongodb://appuser:x@catalog-0.other-svc.team-m.svc:27017/admin", outside],
      ["mongodb://appuser:x@catalog-0.catalog-svc.team-x.svc:27017/admin", outside],
      ["mongodb://appuser:x@catalog-x.catalog-svc.team-m.svc:27017/admin", outside],
      ["mongodb://appuser:x@catalog-01.catalog-svc.team-m.svc:27017/admin", outside],
      ["mongodb://appuser:x@other-0.catalog-svc.team-m.svc:27017/admin", outside],
      ["mongodb://appuser:x@catalog-0xcatalog-svc.team-m.svc:27017/admin", outside],
      ["mongodb://appuser:x@catalog-0.catalog-svc.team-m.svc.cluster.local.:27017/admin", outside],
      ["mongodb://appuser:x@catalog-0.catalog-svc.team-m.svc.evil.example.com:27017/admin", outside],
      ["mongodb://appuser:x@10.0.0.5:27017/admin", outside],
      ["mongodb://appuser:x@[::1]:27017/admin", outside],
      [`mongodb://appuser:x@${HOST_0}:27017,10.0.0.5:27017/admin`, outside],
      [`mongodb://appuser:x@${HOST_0}:27017,/admin`, outside],
      [`mongodb://appuser:x@${HOST_0}:0/admin`, "the credential Secret catalog-admin-appuser has no valid port"],
      [`mongodb://appuser:x@${HOST_0}:65536/admin`, "the credential Secret catalog-admin-appuser has no valid port"],
      [`mongodb://appuser:x@${HOST_0}:/admin`, outside],
      [
        `mongodb://appuser:x@${HOST_0}:27017,${HOST_0}:99999/admin`,
        "the credential Secret catalog-admin-appuser has no valid port",
      ],
    ];
    for (const [uri, reason] of cases) {
      const refused = refusalOf(withUri(uri));
      expect(refused).toBe(reason);
      expect(refused).not.toContain("evil");
    }
  });

  it("refuses a Secret whose username is not the row's user, or without a username, password or connection string", () => {
    expect(refusalOf(mongo({ ...MONGO_DATA, username: "admin" }))).toBe(
      "the credential Secret catalog-admin-appuser holds a username other than appuser",
    );
    expect(refusalOf(mongo({ ...MONGO_DATA, username: "" }))).toBe(
      "the credential Secret catalog-admin-appuser has no username",
    );
    expect(refusalOf(mongo({ ...MONGO_DATA, password: "" }))).toBe(
      "the credential Secret catalog-admin-appuser has no password",
    );
    expect(refusalOf(mongo({ username: "appuser", password: PASSWORD }))).toBe(
      "the credential Secret catalog-admin-appuser has no connectionString.standard",
    );
  });

  it("no connectionString, and URI options leave no trace", () => {
    const entry = withUri(
      `mongodb://appuser:x@${HOST_0}:27017/admin?replicaSet=catalog&proxyHost=evil.example.com&tlsCertificateKeyFile=/etc/evil.pem&authMechanism=PLAIN`,
    );
    const connection = connectionOf(entry);
    expect(connection).not.toHaveProperty("connectionString");
    const text = JSON.stringify(connection);
    for (const trace of ["evil", "proxyHost", "tlsCertificateKeyFile", "PLAIN", "replicaSet", "mongodb://"]) {
      expect(text).not.toContain(trace);
    }
  });

  it("MongoDB is require with TLS enabled and disable otherwise", () => {
    const sslOf = (spec: Record<string, unknown>) => connectionOf(mongo(MONGO_DATA, {}, spec)).ssl;
    expect(sslOf({ security: { tls: { enabled: true } } })).toEqual({ mode: "require" });
    expect(sslOf({ security: { tls: { enabled: false } } })).toEqual({ mode: "disable" });
    expect(sslOf({})).toEqual({ mode: "disable" });
    expect(MONGODB_COMMUNITY.ssl(mongo(MONGO_DATA, {}, { security: { tls: { enabled: true } } }).resource)).toEqual({
      mode: "require",
    });
  });

  it("names the user and the MongoDBCommunity in its own refusals", () => {
    const refusal = (secret: Record<string, unknown>) =>
      refusalOf({ ...mongo(), secret } as KubernetesDiscoveredDatabase);
    expect(refusal({ problem: "unsupported_name" })).toBe(
      "the connection string Secret name of user appuser needs the operator's name normalization, which discovery does not compute: set connectionStringSecretName on the user",
    );
    expect(refusal({ name: "catalog-admin-appuser", problem: "other_namespace" })).toBe(
      "the user appuser keeps its connection string Secret in another namespace, which discovery does not read",
    );
    expect(refusal({ name: "catalog-admin-appuser", problem: "not_owned" })).toBe(
      "the credential Secret catalog-admin-appuser is not owned by the MongoDBCommunity catalog, so the exporter did not export it",
    );
    expect(refusal({ name: "catalog-admin-appuser", problem: "service_not_found" })).toBe(
      "the Service catalog-svc does not exist, so the exporter did not read the credential Secret",
    );
  });
});

describe("every row", () => {
  it("the contract table has the four first-release rows with their kinds, slugs, labels and types", () => {
    expect(KUBERNETES_CONTRACT).toEqual([CNPG_CLUSTER, EDB_CLUSTER, PGO_POSTGRES_CLUSTER, MONGODB_COMMUNITY]);
    expect(KUBERNETES_CONTRACT.map((row) => [row.slug, row.kind, row.label, row.type])).toEqual([
      ["cnpg", "Cluster", "CloudNativePG", "postgres"],
      ["edbpg", "Cluster", "EDB Postgres for Kubernetes", "postgres"],
      ["pgo", "PostgresCluster", "Crunchy PGO", "postgres"],
      ["mongo", "MongoDBCommunity", "MongoDB Community", "mongodb"],
    ]);
    expect(Object.isFrozen(KUBERNETES_CONTRACT)).toBe(true);
    for (const row of KUBERNETES_CONTRACT) expect(Object.isFrozen(row)).toBe(true);
  });
});

describe("the golden fixture", () => {
  const cases = GOLDEN_CASES.map(
    (c) =>
      [
        `${goldenRow(c).slug} ${c.resource.metadata.namespace}/${c.resource.metadata.name}${c.user === undefined ? "" : `/${c.user}`}`,
        c,
      ] as const,
  );

  it("is Studio's own copy, with a case of every kind", () => {
    expect(golden.provenance).toBe("libredb-studio");
    expect(new Set(GOLDEN_CASES.map((c) => goldenRow(c).slug))).toEqual(
      new Set(KUBERNETES_CONTRACT.map((row) => row.slug)),
    );
  });

  it.each(cases)("the golden fixture: %s maps to its connection, id and link", (_, c) => {
    const row = goldenRow(c);
    const entry = parsedEntry(goldenEntry(c) as unknown as Record<string, unknown>);
    expect(row.secretName(entry.resource)).toBe(c.secretName);
    expect(row.serviceName(entry.resource)).toBe(c.service.name);
    expect(row.secretType).toBe(c.secretType);
    expect(row.user(entry.resource)).toBe(c.user);
    const result = mapKubernetesDatabase(entry);
    if (!result.ok) throw new Error(result.reason);
    const key = kubernetesIdKey(c.resource.metadata.namespace, c.resource.metadata.name, c.user);
    expect(result.key).toBe(key);
    // The fixture's id was generated by the implementation once; the rule is checked here from first principles.
    expect(c.connectionId).toBe(`k8s-${row.slug}-${sha256Prefix(key)}`);
    expect(result.connection).toEqual({ ...c.connection, id: c.connectionId, managed: true, roles: ["admin"] });
    expect(result.secret).toEqual({ namespace: c.resource.metadata.namespace, name: c.secretName });
    // The link opens the connection the managed list names seed:<id>, read the way the editor reads it.
    expect(new URL(c.link).searchParams.get("connection")).toBe(`seed:${c.connectionId}`);
    expect(c.link).toBe(`${c.toURL.replace(/\/+$/, "")}/?connection=seed%3A${c.connectionId}`);
  });

  it("holds every key its row keeps, and every case's id once", () => {
    for (const c of GOLDEN_CASES) {
      for (const key of goldenRow(c).secretKeys) {
        if (c.secretName === "billing-owner" && (key === "dbname" || key === "port")) continue;
        expect(Object.keys(c.secretData)).toContain(key);
      }
    }
    const ids = GOLDEN_CASES.map((c) => c.connectionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every connected host of every row ends in .svc.<domain>. and none is a short name", () => {
    for (const c of GOLDEN_CASES) {
      const result = mapKubernetesDatabase(goldenEntry(c));
      if (!result.ok) throw new Error(result.reason);
      const host = result.connection.host as string;
      const { namespace } = c.resource.metadata;
      const service = `${c.service.name}.${namespace}.svc.cluster.local.`;
      expect(
        host === service || (host.endsWith(`.${service}`) && host.split(".").length === service.split(".").length + 1),
      ).toBe(true);
      expect(host.endsWith(".svc.cluster.local.")).toBe(true);
      // A pod's resolver tries a name of fewer than five dots against its search list first.
      expect(host.split(".").length - 1).toBeGreaterThanOrEqual(5);
    }
  });

  it("a CNPG and a PGO resource of one name in one namespace keep distinct Secrets, Services and ids", () => {
    const analytics = GOLDEN_CASES.filter(
      (c) => c.resource.metadata.namespace === "team-b" && c.resource.metadata.name === "analytics",
    );
    expect(analytics.map((c) => goldenRow(c).slug).sort()).toEqual(["cnpg", "pgo", "pgo"]);
    for (const field of [(c: GoldenCase) => c.secretName, (c: GoldenCase) => c.connectionId]) {
      expect(new Set(analytics.map(field)).size).toBe(3);
    }
    expect(new Set(analytics.map((c) => c.service.name))).toEqual(new Set(["analytics-rw", "analytics-primary"]));
    const secrets = analytics.map((c) => {
      const result = mapKubernetesDatabase(goldenEntry(c));
      if (!result.ok) throw new Error(result.reason);
      return result.secret.name;
    });
    expect(new Set(secrets).size).toBe(3);
  });
});
