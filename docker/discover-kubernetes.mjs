/**
 * Kubernetes discovery exporter (docs/SEED_CONNECTIONS.md, "Platform discovery (Kubernetes)").
 *
 * It runs as a Deployment of its own, beside Studio, from the same image, with a ServiceAccount of its own. Every
 * interval it lists the supported database resources in the namespaces a cluster owner opted in, gets each one's
 * credential Secret by the name the contract gives it, keeps only the contract's keys, and writes one export document
 * into a Secret in Studio's namespace. The kubelet projects that Secret into Studio's pod as a read-only file, which
 * Studio's Kubernetes discovery source reads. Studio's web process never holds this exporter's token.
 *
 * Its token reads the credentials of every opted-in namespace, so this file is kept small and dull on purpose:
 *   - it asks for four things only: a paged `list` of each opted-in kind per namespace, a `get` of a Service by the name
 *     its row computes, a `get` of each credential Secret by name, and a `get` and an `update` of the export Secret; it
 *     never lists or watches Secrets or Services;
 *   - it requests no Secret whose name is reserved for an operator's key material or internal credentials, none that
 *     the spec of any listed resource of its namespace names for key material or another credential, and none whose
 *     row's Service is an ExternalName, or has no selector and is not controlled by the row's resource: RBAC cannot
 *     narrow `get secrets` by name, and resource editors choose part of every per-user name;
 *   - it keeps a Secret only when it is of its row's type, belongs to the resource that names it (an ownerReference, or
 *     for the CloudNativePG family its cluster label, or an initdb Secret tied to nothing), holds no key outside its
 *     row's measured set and every key its row requires, so a resource cannot point it at another workload's Secret;
 *   - one namespace's answers never decide another's: a refusal, a list page over the size bound, a list that does not
 *     end or resources that reserve more than LIMITS.reservedNames Secret names withdraws that namespace alone, and the
 *     database and export bounds are shared fairly among the namespaces, so the editors of one namespace cannot push
 *     another's databases out of the export;
 *   - it keeps only the contract's keys of a Secret, decoded, each at most LIMITS.valueBytes and valid UTF-8, and of a
 *     resource only the contract's fields; it interprets nothing else: the mapping to a connection, the id rule,
 *     staleness and validation live in src/lib/seed/, where the coverage gate measures them;
 *   - it never logs a value: no part of a 2xx answer's body reaches a log line or a status message;
 *   - it reads its token and its CA again for every request, and refuses a CA file that holds no certificate before
 *     any connection, so a projected token is used as soon as the kubelet rotates it and TLS never falls back to the
 *     public roots;
 *   - it writes with the export Secret's resourceVersion as a precondition, keeps the Secret's metadata, which Helm
 *     owns, and retries a conflict once.
 *
 * The contract rows below are the same data as src/lib/seed/kubernetes-discovery-contract.ts; a unit test holds the
 * two together. Like docker/discover.mjs it is hand-written ESM on Node core modules only, every API it uses exists
 * in Node 24, it sits outside src/ and outside the standalone payload, and every I/O dependency is a seam so
 * tests/unit/docker-discover-kubernetes.test.ts can drive it against a fake API server.
 */
import nodeFs, { realpathSync } from "node:fs";
import https from "node:https";
import { pathToFileURL } from "node:url";

/** A Kubernetes name: an RFC 1123 label (namespaces) or subdomain (object names). */
const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const MAX_SUBDOMAIN = 253;

function isLabel(value) {
  return typeof value === "string" && LABEL.test(value);
}

function isObjectName(value) {
  return typeof value === "string" && value.length <= MAX_SUBDOMAIN && SUBDOMAIN.test(value);
}

