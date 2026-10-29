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
 * Every connection is built here with its access fields forced in code: managed, the admin role, its row's TLS mode
 * (required on every PostgreSQL row), no MCP opt-in, no read-only mode, no connection string. Nothing in the export can
 * change them. A connection's id is `k8s-<slug>-` and the first 32 hex characters of SHA-256 over its key,
 * `<namespace>/<name>`, or `<namespace>/<name>/<user>` for a kind that gives one row per database user. Every host is a fully
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
import type {
  KUBERNETES_DISCOVERY_SECRET_KEYS,
  KubernetesDiscoveredDatabase,
  KubernetesDiscoveredResource,
  KubernetesSecretProblem,
} from "./kubernetes-discovery-export";
import { SeedConnectionSchema, type SeedConnection } from "./types";

/** The Kubernetes Secret a connection's credentials come from, which the access review asks about. */
export interface KubernetesSecretRef {
  readonly namespace: string;
  readonly name: string;
}

/** A row's kept keys of its credential Secret; each row reads its own. */
type SecretData = Partial<Record<(typeof KUBERNETES_DISCOVERY_SECRET_KEYS)[number], string>>;

type CnpgResource = Extract<KubernetesDiscoveredDatabase, { kind: "cnpg" | "edbpg" }>["resource"];

type Fields =
  | { ok: true; fields: Pick<SeedConnection, "host" | "port" | "database" | "user" | "password" | "authSource"> }
  | { ok: false; reason: string };

/** The TLS mode a row's connection is opened with, forced in code. */
type RowSsl = { readonly mode: "require" | "disable" };

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
  /** Whether the kind gives one row per database user, keyed `<namespace>/<name>/<user>`, rather than one per resource. */
  readonly perUser: boolean;
  /** The type the exporter requires of the credential Secret. */
  readonly secretType: string;
  /** The keys of the credential Secret the exporter keeps. */
  readonly secretKeys: readonly string[];
  /** The database user of a per-user row, which its key and its name end in; undefined for a row per resource. */
  user(resource: KubernetesDiscoveredResource): string | undefined;
  /** The Service the exporter checks before it reads the Secret, and whose name the connection's host starts with. */
  serviceName(resource: KubernetesDiscoveredResource): string;
  /** The TLS mode the connection is opened with, whatever the export says. */
  ssl(resource: KubernetesDiscoveredResource): RowSsl;
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

/** Every PostgreSQL row is opened with TLS required: each operator serves TLS, and Crunchy PGO refuses anything else. */
const REQUIRE: RowSsl = Object.freeze({ mode: "require" });

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

