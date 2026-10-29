/**
 * The Kubernetes discovery contract (docs/SEED_CONNECTIONS.md, "Platform discovery (Kubernetes)"): one row per
 * supported kind, the connection id rule, and the seed connection each exported database becomes.
 *
 * The same rows live as data in three places that must agree: here, in the exporter (`CONTRACT` in
 * docker/discover-kubernetes.mjs, which a unit test holds to this table), and in the Rancher extension, which builds
 * the link that opens a connection from the resource alone. The golden fixture
 * (tests/fixtures/kubernetes-discovery-golden.json) pins the three sides together, and the extension copies it from a
 * released tag.
 *
 * Every connection is built here with its access fields forced in code: managed, the admin role, TLS required, no MCP
 * opt-in, no read-only mode, no connection string. Nothing in the export can change them. Every host is a fully
 * qualified name with a trailing dot in the cluster domain SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN names,
 * `cluster.local` by default, so the pod's DNS search path never applies; while that variable is not a DNS name, no
 * database is listed.
 * The roles a session sees, the literal marker and the Secret marker the Kubernetes access review reads are set after
 * filterByRoles, in src/lib/seed/index.ts, because filterByRoles copies a fixed field list.
 *
 * A refusal names a field, a key or a Secret, never a value: the values are database passwords.
 */
import { createHash } from "node:crypto";
import type { DatabaseType } from "@/lib/types";
import type { KubernetesDiscoveredDatabase, KubernetesDiscoveredResource } from "./kubernetes-discovery-export";
import { SeedConnectionSchema, type SeedConnection } from "./types";

/** The Kubernetes Secret a connection's credentials come from, which the access review asks about. */
export interface KubernetesSecretRef {
  readonly namespace: string;
  readonly name: string;
}

type SecretData = NonNullable<KubernetesDiscoveredDatabase["secret"]["data"]>;

type Fields =
  | { ok: true; fields: Pick<SeedConnection, "host" | "port" | "database" | "user" | "password"> }
  | { ok: false; reason: string };

export interface KubernetesContractRow {
  /** The kind slug in the export and in the connection id. */
  readonly slug: string;
  /** The operator's name, as the connection's name shows it. */
  readonly label: string;
  readonly group: string;
  readonly version: string;
  readonly kind: string;
  readonly plural: string;
  /** The Studio connection type the kind maps to. */
  readonly type: DatabaseType;
  /** The keys of the credential Secret the exporter keeps. */
  readonly secretKeys: readonly string[];
  /** The Secret the credentials are read from. */
  secretName(resource: KubernetesDiscoveredResource): string;
  /** Why the exporter left the Secret out as not belonging to the resource: the tie the row requires. */
  notOwned(resource: KubernetesDiscoveredResource, secretName: string): string;
  /**
   * The connection fields the resource and its Secret give, or why they give none. The host is a fully qualified name
   * in `clusterDomain`, built and checked with serviceHost.
   */
  fields(resource: KubernetesDiscoveredResource, secretName: string, data: SecretData, clusterDomain: string): Fields;
}

/** The PostgreSQL port CloudNativePG serves on, the port of a Secret the user supplied. */
const CNPG_PORT = 5432;
/** The seed schema's bound on a connection's name. */
const NAME_MAX_CHARS = 128;
/** The database CloudNativePG's initdb creates when the resource names none. */
const CNPG_DEFAULT_DATABASE = "app";
const PORT_PATTERN = /^\d{1,5}$/;
/** The cluster domain while SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN is unset or blank, Kubernetes' default. */
const DEFAULT_CLUSTER_DOMAIN = "cluster.local";
/** The longest DNS name, without its trailing dot. */
const DNS_NAME_MAX_CHARS = 253;
/** A DNS label as Kubernetes writes one: 1 to 63 lowercase letters, digits and inner hyphens. */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const INVALID_CLUSTER_DOMAIN =
  "SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN is not a DNS name: name the cluster's domain, such as cluster.local, in lowercase letters, digits and hyphens, with dots between its labels and none at either end";
/** The label every Service's name carries before the cluster domain, `<service>.<namespace>.svc.<domain>`. */
const SERVICES_LABEL = "svc";
const SVC_CLUSTER_DOMAIN =
  "SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN starts with the Services' subdomain, which every discovered host already carries: name the cluster domain itself, such as cluster.local";

/**
 * The cluster's DNS domain, which every discovered host ends in: SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN, trimmed, or
 * `cluster.local` while it is unset or blank. It is read on every mapping, never cached with the export. A value that
 * is not a DNS name, or whose first label is `svc`, is refused, naming the variable and not the value.
 */
