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
import {
  CNPG_CLUSTER,
  EDB_CLUSTER,
  KUBERNETES_CONTRACT,
  kubernetesConnectionId,
  kubernetesIdKey,
  mapKubernetesDatabase,
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

  it.each(golden.cases.filter((c) => c.resource.kind === "Cluster").map((c) => [c.secretName, c] as const))(
    "EDB maps exactly as CloudNativePG except slug, group and label: %s",
    (_, c) => {
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
    },
  );

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

describe("the golden fixture", () => {
  it("is Studio's own copy", () => {
    expect(golden.provenance).toBe("libredb-studio");
    expect(golden.cases.length).toBeGreaterThan(0);
  });

  it("names every host as a fully qualified name with a trailing dot", () => {
    for (const c of golden.cases) {
      const { namespace, name } = c.resource.metadata;
      expect(c.connection.host).toBe(`${name}-rw.${namespace}.svc.cluster.local.`);
    }
  });

  it.each(golden.cases.map((c) => [`${c.resource.metadata.namespace}/${c.resource.metadata.name}`, c] as const))(
    "%s maps to its Secret, its id, its connection and its link",
    (_, c) => {
      expect(CNPG_CLUSTER.secretName(c.resource)).toBe(c.secretName);
      const result = mapKubernetesDatabase({
        kind: "cnpg",
        resource: c.resource,
        secret: { name: c.secretName, data: c.secretData },
      });
      if (!result.ok) throw new Error(result.reason);
      expect(result.connection.id).toBe(c.connectionId);
      expect(result.connection).toMatchObject(c.connection);
      expect(result.secret).toEqual({ namespace: c.resource.metadata.namespace, name: c.secretName });
      // The link opens the connection the managed list names seed:<id>, read the way the editor reads it.
      expect(new URL(c.link).searchParams.get("connection")).toBe(`seed:${c.connectionId}`);
      expect(c.link.startsWith(`${c.toURL.replace(/\/+$/, "")}/?connection=`)).toBe(true);
    },
  );
});