/** A port value of an operator-written Secret: 1 to 65535, written in digits. */
function validPort(value: string | undefined): number | undefined {
  const port = Number(value);
  return PORT_PATTERN.test(value ?? "") && port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * A row of the CloudNativePG family: CloudNativePG itself and EDB Postgres for Kubernetes, its downstream, which writes
 * the same Secrets under its own API group and label. The Secret is the one named by `.spec.bootstrap.initdb.secret.name`
 * when set, otherwise the `<name>-app` Secret the operator writes. From `<name>-app` every field but the host comes from
 * the Secret; from a Secret the user supplied, a `kubernetes.io/basic-auth` Secret, only the user and password do, and
 * the database is initdb's, `app` by default, on port 5432. The host is always the read-write Service by its fully
 * qualified name, because Studio runs in a namespace of its own and the Secret's `host` is the short name, which the
 * exporter never keeps.
 */
function cnpgFamily(slug: string, label: string, group: string, clusterLabel: string): KubernetesContractRow {
  return Object.freeze({
    slug,
    label,
    group,
    version: "v1",
    kind: "Cluster",
    plural: "clusters",
    type: "postgres",
    perUser: false,
    secretType: "kubernetes.io/basic-auth",
    secretKeys: Object.freeze(["username", "password", "dbname", "port"]),
    user(): undefined {
      return undefined;
    },
    serviceName(resource: CnpgResource): string {
      return `${resource.metadata.name}-rw`;
    },
    ssl(): RowSsl {
      return REQUIRE;
    },
    secretName(resource: CnpgResource): string {
      return present(resource.spec?.bootstrap?.initdb?.secret?.name) ?? `${resource.metadata.name}-app`;
    },
    notOwned(resource: CnpgResource, secretName: string): string {
      return present(resource.spec?.bootstrap?.initdb?.secret?.name) === undefined
        ? `the credential Secret ${secretName} is neither owned by the Cluster nor labelled ${clusterLabel}=${resource.metadata.name}, so the exporter did not export it`
        : `the credential Secret ${secretName} belongs to another resource or is not of type kubernetes.io/basic-auth, so the exporter did not export it`;
    },
    fields(resource: CnpgResource, secretName: string, data: SecretData, clusterDomain: string): Fields {
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
      const port = validPort(data.port);
      if (port === undefined) return { ok: false, reason: `the credential Secret ${secretName} has no valid port` };
      return { ok: true, fields: { host, port, database, user, password } };
    },
  });
}

/** A CloudNativePG `Cluster`, tied to its Secrets by the `cnpg.io/cluster` label or an ownerReference. */
export const CNPG_CLUSTER = cnpgFamily("cnpg", "CloudNativePG", "postgresql.cnpg.io", "cnpg.io/cluster");

/**
 * An EDB Postgres for Kubernetes `Cluster`, CloudNativePG's downstream with the same credential Secrets, tied by the
 * `k8s.enterprisedb.io/cluster` label or an ownerReference. Its row was checked against the contract and the golden
 * fixture, not against a live EDB cluster.
 */
export const EDB_CLUSTER = cnpgFamily(
  "edbpg",
  "EDB Postgres for Kubernetes",
  "postgresql.k8s.enterprisedb.io",
  "k8s.enterprisedb.io/cluster",
);

/** The contract table: one row per supported kind, in the exporter's order. */
export const KUBERNETES_CONTRACT: readonly KubernetesContractRow[] = Object.freeze([CNPG_CLUSTER, EDB_CLUSTER]);

/** SHA-256 over `key`, in hex: the id's digest. */
function sha256Hex(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * The key a discovered database's id is computed from: `<namespace>/<name>`, or `<namespace>/<name>/<user>` for a row
 * per database user. No part can hold a `/` (the export's schema refuses one), so two rows never share a key.
 */
export function kubernetesIdKey(namespace: string, name: string, user?: string): string {
  return user === undefined ? `${namespace}/${name}` : `${namespace}/${name}/${user}`;
}

/**
 * The id Studio lists a discovered database under: `k8s-<slug>-<first 32 hex characters of sha256(key)>`, which fits
 * the seed id rule whatever the names' length. The cluster is not part of it, because one Studio serves one cluster.
 * `digest` is a seam for the test that makes two keys share an id.
 */
export function kubernetesConnectionId(slug: string, key: string, digest: (key: string) => string = sha256Hex): string {
  return `k8s-${slug}-${digest(key).slice(0, 32)}`;
}

/**
 * `<key> (<label>)`, the key being `<namespace>/<name>` or `<namespace>/<name>/<user>`, with the start of the key cut to
 * an ellipsis when the whole would be over the seed schema's 128 characters, so a resource with long names is listed,
 * not skipped: the end names the resource and its user, and the connection's group shows the namespace whole.
 * Kubernetes names and user names are ASCII, so no character is split.
 */
function connectionName(path: string, label: string): string {
  const suffix = ` (${label})`;
  const room = NAME_MAX_CHARS - suffix.length;
  return path.length <= room ? `${path}${suffix}` : `…${path.slice(path.length - room + 1)}${suffix}`;
}

/** What a problem's reason is built from: names only, never a value of the Secret. */
interface ProblemContext {
  readonly row: KubernetesContractRow;
  readonly resource: KubernetesDiscoveredResource;
  readonly secret: string;
  readonly key: string | undefined;
}

/** The user a per-user problem names: the row's user, or the resource for a row per resource. */
function problemUser({ row, resource }: ProblemContext): string {
  return row.user(resource) ?? resource.metadata.name;
}

/** The reason Studio gives for each problem the exporter records; each names a Secret, a Service, a key or a user. */
const SECRET_PROBLEMS: Readonly<Record<KubernetesSecretProblem, (context: ProblemContext) => string>> = {
  not_found: ({ secret }) => `the credential Secret ${secret} does not exist`,
  forbidden: ({ secret }) => `the exporter may not read the credential Secret ${secret}`,
  not_owned: ({ row, resource, secret }) => row.notOwned(resource, secret),
  invalid_value: ({ secret, key = "value" }) =>
    `the credential Secret ${secret} holds a ${key} that is over 1024 bytes or not UTF-8 text`,
  reserved_name: ({ secret }) =>
    `the credential Secret ${secret} has a name reserved for an operator's key material or internal credentials, so the exporter did not request it`,
  wrong_type: ({ row, secret }) =>
    `the credential Secret ${secret} is not of type ${row.secretType}, so the exporter discarded it`,
  unexpected_key: ({ row, secret }) =>
    `the credential Secret ${secret} holds a key outside the ${row.label} contract, so the exporter discarded it whole`,
  missing_key: ({ secret, key = "key the contract requires" }) => `the credential Secret ${secret} has no ${key}`,
  no_database: (context) =>
    `the user ${problemUser(context)} lists no database, so its credential Secret has no dbname and the exporter did not request it`,
  other_namespace: (context) =>
    `the user ${problemUser(context)} keeps its connection string Secret in another namespace, which discovery does not read`,
  unsupported_name: (context) =>
    `the connection string Secret name of user ${problemUser(context)} needs the operator's name normalization, which discovery does not compute: set connectionStringSecretName on the user`,
  service_not_found: ({ row, resource }) =>
    `the Service ${row.serviceName(resource)} does not exist, so the exporter did not read the credential Secret`,
  service_forbidden: ({ row, resource }) =>
    `the exporter may not get the Service ${row.serviceName(resource)}: grant its ServiceAccount get on services in ${resource.metadata.namespace}`,
  service_external_name: ({ row, resource }) =>
    `the Service ${row.serviceName(resource)} is of type ExternalName, which can send the connection outside the namespace, so the exporter did not read the credential Secret`,
  service_not_controlled: ({ row, resource }) =>
    `the Service ${row.serviceName(resource)} has no selector and is not controlled by the ${row.kind} ${resource.metadata.name}, so the exporter did not read the credential Secret`,
  service_invalid_name: ({ row, resource }) =>
    `${row.serviceName(resource)} cannot be a Service name (a DNS-1035 label of at most 63 characters), so no such Service exists`,
};

export type KubernetesMappingResult =
  | { ok: true; key: string; connection: SeedConnection; secret: KubernetesSecretRef }
  | { ok: false; key: string; reason: string };

/**
 * The seed connection an exported database becomes, with its id key and the Secret its credentials came from, or why
 * it is skipped. `digest` is the id's seam (kubernetesConnectionId).
 */
export function mapKubernetesDatabase(
  entry: KubernetesDiscoveredDatabase,
  digest: (key: string) => string = sha256Hex,
): KubernetesMappingResult {
  // The export's schema admits only the kinds of this table, so a row always exists.
  const row = KUBERNETES_CONTRACT.find((candidate) => candidate.slug === entry.kind) as KubernetesContractRow;
  const { resource } = entry;
  const { namespace, name } = resource.metadata;
  const key = kubernetesIdKey(namespace, name, row.user(resource));
  const refuse = (reason: string): KubernetesMappingResult => ({ ok: false, key, reason });
  // A cluster domain that is not a DNS name refuses every database, so no host is ever built from it.
  const clusterDomain = kubernetesClusterDomain();
  if (!clusterDomain.ok) return refuse(clusterDomain.reason);
  const secretName = entry.secret.name;
  // The schema leaves the name out exactly when the exporter could not compute it.
  if (secretName === undefined) {
    return refuse(SECRET_PROBLEMS.unsupported_name({ row, resource, secret: "", key: undefined }));
  }
  // An exporter of another version could read another Secret than this row names; the review must ask about the one
  // whose values the connection carries, so such an entry is not listed.
  const expected = row.secretName(resource);
  if (secretName !== expected) {
    return refuse(`the export names the credential Secret ${secretName}, where the contract names ${expected}`);
  }
  if (entry.secret.data === undefined) {
    const problem = entry.secret.problem as KubernetesSecretProblem;
    return refuse(SECRET_PROBLEMS[problem]({ row, resource, secret: secretName, key: entry.secret.key }));
  }
  const fields = row.fields(resource, secretName, entry.secret.data, clusterDomain.domain);
  if (!fields.ok) return refuse(fields.reason);

  const result = SeedConnectionSchema.safeParse({
    id: kubernetesConnectionId(row.slug, key, digest),
    name: connectionName(key, row.label),
    type: row.type,
    ...fields.fields,
    group: namespace,
    ssl: { ...row.ssl(resource) },
    managed: true,
    roles: ["admin"],
  });
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")} (${issue.code})`).join(", ");
    return refuse(`the connection is not valid: ${issues}`);
  }
  return { ok: true, key, connection: result.data, secret: { namespace, name: secretName } };
}