function kubernetesClusterDomain(): { ok: true; domain: string } | { ok: false; reason: string } {
  const domain = process.env.SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN?.trim() || DEFAULT_CLUSTER_DOMAIN;
  const isDnsName = domain.length <= DNS_NAME_MAX_CHARS && domain.split(".").every((label) => DNS_LABEL.test(label));
  if (!isDnsName) return { ok: false, reason: INVALID_CLUSTER_DOMAIN };
  if (domain.split(".")[0] === SERVICES_LABEL) return { ok: false, reason: SVC_CLUSTER_DOMAIN };
  return { ok: true, domain };
}

/** The longest DNS label. */
const DNS_LABEL_MAX_CHARS = 63;

/**
 * A Service's fully qualified name with the trailing dot, `<service>.<namespace>.svc.<clusterDomain>.`: discovered
 * hosts are fully qualified names with a trailing dot, so the pod's DNS search path never applies. The resource name
 * the Service is named after must be a single label, and the host a DNS name: at most 253 characters without its
 * trailing dot, each label 1 to 63. A refusal names the field, never the value.
 */
function serviceHost(
  resourceName: string,
  service: string,
  namespace: string,
  clusterDomain: string,
): { ok: true; host: string } | { ok: false; reason: string } {
  if (resourceName.includes(".")) {
    return {
      ok: false,
      reason: "the resource's metadata.name is not a single DNS label, which the host's Service name needs",
    };
  }
  const name = `${service}.${namespace}.${SERVICES_LABEL}.${clusterDomain}`;
  if (name.length > DNS_NAME_MAX_CHARS) {
    return { ok: false, reason: "the host is not a DNS name: it is over 253 characters" };
  }
  if (!name.split(".").every((label) => label.length >= 1 && label.length <= DNS_LABEL_MAX_CHARS)) {
    return { ok: false, reason: "the host is not a DNS name: one of its labels is not 1 to 63 characters" };
  }
  return { ok: true, host: `${name}.` };
}

/** A value of the Secret, with an empty value counted as absent. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * A CloudNativePG `Cluster`: the Secret named by `.spec.bootstrap.initdb.secret.name` when set, otherwise the
 * `<name>-app` Secret the operator writes. From `<name>-app` every field but the host comes from the Secret; from a
 * Secret the user supplied, a `kubernetes.io/basic-auth` Secret, only the user and password do, and the database is
 * initdb's, `app` by default, on port 5432. The host is always the read-write Service by its fully qualified name,
 * because Studio runs in a namespace of its own and the Secret's `host` is the short name.
 */
export const CNPG_CLUSTER: KubernetesContractRow = Object.freeze({
  slug: "cnpg",
  label: "CloudNativePG",
  group: "postgresql.cnpg.io",
  version: "v1",
  kind: "Cluster",
  plural: "clusters",
  type: "postgres",
  secretKeys: Object.freeze(["username", "password", "dbname", "port"]),
  secretName(resource: KubernetesDiscoveredResource): string {
    return present(resource.spec?.bootstrap?.initdb?.secret?.name) ?? `${resource.metadata.name}-app`;
  },
  notOwned(resource: KubernetesDiscoveredResource, secretName: string): string {
    return present(resource.spec?.bootstrap?.initdb?.secret?.name) === undefined
      ? `the credential Secret ${secretName} is neither owned by the Cluster nor labelled cnpg.io/cluster=${resource.metadata.name}, so the exporter did not export it`
      : `the credential Secret ${secretName} belongs to another resource or is not of type kubernetes.io/basic-auth, so the exporter did not export it`;
  },
  fields(resource: KubernetesDiscoveredResource, secretName: string, data: SecretData, clusterDomain: string): Fields {
    const user = present(data.username);
    if (user === undefined) return { ok: false, reason: `the credential Secret ${secretName} has no username` };
    const password = present(data.password);
    if (password === undefined) return { ok: false, reason: `the credential Secret ${secretName} has no password` };
    const { name, namespace } = resource.metadata;
    const service = serviceHost(name, `${name}-rw`, namespace, clusterDomain);
    if (!service.ok) return service;
    const { host } = service;
    const initdb = resource.spec?.bootstrap?.initdb;
    if (present(initdb?.secret?.name) !== undefined) {
      return {
        ok: true,
        fields: { host, port: CNPG_PORT, database: initdb?.database ?? CNPG_DEFAULT_DATABASE, user, password },
      };
    }
    const database = present(data.dbname);
    if (database === undefined) return { ok: false, reason: `the credential Secret ${secretName} has no dbname` };
    const port = Number(data.port);
    if (!PORT_PATTERN.test(data.port ?? "") || port < 1 || port > 65535) {
      return { ok: false, reason: `the credential Secret ${secretName} has no valid port` };
    }
    return { ok: true, fields: { host, port, database, user, password } };
  },
});

