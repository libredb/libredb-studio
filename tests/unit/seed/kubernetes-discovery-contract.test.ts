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
  KUBERNETES_CONTRACT,
  kubernetesConnectionId,
  mapKubernetesDatabase,
} from "@/lib/seed/kubernetes-discovery-contract";
import type { KubernetesDiscoveredDatabase } from "@/lib/seed/kubernetes-discovery-export";

const PASSWORD = "not-a-real-password-orders";
const CLUSTER_DOMAIN = "KUBERNETES_DISCOVERY_CLUSTER_DOMAIN";
const INVALID_CLUSTER_DOMAIN =
  "KUBERNETES_DISCOVERY_CLUSTER_DOMAIN is not a DNS name: name the cluster's domain, such as cluster.local, in lowercase letters, digits and hyphens, with dots between its labels and none at either end";

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

describe("the contract table", () => {
  it("holds CloudNativePG Clusters only in the first release", () => {
    expect(KUBERNETES_CONTRACT).toEqual([CNPG_CLUSTER]);
    expect(CNPG_CLUSTER).toMatchObject({
      slug: "cnpg",
      label: "CloudNativePG",
      group: "postgresql.cnpg.io",
      version: "v1",
      kind: "Cluster",
      plural: "clusters",
      type: "postgres",
      secretKeys: ["username", "password", "dbname", "port"],
    });
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
  it('is k8s-<slug>-<first 12 hex characters of sha256("<namespace>/<name>")>', () => {
    const digest = createHash("sha256").update("ns-1/db-1").digest("hex").slice(0, 12);
    expect(kubernetesConnectionId("cnpg", "ns-1", "db-1")).toBe(`k8s-cnpg-${digest}`);
  });

  it("differs per namespace for the same name, and fits Studio's id rule whatever the names' length", () => {
    expect(kubernetesConnectionId("cnpg", "team-a", "db")).not.toBe(kubernetesConnectionId("cnpg", "team-b", "db"));
    const id = kubernetesConnectionId("cnpg", "n".repeat(63), "d".repeat(253));
    expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
  });
});

describe("mapKubernetesDatabase", () => {
  it("maps a Cluster's <name>-app Secret: user, password, database and port from the Secret", () => {
    expect(mapKubernetesDatabase(database())).toEqual({
      ok: true,
      connection: {
        id: kubernetesConnectionId("cnpg", "team-a", "orders"),
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

  it("ends the host in the cluster domain KUBERNETES_DISCOVERY_CLUSTER_DOMAIN names", () => {
    for (const value of ["corp.internal", " corp.internal ", "k8s"]) {
      process.env[CLUSTER_DOMAIN] = value;
      const result = mapKubernetesDatabase(database());
      if (!result.ok) throw new Error(result.reason);
      expect(result.connection.host).toBe(`orders-rw.team-a.svc.${value.trim()}.`);
    }
  });

  it("skips every database while KUBERNETES_DISCOVERY_CLUSTER_DOMAIN is not a DNS name, naming the variable, not the value", () => {
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
    expect(long.connection).toMatchObject({ group: namespace, id: kubernetesConnectionId("cnpg", namespace, name) });

    const longest = named(namespace, "d".repeat(253));
    if (!longest.ok) throw new Error(longest.reason);
    expect(longest.connection.name).toBe(`…${"d".repeat(111)} (CloudNativePG)`);

    // 111 characters of namespace and name fit whole.
    const fits = named(`ns-${"a".repeat(57)}`, "d".repeat(51));
    if (!fits.ok) throw new Error(fits.reason);
    expect(fits.connection.name).toBe(`ns-${"a".repeat(57)}/${"d".repeat(51)} (CloudNativePG)`);
    expect(fits.connection.name).toHaveLength(128);
  });

  // The export's schema already refuses a namespace over 63 characters; the seed schema checks the connection again.
  it("skips a connection the seed schema refuses, naming the field and the issue, never a value", () => {
    const reason = refusalOf(
      database({
        resource: { metadata: { namespace: "n".repeat(65), name: "orders" } },
        secret: { name: "orders-app", data: { username: "u", password: PASSWORD, dbname: "x", port: "5432" } },
      }),
    );
    expect(reason).toBe("the connection is not valid: group (too_big)");
    expect(reason).not.toContain(PASSWORD);
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