/** `value` when it is a non-empty string, else undefined. */
function text(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A Service name: an RFC 1035 label. */
const SERVICE_LABEL = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** A database user name of a per-user row, Studio's rule: no slash, so no two rows share an id key. */
const USER_NAME = /^[A-Za-z0-9_.@+-]{1,63}$/;
/** A MongoDB database name, of a user's own database or of one of its roles. */
const MONGO_DB_NAME = /^[A-Za-z0-9_-]{1,63}$/;
/** A Secret name MongoDB Community uses as it computes it, with nothing to normalize. */
const PLAIN_SECRET_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** The roles of a MongoDB user the exporter keeps, the first ones of the resource. */
const MONGO_ROLES_MAX = 64;
/** The database MongoDB Community authenticates a user against when the user names none. */
const MONGO_ADMIN_DATABASE = "admin";
/** The keys CloudNativePG writes into a `<name>-app` Secret, as measured; EDB writes the same. */
const CNPG_ALLOWED_KEYS = Object.freeze([
  "dbname",
  "fqdn-jdbc-uri",
  "fqdn-uri",
  "host",
  "jdbc-uri",
  "password",
  "pgpass",
  "port",
  "uri",
  "user",
  "username",
]);

/** The non-empty strings of `values`: the Secret names a resource's spec gives, whatever its other fields hold. */
function secretNames(values) {
  return values.filter((value) => text(value) !== undefined);
}

/** The namespace and name of a listed item, or null when either is missing or the name is not an object name. */
function namedMetadata(item) {
  const namespace = item?.metadata?.namespace;
  const name = item?.metadata?.name;
  if (typeof namespace !== "string" || !isObjectName(name)) return null;
  return { namespace, name };
}

/** Whether `secret` carries an ownerReference to the resource whose UID is `uid`. */
function ownedBy(secret, uid) {
  const references = Array.isArray(secret?.metadata?.ownerReferences) ? secret.metadata.ownerReferences : [];
  return uid !== undefined && references.some((reference) => reference?.uid === uid);
}

/**
 * A row of the CloudNativePG family: CloudNativePG itself, and EDB Postgres for Kubernetes, its downstream, which writes
 * the same Secrets under its own API group and cluster label. One candidate per Cluster: the Secret named by
 * `.spec.bootstrap.initdb.secret.name` when set, otherwise the `<name>-app` Secret the operator writes.
 */
function cnpgFamilyRow({ slug, group, clusterLabel }) {
  /** The initdb Secret the user supplied, or undefined for the operator's `<name>-app`. */
  const supplied = (resource) => text(resource?.spec?.bootstrap?.initdb?.secret?.name);
  const row = {
    slug,
    group,
    version: "v1",
    kind: "Cluster",
    plural: "clusters",
    secretType: "kubernetes.io/basic-auth",
    allowedKeys: CNPG_ALLOWED_KEYS,
    secretKeys: Object.freeze(["username", "password", "dbname", "port"]),
    /** The operator's `<name>-app` carries every kept key; a Secret the user supplied, the user and password only. */
    requiredKeys(candidate) {
      return supplied(candidate.resource) === undefined
        ? ["username", "password", "dbname", "port"]
        : ["username", "password"];
    },
    serviceName(resource) {
      return `${resource.metadata.name}-rw`;
    },
    /**
     * Whether `secret` belongs to the Cluster `resource` prunes, whose UID is `uid`, so a Cluster cannot point the
     * exporter at another workload's Secret of its namespace. A Secret tied to this Cluster, by an ownerReference to
     * its UID or the cluster label the operator writes, belongs to it. A Secret named by initdb that is tied to nothing
     * at all, no ownerReference and no cluster label, belongs to it too; its type, kubernetes.io/basic-auth as the
     * operator requires, is checked before. Any other Secret does not: another Cluster's `<name>-app` is owned by it.
     */
    owns(secret, resource, uid) {
      const references = Array.isArray(secret?.metadata?.ownerReferences) ? secret.metadata.ownerReferences : [];
      const label = secret?.metadata?.labels?.[clusterLabel];
      const labelledHere = typeof label === "string" && label === resource.metadata.name;
      if (ownedBy(secret, uid) || labelledHere) return true;
      if (supplied(resource) === undefined) return false;
      return references.length === 0 && label === undefined;
    },
    /**
     * The Cluster as one candidate, its resource pruned to the fields the contract reads, or left out when it has no
     * names, names an initdb database that is not 1 to 63 characters (PostgreSQL's identifier bound: Studio's schema
     * would refuse the whole export, and dropping it would connect to another database), or an initdb Secret that is
     * not an object name.
     */
    expand(item) {
      const metadata = namedMetadata(item);
      if (metadata === null) return { candidates: [], leftOut: 1 };
      const initdb = item.spec?.bootstrap?.initdb;
      const database = initdb?.database;
      if (database !== undefined && !(typeof database === "string" && database.length >= 1 && database.length <= 63)) {
        return { candidates: [], leftOut: 1 };
      }
      const kept = {
        ...(text(initdb?.database) === undefined ? {} : { database: initdb.database }),
        ...(text(initdb?.secret?.name) === undefined ? {} : { secret: { name: initdb.secret.name } }),
      };
      const resource = {
        metadata,
        ...(Object.keys(kept).length === 0 ? {} : { spec: { bootstrap: { initdb: kept } } }),
      };
      const secretName = supplied(resource) ?? `${metadata.name}-app`;
      if (!isObjectName(secretName)) return { candidates: [], leftOut: 1 };
      return { candidates: [{ row, resource, uid: text(item.metadata.uid), secretName }], leftOut: 0 };
    },
    /**
     * The Secrets the Cluster's spec names for its certificates, its superuser and each managed role's password, which
     * the operator reads and the exporter never exports: scanOnce reserves them for the whole namespace, so no other
     * resource can name one as its own credential Secret. The operator's own names end in a reserved suffix.
     */
    reserves(item) {
      const spec = item?.spec;
      const roles = Array.isArray(spec?.managed?.roles) ? spec.managed.roles : [];
      return secretNames([
        spec?.certificates?.serverCASecret,
        spec?.certificates?.serverTLSSecret,
        spec?.certificates?.replicationTLSSecret,
        spec?.certificates?.clientCASecret,
        spec?.superuserSecret?.name,
        ...roles.map((role) => role?.passwordSecret?.name),
      ]);
    },
  };
  return Object.freeze(row);
}

/** Whether `name` is a Crunchy PGO user name: Studio's user name rule, and an RFC 1123 label, PGO's own. */
function isPgoUser(name) {
  return typeof name === "string" && USER_NAME.test(name) && LABEL.test(name);
}

/**
 * Crunchy PGO `PostgresCluster` (`v1beta1`): one candidate per user of `spec.users`, or the default user PGO names after
 * the cluster when that list is absent or empty. Each user's Secret is `<name>-pguser-<user>`, of type Opaque and owned
 * by the cluster. A user that lists no database has a Secret without dbname, so it is marked no_database and its
 * Secret is never requested.
 */
const PGO_ROW = {
  slug: "pgo",
  group: "postgres-operator.crunchydata.com",
  version: "v1beta1",
  kind: "PostgresCluster",
  plural: "postgresclusters",
  secretType: "Opaque",
  allowedKeys: Object.freeze([
    "dbname",
    "host",
    "jdbc-uri",
    "password",
    "port",
    "uri",
    "user",
    "verifier",
    "pgbouncer-host",
    "pgbouncer-port",
    "pgbouncer-uri",
    "pgbouncer-jdbc-uri",
  ]),
  secretKeys: Object.freeze(["user", "password", "host", "port", "dbname"]),
  requiredKeys() {
    return ["user", "password", "host", "port", "dbname"];
  },
  serviceName(resource) {
    return `${resource.metadata.name}-primary`;
  },
  owns(secret, _resource, uid) {
    return ownedBy(secret, uid);
  },
  expand(item) {
    const metadata = namedMetadata(item);
    if (metadata === null) return { candidates: [], leftOut: 1 };
    const uid = text(item.metadata.uid);
    const users = item.spec?.users;
    if (users === undefined || users === null || (Array.isArray(users) && users.length === 0)) {
      const secretName = `${metadata.name}-pguser-${metadata.name}`;
      if (!isObjectName(secretName)) return { candidates: [], leftOut: 1 };
      return { candidates: [{ row: PGO_ROW, resource: { metadata }, uid, secretName }], leftOut: 0 };
    }
    if (!Array.isArray(users)) return { candidates: [], leftOut: 1 };
    const candidates = [];
    let leftOut = 0;
    for (const user of users) {
      const name = user?.name;
      const secretName = `${metadata.name}-pguser-${name}`;
      if (!isPgoUser(name) || !isObjectName(secretName)) {
        leftOut += 1;
        continue;
      }
      const databases = Array.isArray(user.databases) ? user.databases : [];
      candidates.push({
        row: PGO_ROW,
        resource: { metadata, spec: { users: [{ name }] } },
        uid,
        secretName,
        ...(databases.length === 0 ? { precheck: "no_database" } : {}),
      });
    }
    return { candidates, leftOut };
  },
  /** The Secrets the cluster's spec names for its own certificates, reserved for its whole namespace (scanOnce). */
  reserves(item) {
    return secretNames([item?.spec?.customTLSSecret?.name, item?.spec?.customReplicationTLSSecret?.name]);
  },
};
Object.freeze(PGO_ROW);

/** A MongoDB Community user as Studio reads it, or null when a name, database or role database is not one Studio accepts. */
function mongoUser(user) {
  const name = user?.name;
  const db = user?.db;
  const roles = user?.roles ?? [];
  const secretName = user?.connectionStringSecretName;
  if (typeof name !== "string" || !USER_NAME.test(name)) return null;
  if (db !== undefined && !(typeof db === "string" && MONGO_DB_NAME.test(db))) return null;
  if (!Array.isArray(roles)) return null;
  const kept = roles.slice(0, MONGO_ROLES_MAX);
  if (!kept.every((role) => typeof role?.db === "string" && MONGO_DB_NAME.test(role.db))) return null;
  if (secretName !== undefined && !isObjectName(secretName)) return null;
  return {
    name,
    ...(db === undefined ? {} : { db }),
    ...(secretName === undefined ? {} : { connectionStringSecretName: secretName }),
    roles: kept.map((role) => ({ db: role.db })),
  };
}

/**
 * MongoDB Community `MongoDBCommunity`: one candidate per user of `spec.users`, none without users. A user's Secret is
 * its connectionStringSecretName, else `<name>-<db>-<user>` when that needs no normalization by the operator, else the
 * user is marked unsupported_name; a Secret kept in another namespace is marked other_namespace. Neither is requested.
 */
const MONGO_ROW = {
  slug: "mongo",
  group: "mongodbcommunity.mongodb.com",
  version: "v1",
  kind: "MongoDBCommunity",
  plural: "mongodbcommunity",
  secretType: "Opaque",
  allowedKeys: Object.freeze(["connectionString.standard", "connectionString.standardSrv", "password", "username"]),
  secretKeys: Object.freeze(["connectionString.standard", "username", "password"]),
  requiredKeys() {
    return ["connectionString.standard", "username", "password"];
  },
  serviceName(resource) {
    return resource.spec?.statefulSet?.spec?.serviceName ?? `${resource.metadata.name}-svc`;
  },
  owns(secret, _resource, uid) {
    return ownedBy(secret, uid);
  },
  expand(item) {
    const metadata = namedMetadata(item);
    if (metadata === null) return { candidates: [], leftOut: 1 };
    const users = item.spec?.users;
    if (users === undefined || users === null) return { candidates: [], leftOut: 0 };
    if (!Array.isArray(users)) return { candidates: [], leftOut: 1 };
    const serviceName = item.spec.statefulSet?.spec?.serviceName;
    if (serviceName !== undefined && !(typeof serviceName === "string" && SERVICE_LABEL.test(serviceName))) {
      return { candidates: [], leftOut: users.length };
    }
    const tls = item.spec.security?.tls?.enabled;
    const shared = {
      ...(typeof tls === "boolean" ? { security: { tls: { enabled: tls } } } : {}),
      ...(serviceName === undefined ? {} : { statefulSet: { spec: { serviceName } } }),
    };
    const uid = text(item.metadata.uid);
    const candidates = [];
    let leftOut = 0;
    for (const raw of users) {
      const user = mongoUser(raw);
      if (user === null) {
        leftOut += 1;
        continue;
      }
      const resource = { metadata, spec: { users: [user], ...shared } };
      const computed = `${metadata.name}-${user.db ?? MONGO_ADMIN_DATABASE}-${user.name}`;
      const secretName = user.connectionStringSecretName ?? computed;
      if (user.connectionStringSecretName === undefined && !(computed.length <= MAX_SUBDOMAIN && PLAIN_SECRET_NAME.test(computed))) {
        candidates.push({ row: MONGO_ROW, resource, uid, precheck: "unsupported_name" });
        continue;
      }
      const otherNamespace =
        raw.connectionStringSecretNamespace !== undefined && raw.connectionStringSecretNamespace !== metadata.namespace;
      candidates.push({
        row: MONGO_ROW,
        resource,
        uid,
        secretName,
        ...(otherNamespace ? { precheck: "other_namespace" } : {}),
      });
    }
    return { candidates, leftOut };
  },
  /**
   * The Secrets the resource's spec names for its TLS certificate and key, its CA certificate and its agent's
   * certificate, reserved for its whole namespace (scanOnce); the agent's default, agent-certs, ends in a reserved suffix.
   */
  reserves(item) {
    const security = item?.spec?.security;
    return secretNames([
      security?.tls?.certificateKeySecretRef?.name,
      security?.tls?.caCertificateSecretRef?.name,
      security?.authentication?.agentCertificateSecretRef?.name,
    ]);
  },
};
Object.freeze(MONGO_ROW);

/**
 * The contract table, one row per supported kind, in Studio's order: the exporter's copy of KUBERNETES_CONTRACT in
 * src/lib/seed/kubernetes-discovery-contract.ts. Adding a row or a key widens what leaves the opted-in namespaces,
 * so it is a separate, reviewed change on both sides.
 */
export const CONTRACT = Object.freeze([
  cnpgFamilyRow({ slug: "cnpg", group: "postgresql.cnpg.io", clusterLabel: "cnpg.io/cluster" }),
  cnpgFamilyRow({ slug: "edbpg", group: "postgresql.k8s.enterprisedb.io", clusterLabel: "k8s.enterprisedb.io/cluster" }),
  PGO_ROW,
  MONGO_ROW,
]);

/**
 * The ends of the Secret names the first-release operators give their key material and internal credentials: CA,
 * server, replication, superuser and Pooler certificate Secrets (CloudNativePG, EDB), cluster, replication and instance
 * certificates, pgBackRest and PgBouncer Secrets, and the monitoring and the deprecated default user's credentials
 * (Crunchy PGO), keyfiles, agent passwords, automation configs, SCRAM credentials, certificates, and the agent's
 * certificate with its private key in PEM form (MongoDB). A credential Secret whose name ends in one is never
 * requested, whatever the resource says: RBAC cannot narrow `get secrets` by name, and resource editors choose part of
 * every per-user name.
 */
export const RESERVED_SECRET_SUFFIXES = Object.freeze([
  "-ca",
  "-server",
  "-replication",
  "-superuser",
  "-pooler",
  "-cluster-cert",
  "-replication-cert",
  "-certs",
  "-pgbackrest",
  "-pgbouncer",
  "-monitoring",
  "-pguser",
  "-keyfile",
  "-agent-password",
  "-config",
  "-scram-credentials",
  "-ca-certificate",
  "-server-certificate-key",
  "-prometheus-certificate-key",
  "-pem",
]);

/** Whole names that are never requested: Crunchy PGO's root certificate authority. */
export const RESERVED_SECRET_NAMES = Object.freeze(["pgo-root-cacert"]);

/**
 * Whether a credential Secret named `name` must not be requested: one its namespace's listed resources reserve
 * (`reserved`, a Set), a reserved name or one with a reserved suffix.
 */
export function isReservedSecretName(name, reserved) {
  return (
    reserved.has(name) ||
    RESERVED_SECRET_NAMES.includes(name) ||
    RESERVED_SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/**
 * Why the Service `service` cannot carry a connection to `row`'s resource whose UID is `uid`, or null when it can. An
 * ExternalName Service is a DNS alias anyone who may create Services can point outside the namespace, so it never can.
 * A Service with a selector routes to the namespace's own pods. A selector-less Service routes to whatever endpoints
 * were written for it, which the edit and admin roles cannot write themselves, so it can only when the resource
 * controls it, as Crunchy PGO controls its primary Service: an ownerReference with controller true and the resource's
 * UID, kind and group. Neither is a boundary (docs/SECURITY.md, the note to row 3.34): an editor may forge the
 * reference, or write endpoints with the ServiceAccount of a database pod they can exec into.
 */
export function serviceProblem(service, row, uid) {
  if (service?.spec?.type === "ExternalName") return "service_external_name";
  const selector = service?.spec?.selector;
  if (selector !== null && typeof selector === "object" && Object.keys(selector).length > 0) return null;
  const references = Array.isArray(service?.metadata?.ownerReferences) ? service.metadata.ownerReferences : [];
  const controlled = references.some(
    (reference) =>
      reference?.controller === true &&
      uid !== undefined &&
      reference.uid === uid &&
      reference.kind === row.kind &&
      typeof reference.apiVersion === "string" &&
      reference.apiVersion.split("/")[0] === row.group,
  );
  return controlled ? null : "service_not_controlled";
}

/** What every KUBERNETES_DISCOVERY_* variable means when it is unset or blank. */
export const DEFAULTS = Object.freeze({
  intervalMs: 30000,
  minIntervalMs: 5000,
  apiUrl: "https://kubernetes.default.svc",
  tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
  caPath: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  exportKey: "export.json",
  // Every other kind is opted in: a kind whose CRD the cluster does not serve withdraws every namespace (crd_missing).
  kinds: Object.freeze(["cnpg"]),
});

/** Every bound the exporter enforces; Studio enforces the export's again on its side. */
export const LIMITS = Object.freeze({
  namespaces: 256,
  databases: 500,
  valueBytes: 1024,
  // A Secret holds at most 1 MiB; this leaves room for the key.
  exportBytes: 983040,
  responseBytes: 16777216,
  // etcd keeps no object over 1.5 MiB by default, so a full page stays under responseBytes.
  pageSize: 10,
  pages: 100,
  // The distinct Secret names one namespace's listed resources may reserve; real clusters name a few dozen.
  reservedNames: 4096,
  requestTimeoutMs: 10000,
  messageChars: 512,
});

/**
 * The export format, Studio's KUBERNETES_DISCOVERY_EXPORT_VERSION, which a unit test holds equal. Studio reads this
 * version only, so an exporter and a Studio of different versions fail closed: no discovered connection is listed.
 */
export const EXPORT_VERSION = 2;

/** The longest delay setTimeout honours: a longer one, and Infinity, becomes 1 ms, a back-to-back rescan. */
const MAX_TIMER_DELAY_MS = 2147483647;
const LOG_PREFIX = "libredb-kubernetes-discovery:";
/** How a status says a bound was shared among the namespaces (fairShares). */
const FAIR_CUT = "each namespace kept a fair share and the rest was left out";
const CERTIFICATE_BLOCK = "-----BEGIN CERTIFICATE-----";
const EXPORT_SECRET_MESSAGE =
  "KUBERNETES_DISCOVERY_EXPORT_SECRET must name the export Secret as <namespace>/<name>, such as libredb-studio/libredb-studio-discovery-export";
const API_URL_MESSAGE =
  "KUBERNETES_DISCOVERY_API_URL must be an https URL without a user name, password, query or fragment, such as https://kubernetes.default.svc";
/** The error codes this file gives its own failures; any other code is the network's or TLS's. */
const OWN_CODES = new Set(["ETOKEN", "ECA", "ERESPONSETOOLARGE", "EBADJSON", "EBADLIST", "ETIMEDOUT", "EABORTED"]);

/** Trim a possibly-undefined env value down to a usable string, or "". */
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Render an unknown throwable as a short, log-safe single-line string. */
function describeError(error) {
  if (!error) return "unknown error";
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" && error.message ? error.message : String(error);
  if (code && !OWN_CODES.has(code) && !message.includes(code)) return `${code} (${message})`;
  return message;
}

/** At most LIMITS.messageChars UTF-16 units, the unit Studio's schema counts, never ending on half a pair. */
function clip(message) {
  if (message.length <= LIMITS.messageChars) return message;
  const cut = message.slice(0, LIMITS.messageChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** An Error carrying a Node-style `code`, which classifyApiError reads. */
function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** Comma-separated items; blanks and empty items are ignored, repeats kept once, sorted. */
function listSetting(raw) {
  return [...new Set(trimmed(raw).split(",").map((item) => item.trim()).filter((item) => item !== ""))].sort();
}

/** A non-negative integer from the environment, or `fallback` when unset or blank. */
function integerSetting(env, name, fallback, minimum, maximum) {
  const raw = trimmed(env[name]);
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}, got "${raw}"`);
  }
  if (Number(raw) > maximum) throw new Error(`${name} must be an integer of at most ${maximum}, got "${raw}"`);
  return Number(raw);
}

/** `path` without its trailing slashes, in one pass. */
function withoutTrailingSlashes(path) {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

function apiUrlSetting(raw) {
  const value = trimmed(raw) || DEFAULTS.apiUrl;
  const url = URL.parse(value);
  const valid =
    url !== null &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    !value.includes("?") &&
    !value.includes("#");
  if (!valid) throw new Error(API_URL_MESSAGE);
  return `${url.protocol}//${url.host}${withoutTrailingSlashes(url.pathname)}`;
}

/**
 * The exporter's configuration. Throws on a value it cannot honour rather than guessing: a typo in a namespace must
 * stop the exporter with a reason in its log, not export another set.
 */
export function readConfig(env) {
  const source = env ?? {};
  const namespaces = listSetting(source.KUBERNETES_DISCOVERY_NAMESPACES);
  if (namespaces.length === 0) throw new Error("KUBERNETES_DISCOVERY_NAMESPACES must name at least one namespace");
  const odd = namespaces.find((namespace) => !isLabel(namespace));
  if (odd !== undefined) {
    throw new Error(
      `KUBERNETES_DISCOVERY_NAMESPACES names "${odd}", which is not a namespace name: lowercase letters, digits and inner hyphens, at most 63`,
    );
  }
  if (namespaces.length > LIMITS.namespaces) {
    throw new Error(`KUBERNETES_DISCOVERY_NAMESPACES names more than ${LIMITS.namespaces} namespaces`);
  }

  const parts = trimmed(source.KUBERNETES_DISCOVERY_EXPORT_SECRET).split("/");
  if (parts.length !== 2 || !isLabel(parts[0]) || !isObjectName(parts[1])) throw new Error(EXPORT_SECRET_MESSAGE);

  const known = CONTRACT.map((row) => row.slug).join(", ");
  let kinds = CONTRACT.filter((row) => DEFAULTS.kinds.includes(row.slug));
  if (trimmed(source.KUBERNETES_DISCOVERY_KINDS) !== "") {
    const slugs = listSetting(source.KUBERNETES_DISCOVERY_KINDS);
    if (slugs.length === 0) throw new Error(`KUBERNETES_DISCOVERY_KINDS must name at least one kind: ${known}`);
    const unknown = slugs.find((slug) => !CONTRACT.some((row) => row.slug === slug));
    if (unknown !== undefined) {
      throw new Error(`KUBERNETES_DISCOVERY_KINDS names "${unknown}", which is not a supported kind: ${known}`);
    }
    kinds = CONTRACT.filter((row) => slugs.includes(row.slug));
  }

  return {
    namespaces,
    exportSecret: { namespace: parts[0], name: parts[1] },
    kinds,
    intervalMs: integerSetting(
      source,
      "KUBERNETES_DISCOVERY_INTERVAL_MS",
      DEFAULTS.intervalMs,
      DEFAULTS.minIntervalMs,
      MAX_TIMER_DELAY_MS,
    ),
    apiUrl: apiUrlSetting(source.KUBERNETES_DISCOVERY_API_URL),
    tokenPath: trimmed(source.KUBERNETES_DISCOVERY_TOKEN_PATH) || DEFAULTS.tokenPath,
    caPath: trimmed(source.KUBERNETES_DISCOVERY_CA_PATH) || DEFAULTS.caPath,
    once: trimmed(source.KUBERNETES_DISCOVERY_ONCE) === "1",
  };
}

/** The API server's own Status message for a refusal, or "" when the body carries none. */
function statusMessage(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON: the request line and the status say what is known, without echoing an unknown body.
  }
  return "";
}

function readFileText(path) {
  return nodeFs.promises.readFile(path, "utf8");
}

/**
 * A client of the Kubernetes API over node:https, with the token and the CA read again for every request.
 * `agent: false` gives each request its own connection that closes with it, so nothing keeps the process alive after
 * the last scan. Each request is bounded in time (the whole request) and in body size, and a redirect is never
 * followed. A non-2xx answer rejects with `statusCode` and the API server's Status message; any other failure rejects
 * with a `code`. `abort()` ends every request in flight, so a signal never waits on the API server.
 */
export function createApiClient({ apiUrl, tokenPath, caPath, request, readFile, timeoutMs, maxBytes } = {}) {
  const send = request ?? https.request;
  const read = readFile ?? readFileText;
  const budgetMs = timeoutMs ?? LIMITS.requestTimeoutMs;
  const cap = maxBytes ?? LIMITS.responseBytes;
  const base = new URL(apiUrl);
  const prefix = base.pathname === "/" ? "" : base.pathname;
  const inFlight = new Set();

  async function credentials() {
    let token;
    try {
      token = (await read(tokenPath)).trim();
    } catch {
      throw codedError(`the token file ${tokenPath} cannot be read`, "ETOKEN");
    }
    if (token === "") throw codedError(`the token file ${tokenPath} is empty`, "ETOKEN");
    let ca;
    try {
      ca = await read(caPath);
    } catch {
      throw codedError(`the CA file ${caPath} cannot be read`, "ECA");
    }
    // A `ca` without a certificate must never reach node:https: depending on the runtime an empty one is ignored,
    // and the public roots would then vouch for the API server.
    if (!ca.includes(CERTIFICATE_BLOCK)) throw codedError(`the CA file ${caPath} holds no certificate`, "ECA");
    return { token, ca };
  }

  function exchange(method, path, payload, { token, ca }) {
    const line = `${method} ${path.split("?")[0]}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let outgoing = null;
      const timer = setTimeout(
        () => fail(codedError(`the API server did not answer ${line} within ${budgetMs} ms`, "ETIMEDOUT")),
        budgetMs,
      );
      const entry = { abort: () => fail(codedError(`${line} aborted`, "EABORTED")) };
      inFlight.add(entry);
      function settle() {
        settled = true;
        clearTimeout(timer);
        inFlight.delete(entry);
      }
      function fail(error) {
        if (settled) return;
        settle();
        outgoing?.destroy();
        reject(error);
      }
      function finish(response, chunks) {
        if (settled) return;
        settle();
        const body = Buffer.concat(chunks).toString("utf8");
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          const said = statusMessage(body);
          const message = `${line} answered HTTP ${statusCode}${said ? `: ${said}` : ""}`;
          reject(Object.assign(new Error(message), { statusCode }));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(codedError(`${line} answered with a body that is not JSON`, "EBADJSON"));
        }
      }
      const headers = { accept: "application/json", authorization: `Bearer ${token}` };
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(payload);
      }
      try {
        outgoing = send(
          {
            method,
            hostname: base.hostname.replace(/^\[|\]$/g, ""),
            port: base.port === "" ? 443 : Number(base.port),
            path: `${prefix}${path}`,
            headers,
            ca,
            agent: false,
          },
          (response) => {
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
              size += chunk.length;
              if (size > cap) {
                fail(codedError(`${line} answered with more than ${cap} bytes`, "ERESPONSETOOLARGE"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => finish(response, chunks));
            response.on("error", fail);
          },
        );
      } catch (error) {
        fail(error);
        return;
      }
      outgoing.on("error", fail);
      outgoing.end(payload);
    });
  }

  async function call(method, path, body) {
    const secrets = await credentials();
    return exchange(method, path, body === undefined ? undefined : JSON.stringify(body), secrets);
  }

  return {
    get: (path) => call("GET", path),
    put: (path, body) => call("PUT", path, body),
    abort() {
      for (const entry of [...inFlight]) entry.abort();
    },
  };
}

/** The export's status for a failed request: who failed, from what this file can tell. */
export function classifyApiError(error) {
  const message = clip(describeError(error));
  const statusCode = error?.statusCode;
  if (Number.isInteger(statusCode)) {
    return { ok: false, code: statusCode === 401 ? "unauthorized" : "api_error", httpStatus: statusCode, message };
  }
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "ETOKEN" || code === "ECA") return { ok: false, code: "credentials_unavailable", message };
  if (code === "ERESPONSETOOLARGE") return { ok: false, code: "limit_exceeded", message };
  if (code === "EBADJSON" || code === "EBADLIST") return { ok: false, code: "api_error", message };
  return { ok: false, code: "api_unreachable", message };
}

/**
 * The Secret's kept keys, decoded, or why none is kept: a key outside the row's measured set (never named, because
 * whoever edits the Secret chooses the name), the first required key that is absent or empty, or the first kept key
 * whose value is over the bound or not UTF-8 text.
 */
function keepSecretData(row, candidate, secret) {
  const data = secret?.data && typeof secret.data === "object" ? secret.data : {};
  if (Object.keys(data).some((key) => !row.allowedKeys.includes(key))) return { problem: "unexpected_key" };
  for (const key of row.requiredKeys(candidate)) {
    const encoded = data[key];
    if (typeof encoded !== "string" || Buffer.from(encoded, "base64").length === 0) {
      return { problem: "missing_key", key };
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const kept = {};
  for (const key of row.secretKeys) {
    const encoded = data[key];
    if (typeof encoded !== "string") continue;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > LIMITS.valueBytes) return { problem: "invalid_value", key };
    try {
      kept[key] = decoder.decode(bytes);
    } catch {
      return { problem: "invalid_value", key };
    }
  }
  return { data: kept };
}

/**
 * The credential Secret of a candidate whose Service passed: its kept keys, or the problem that stopped the exporter
 * keeping them. A Secret of another type than its row's, not tied to the resource, or with a key outside the row's
 * measured set is kept whole out of the export.
 */
async function readCredentialSecret(client, candidate) {
  const { row, resource, uid, secretName } = candidate;
  let secret;
  try {
    secret = await client.get(`/api/v1/namespaces/${resource.metadata.namespace}/secrets/${secretName}`);
  } catch (error) {
    if (error?.statusCode === 404) return { name: secretName, problem: "not_found" };
    if (error?.statusCode === 403) return { name: secretName, problem: "forbidden" };
    throw error;
  }
  if (secret?.type !== row.secretType) return { name: secretName, problem: "wrong_type" };
  if (!row.owns(secret, resource, uid)) return { name: secretName, problem: "not_owned" };
  return { name: secretName, ...keepSecretData(row, candidate, secret) };
}

/**
 * The Service check of a candidate: null when its row's Service may carry the connection, else the problem. Each
 * Service is got once per scan (`services`, keyed `<namespace>/<name>`, holds the Service or the refusal), so the
 * users of one resource cost one request. A 403 or a 404 answers for this row alone; any other failure throws and
 * fails the scan.
 */
async function checkService(client, { row, resource, uid }, services) {
  const name = row.serviceName(resource);
  if (!SERVICE_LABEL.test(name)) return "service_invalid_name";
  const key = `${resource.metadata.namespace}/${name}`;
  if (!services.has(key)) {
    try {
      const service = await client.get(`/api/v1/namespaces/${resource.metadata.namespace}/services/${name}`);
      services.set(key, { service });
    } catch (error) {
      if (error?.statusCode === 404) services.set(key, { problem: "service_not_found" });
      else if (error?.statusCode === 403) services.set(key, { problem: "service_forbidden" });
      else throw error;
    }
  }
  const answer = services.get(key);
  return answer.problem ?? serviceProblem(answer.service, row, uid);
}

/**
 * A candidate's Secret entry: the problem decided before any request, or a reserved name (`reserved` holds what its
 * namespace's listed resources reserve), or the Service check's refusal, each without requesting the Secret;
 * otherwise what reading the Secret gives.
 */
async function readCandidate(client, candidate, services, reserved) {
  const { secretName, precheck } = candidate;
  if (precheck !== undefined) return { ...(secretName === undefined ? {} : { name: secretName }), problem: precheck };
  if (isReservedSecretName(secretName, reserved)) return { name: secretName, problem: "reserved_name" };
  const problem = await checkService(client, candidate, services);
  if (problem !== null) return { name: secretName, problem };
  return readCredentialSecret(client, candidate);
}

/**
 * How many of each group's items to keep under `budget`, shared max-min fairly: `sizes[g]` lists the sizes of group
 * g's items in order, and each group keeps the longest prefix of them its share holds. The groups are served from the
 * smallest total up, each with an equal part of what is left, so a group that needs less than its part leaves the rest
 * to the larger ones, and every group's share is an equal part of the budget at least, or all it needs. The exporter
 * shares its database and export bounds among the namespaces this way, so one namespace's editors cannot push another
 * namespace's databases out of the export by creating resources.
 */
export function fairShares(sizes, budget) {
  const totals = sizes.map((items) => items.reduce((sum, size) => sum + size, 0));
  const order = totals.map((_, index) => index).sort((a, b) => totals[a] - totals[b] || a - b);
  const kept = sizes.map(() => 0);
  let left = budget;
  for (const [served, group] of order.entries()) {
    const share = Math.floor(left / (order.length - served));
    let used = 0;
    for (const size of sizes[group]) {
      if (used + size > share) break;
      used += size;
      kept[group] += 1;
    }
    left -= used;
  }
  return kept;
}

/** The status of a failed list that answers for its namespace alone, or null for a failure that fails the scan. */
function namespaceRefusal(error, row, namespace) {
  const what = `${row.plural}.${row.group}`;
  if (error?.statusCode === 403) {
    return {
      ok: false,
      code: "forbidden",
      httpStatus: 403,
      message: `the exporter may not list ${what} in ${namespace} (HTTP 403): grant its ServiceAccount list on them there`,
    };
  }
  if (error?.statusCode === 404) {
    return {
      ok: false,
      code: "crd_missing",
      httpStatus: 404,
      message: `the API server does not serve ${what} (HTTP 404): install the operator, or leave ${row.slug} out of KUBERNETES_DISCOVERY_KINDS`,
    };
  }
  if (error?.code === "ERESPONSETOOLARGE") {
    return { ok: false, code: "limit_exceeded", message: `${what} in ${namespace} are too large to list: ${error.message}` };
  }
  return null;
}

/**
 * One namespace's resources of every kind, in list order: at most `limits.databases` of them, whether it holds more,
 * and of the Secret names its listed resources' specs reserve for the namespace, those a kept row's Secret has
 * (`reserved`). It lists every page past the bound too, since a resource past it still reserves its Secrets, and one
 * left out for its names as well. A 403, a 404, a page over the response bound, a list that does not end within
 * `limits.pages` and resources that reserve more than `limits.reservedNames` distinct names answer for this namespace
 * alone, whose editors decide how many and how large its resources are: the namespace gets that status and none of its
 * resources, those of earlier pages included. Any other failure throws and fails the scan.
 */
export async function listNamespace({ client, config, namespace, limits }) {
  const found = [];
  const reserved = new Set();
  let more = false;
  let leftOut = 0;
  for (const row of config.kinds) {
    const path = `/apis/${row.group}/${row.version}/namespaces/${namespace}/${row.plural}`;
    let continueToken = "";
    for (let page = 0; ; page += 1) {
      if (page >= limits.pages) {
        const message = `${row.plural}.${row.group} in ${namespace} are too many to list: GET ${path} did not end within ${limits.pages} pages`;
        return { status: { ok: false, code: "limit_exceeded", message } };
      }
      const query = `?limit=${limits.pageSize}${continueToken === "" ? "" : `&continue=${encodeURIComponent(continueToken)}`}`;
      let list;
      try {
        // oxlint-disable-next-line no-await-in-loop -- pages come one after another by their continue token.
        list = await client.get(`${path}${query}`);
      } catch (error) {
        const status = namespaceRefusal(error, row, namespace);
        if (status === null) throw error;
        return { status };
      }
      if (!Array.isArray(list?.items)) {
        throw codedError(`GET ${path} answered with something other than a list`, "EBADLIST");
      }
      for (const item of list.items) {
        for (const name of row.reserves(item)) {
          if (reserved.has(name)) continue;
          if (reserved.size === limits.reservedNames) {
            const message = `the resources listed in ${namespace} name more than ${limits.reservedNames} distinct Secrets in the spec fields the exporter reserves, the most it keeps for one namespace`;
            return { status: { ok: false, code: "limit_exceeded", message } };
          }
          reserved.add(name);
        }
        const expanded = row.expand(item);
        leftOut += expanded.leftOut;
        for (const candidate of expanded.candidates) {
          if (candidate.resource.metadata.namespace !== namespace) {
            leftOut += 1;
            continue;
          }
          if (found.length === limits.databases) more = true;
          else found.push(candidate);
        }
      }
      continueToken = typeof list.metadata?.continue === "string" ? list.metadata.continue : "";
      if (continueToken === "") break;
    }
  }
  // Only a kept row's Secret is checked against the names, so the rest go: what a namespace holds until its Secrets are
  // read is bounded by its kept rows, not by how many names its editors write.
  const hits = new Set();
  for (const candidate of found) if (reserved.has(candidate.secretName)) hits.add(candidate.secretName);
  return { status: { ok: true }, found, more, leftOut, reserved: hits };
}

/**
 * One listing of every namespace and kind. Never throws; a failure comes back as a status. An answer about one
 * namespace withdraws its databases and leaves the others (listNamespace); any other failure fails the whole scan,
 * and the caller keeps its last good one. A resource without Kubernetes names is left out and counted, and no request
 * is built from one. Every namespace is listed in full before any Secret is requested, so a name any of its resources
 * reserves is refused for all of its rows, whichever is listed first. Past `limits.databases` the namespaces share the
 * bound fairly (fairShares), only the databases within a share have their Secret read, and `truncated` is set.
 */
export async function scanOnce({ client, config, limits = LIMITS }) {
  const namespaces = [];
  const listings = [];
  let leftOut = 0;
  try {
    for (const namespace of config.namespaces) {
      // oxlint-disable-next-line no-await-in-loop -- one namespace at a time keeps the API server's load flat.
      const listing = await listNamespace({ client, config, namespace, limits });
      namespaces.push({ name: namespace, status: listing.status });
      if (!listing.status.ok) continue;
      leftOut += listing.leftOut;
      listings.push(listing);
    }
    // A namespace that holds more than it kept counts one more, so its share is always short of what it holds.
    const held = listings.map((listing) => listing.found.length + (listing.more ? 1 : 0));
    const shares = fairShares(
      held.map((count) => new Array(count).fill(1)),
      limits.databases,
    );
    const databases = [];
    const services = new Map();
    for (const [index, listing] of listings.entries()) {
      for (const candidate of listing.found.slice(0, shares[index])) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps the API server's load flat.
        const secret = await readCandidate(client, candidate, services, listing.reserved);
        databases.push({ kind: candidate.row.slug, resource: candidate.resource, secret });
      }
    }
    const truncated = held.some((count, index) => shares[index] < count);
    return { ok: true, namespaces, databases, truncated, leftOut };
  } catch (error) {
    return { ok: false, status: classifyApiError(error) };
  }
}

/** The status object as the export carries it. */
function normalizeStatus(status) {
  if (status.ok) return { ok: true };
  return {
    ok: false,
    code: status.code,
    ...(status.httpStatus === undefined ? {} : { httpStatus: status.httpStatus }),
    message: clip(String(status.message)),
  };
}

/**
 * The export's content, at EXPORT_VERSION. `now` is the epoch milliseconds of this attempt; `generatedAt` is the ISO
 * time of the last successful scan, or null before the first, in which case no namespace and no database is exported.
 */
export function buildExport({ now, status, generatedAt, namespaces, databases }) {
  return {
    version: EXPORT_VERSION,
    platform: "kubernetes",
    generatedAt,
    checkedAt: new Date(now).toISOString(),
    status: normalizeStatus(status),
    namespaces: generatedAt === null ? [] : namespaces,
    databases: generatedAt === null ? [] : databases,
  };
}

/**
 * The export's text, at most `limits.exportBytes` bytes. Over the bound, the namespaces share it fairly (fairShares),
 * each keeping its databases in order while they fit its share, and an ok status becomes limit_exceeded; a status
 * that is already an error keeps its code.
 */
export function serializeExport(data, limits = LIMITS) {
  const whole = JSON.stringify(data);
  if (Buffer.byteLength(whole, "utf8") <= limits.exportBytes) return whole;
  const status = data.status.ok
    ? {
        ok: false,
        code: "limit_exceeded",
        message: `the export would exceed ${limits.exportBytes} bytes; ${FAIR_CUT}`,
      }
    : data.status;
  const budget = limits.exportBytes - Buffer.byteLength(JSON.stringify({ ...data, status, databases: [] }), "utf8");
  const groups = [...Map.groupBy(data.databases, (database) => database.resource.metadata.namespace).values()];
  // Each database costs its own bytes and at most one comma.
  const sizes = groups.map((group) => group.map((database) => Buffer.byteLength(JSON.stringify(database), "utf8") + 1));
  const shares = fairShares(sizes, budget);
  return JSON.stringify({ ...data, status, databases: groups.flatMap((group, index) => group.slice(0, shares[index])) });
}

/**
 * Writes `text` into the export Secret: a get, then an update of that same object with only its data replaced, so
 * the metadata Helm owns stays as it is and its resourceVersion is the precondition. A conflict, another writer in
 * between, re-reads and retries once; any other failure, and a second conflict, rejects. The Secret is never created
 * here: whoever installs the exporter creates it empty, and a Role limited to its name cannot create.
 */
export async function writeExport({ client, config, text }) {
  const path = `/api/v1/namespaces/${config.exportSecret.namespace}/secrets/${config.exportSecret.name}`;
  const encoded = Buffer.from(text, "utf8").toString("base64");
  for (let attempt = 0; ; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- the retry re-reads the Secret the conflict changed.
    const secret = await client.get(path);
    // managedFields is the API server's own bookkeeping: an update that omits it keeps it as it is.
    const metadata = { ...secret.metadata };
    delete metadata.managedFields;
    try {
      // oxlint-disable-next-line no-await-in-loop -- the update needs the object it just read.
      await client.put(path, { ...secret, metadata, data: { [DEFAULTS.exportKey]: encoded } });
      return;
    } catch (error) {
      if (error?.statusCode !== 409 || attempt > 0) throw error;
    }
  }
}

/** The one-line summary of a scan: counts only for a good one, its status code and message for a failed one. */
function summarize(result, limits) {
  if (!result.ok) return `scan failed: ${result.status.code}: ${result.status.message}`;
  const unreadable = result.namespaces.filter((namespace) => !namespace.status.ok).length;
  const counts = `scan ok: ${result.databases.length} databases in ${result.namespaces.length} namespaces exported`;
  if (unreadable === 0 && result.leftOut === 0 && !result.truncated) return counts;
  const cut = result.truncated ? `, cut to fair shares of ${limits.databases}` : "";
  return `${counts}, ${unreadable} namespaces could not be read, ${result.leftOut} resources left out${cut}`;
}

/**
 * The scan-and-write step. A failed scan keeps the last good namespaces, databases and generatedAt, and updates the
 * status and checkedAt. A summary is logged when it changes; a write that fails is logged every time.
 */
export function createExporter({ config, client, now, info, warn, limits = LIMITS }) {
  const last = { generatedAt: null, namespaces: [], databases: [], summary: "" };
  let stopping = false;

  async function scanAndWrite() {
    const result = await scanOnce({ client, config, limits });
    if (stopping) return false;
    const checkedAt = now();
    let status = result.status;
    if (result.ok) {
      last.generatedAt = new Date(checkedAt).toISOString();
      last.namespaces = result.namespaces;
      last.databases = result.databases;
      status = result.truncated
        ? {
            ok: false,
            code: "limit_exceeded",
            message: `more than ${limits.databases} databases in the discovered namespaces; ${FAIR_CUT}`,
          }
        : { ok: true };
    }
    const data = buildExport({
      now: checkedAt,
      status,
      generatedAt: last.generatedAt,
      namespaces: last.namespaces,
      databases: last.databases,
    });
    try {
      await writeExport({ client, config, text: serializeExport(data, limits) });
    } catch (error) {
      if (stopping) return false;
      const failure = classifyApiError(error);
      warn(`write failed: ${failure.code}: ${failure.message}`);
      return false;
    }
    const summary = summarize(result, limits);
    if (summary !== last.summary) {
      last.summary = summary;
      if (result.ok) info(summary);
      else warn(summary);
    }
    return true;
  }

  return {
    scanAndWrite,
    stop() {
      stopping = true;
      client.abort();
    },
  };
}

/**
 * Entry point. Reads the configuration, then scans and writes every KUBERNETES_DISCOVERY_INTERVAL_MS until SIGTERM or
 * SIGINT. It runs as PID 1 in its container, where the kernel ignores a signal that has no handler, so without these
 * handlers a rollout would wait for the kubelet's SIGKILL. A request in flight is aborted and its scan writes nothing.
 * With KUBERNETES_DISCOVERY_ONCE=1 it scans once and resolves 0 when the export was written, 1 when not. Exit code 2
 * is a configuration it cannot honour.
 */
export async function main({ env, request, readFile, now, stdout, stderr, signals } = {}) {
  const environment = env ?? process.env;
  const clock = now ?? Date.now;
  const out = stdout ?? ((chunk) => process.stdout.write(chunk));
  const err = stderr ?? ((chunk) => process.stderr.write(chunk));
  const events = signals ?? process;
  const info = (line) => out(`${LOG_PREFIX} ${line}\n`);
  const warn = (line) => err(`${LOG_PREFIX} ${line}\n`);

  let config;
  try {
    config = readConfig(environment);
  } catch (error) {
    warn(`invalid configuration: ${describeError(error)}`);
    return 2;
  }

  const client = createApiClient({
    apiUrl: config.apiUrl,
    tokenPath: config.tokenPath,
    caPath: config.caPath,
    request,
    readFile,
  });
  const exporter = createExporter({ config, client, now: clock, info, warn });
  const { namespace, name } = config.exportSecret;
  info(
    `watching ${config.namespaces.length} namespaces (${config.namespaces.join(", ")}) for ${config.kinds.map((row) => row.slug).join(", ")} every ${config.intervalMs} ms, writing ${namespace}/${name}`,
  );
  if (config.once) return (await exporter.scanAndWrite()) ? 0 : 1;

  return new Promise((resolve) => {
    let timer = null;
    let stopped = false;
    function stop(signal) {
      stopped = true;
      clearTimeout(timer);
      events.removeListener("SIGTERM", onTerm);
      events.removeListener("SIGINT", onInt);
      exporter.stop();
      info(`received ${signal}, exiting`);
      resolve(0);
    }
    function onTerm() {
      stop("SIGTERM");
    }
    function onInt() {
      stop("SIGINT");
    }
    async function loop() {
      await exporter.scanAndWrite();
      if (!stopped) timer = setTimeout(loop, config.intervalMs);
    }
    events.once("SIGTERM", onTerm);
    events.once("SIGINT", onInt);
    loop();
  });
}

/**
 * Whether this module is the program being run, rather than an import. Copied from docker/bind-address.mjs, not
 * imported, so each file in /usr/local/lib/libredb-studio stands alone; the reasons for realpath and pathToFileURL are
 * in that file's docblock.
 */
export function isDirectExecution(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === moduleUrl;
  } catch {
    // An unreadable or vanished argv[1] is not this module, and must not throw.
    return false;
  }
}

// Run only when executed directly, so importing this file in a test is inert.
if (isDirectExecution(process.argv[1], import.meta.url)) {
  process.exitCode = await main({});
}