/** The contract table: one row per supported kind. The first release supports CloudNativePG only. */
export const KUBERNETES_CONTRACT: readonly KubernetesContractRow[] = Object.freeze([CNPG_CLUSTER]);

/**
 * The id Studio lists a discovered database under: `k8s-<slug>-<first 12 hex characters of
 * sha256("<namespace>/<name>")>`, which fits the seed id rule whatever the names' length. The cluster is not part of
 * it, because one Studio serves one cluster.
 */
export function kubernetesConnectionId(slug: string, namespace: string, name: string): string {
  const digest = createHash("sha256").update(`${namespace}/${name}`).digest("hex");
  return `k8s-${slug}-${digest.slice(0, 12)}`;
}

/**
 * `<namespace>/<name> (<label>)`, with the start of `<namespace>/<name>` cut to an ellipsis when the whole would be over
 * the seed schema's 128 characters, so a Cluster with long names is listed, not skipped: the end names the resource,
 * and the connection's group shows the namespace whole. Kubernetes names are ASCII, so no character is split.
 */
function connectionName(namespace: string, name: string, label: string): string {
  const suffix = ` (${label})`;
  const path = `${namespace}/${name}`;
  const room = NAME_MAX_CHARS - suffix.length;
  return path.length <= room ? `${path}${suffix}` : `…${path.slice(path.length - room + 1)}${suffix}`;
}

const SECRET_PROBLEMS = {
  not_found: (secret: string) => `the credential Secret ${secret} does not exist`,
  forbidden: (secret: string) => `the exporter may not read the credential Secret ${secret}`,
  invalid_value: (secret: string, key = "value") =>
    `the credential Secret ${secret} holds a ${key} that is over 1024 bytes or not UTF-8 text`,
} as const;

export type KubernetesMappingResult =
  | { ok: true; connection: SeedConnection; secret: KubernetesSecretRef }
  | { ok: false; reason: string };

/** The seed connection an exported database becomes, with the Secret its credentials came from, or why it is skipped. */
export function mapKubernetesDatabase(entry: KubernetesDiscoveredDatabase): KubernetesMappingResult {
  // A cluster domain that is not a DNS name refuses every database, so no host is ever built from it.
  const clusterDomain = kubernetesClusterDomain();
  if (!clusterDomain.ok) return { ok: false, reason: clusterDomain.reason };
  // The export's schema admits only the kinds of this table, so a row always exists.
  const row = KUBERNETES_CONTRACT.find((candidate) => candidate.slug === entry.kind) as KubernetesContractRow;
  const { namespace, name } = entry.resource.metadata;
  const secretName = entry.secret.name;
  // An exporter of another version could read another Secret than this row names; the review must ask about the one
  // whose values the connection carries, so such an entry is not listed.
  const expected = row.secretName(entry.resource);
  if (secretName !== expected) {
    return {
      ok: false,
      reason: `the export names the credential Secret ${secretName}, where the contract names ${expected}`,
    };
  }
  if (entry.secret.data === undefined) {
    if (entry.secret.problem === "not_owned") return { ok: false, reason: row.notOwned(entry.resource, secretName) };
    const problem = entry.secret.problem as keyof typeof SECRET_PROBLEMS;
    return { ok: false, reason: SECRET_PROBLEMS[problem](secretName, entry.secret.key) };
  }
  const fields = row.fields(entry.resource, secretName, entry.secret.data, clusterDomain.domain);
  if (!fields.ok) return fields;

  const result = SeedConnectionSchema.safeParse({
    id: kubernetesConnectionId(row.slug, namespace, name),
    name: connectionName(namespace, name, row.label),
    type: row.type,
    ...fields.fields,
    group: namespace,
    ssl: { mode: "require" },
    managed: true,
    roles: ["admin"],
  });
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")} (${issue.code})`).join(", ");
    return { ok: false, reason: `the connection is not valid: ${issues}` };
  }
  return { ok: true, connection: result.data, secret: { namespace, name: secretName } };
}
