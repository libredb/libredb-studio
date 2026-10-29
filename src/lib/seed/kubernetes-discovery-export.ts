/**
 * The Kubernetes discovery export: the document docker/discover-kubernetes.mjs writes into its export Secret, under
 * the key `export.json`, and the parser Studio reads the projected file with (docs/SEED_CONNECTIONS.md, "Platform
 * discovery (Kubernetes)").
 *
 * The file is untrusted input. It is checked for size before it is parsed, refused whole when it does not match the
 * schema, and a refusal names a field path and an issue code, never the file's text: the Secret values are database
 * passwords. The schema keeps only the declared keys (zod strips the rest), so nothing in the file can set a
 * connection's roles, managed flag, MCP opt-in or TLS mode; those are forced in code
 * (kubernetes-discovery-contract.ts).
 *
 * Each database entry carries the contract's fields of its resource, pruned by the exporter, and either its row's kept
 * keys of its credential Secret or the reason none could be kept. Each kind has a schema of its own, so a row keeps only
 * its own keys. The names are checked as Kubernetes names here, because the connection's host is built from them, and
 * the user names as the operators allow them, because they enter the connection's id key. Version 2 is the only one
 * read: a version 1 export was written by an exporter that checked no Service and no Secret type, owner or key set.
 */
import { z } from "zod";

/** Studio's cap on the file: the Secret it is projected from holds at most 1 MiB. */
export const KUBERNETES_DISCOVERY_FILE_MAX_BYTES = 1024 * 1024;

/** The export format this Studio reads, and the only one: the exporter writes the same number. */
export const KUBERNETES_DISCOVERY_EXPORT_VERSION = 2;

/** The keys of a credential Secret some contract row keeps, the only ones an export may carry or name. */
export const KUBERNETES_DISCOVERY_SECRET_KEYS = [
  "username",
  "password",
  "dbname",
  "port",
  "user",
  "host",
  "connectionString.standard",
] as const;

/** Why the exporter kept no value of a row's credential Secret; each is explained in kubernetes-discovery-contract.ts. */
export const KUBERNETES_DISCOVERY_PROBLEMS = [
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
] as const;

export type KubernetesSecretProblem = (typeof KUBERNETES_DISCOVERY_PROBLEMS)[number];

const ISO_TIME = z.iso.datetime();
const MESSAGE = z.string().max(512);
/** A namespace name: an RFC 1123 label. */
const NAMESPACE_NAME = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/);
/** An object name: an RFC 1123 subdomain of at most 253 characters. */
const OBJECT_NAME = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/);
/** A value the exporter kept: at most 1024 bytes, so at most 1024 UTF-16 units. */
const SECRET_VALUE = z.string().max(1024);
/** A database user name of a per-user row: no slash, so no two (namespace, name, user) triples share an id key. */
const USER_NAME = z.string().regex(/^[A-Za-z0-9_.@+-]{1,63}$/);
/** A Crunchy PGO user name, which PGO requires to be an RFC 1123 label: every label is also a USER_NAME. */
const PGO_USER_NAME = NAMESPACE_NAME;
/** A MongoDB database name, of a user's own database or of one of its roles. */
const MONGO_DB_NAME = z.string().regex(/^[A-Za-z0-9_-]{1,63}$/);
/** A Service name: an RFC 1035 label. */
const SERVICE_NAME = z.string().regex(/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/);
/** The roles of a MongoDB user the exporter keeps, the first ones of the resource. */
const MONGO_ROLES_MAX = 64;
const METADATA = z.object({ namespace: NAMESPACE_NAME, name: OBJECT_NAME });

const ExportStatusSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(["api_unreachable", "credentials_unavailable", "unauthorized", "api_error", "limit_exceeded"]),
    httpStatus: z.number().int().optional(),
    message: MESSAGE,
  }),
]);

const NamespaceStatusSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(["forbidden", "crd_missing", "limit_exceeded"]),
    httpStatus: z.number().int().optional(),
    message: MESSAGE,
  }),
]);

/** A CloudNativePG or EDB Postgres for Kubernetes Cluster, pruned to the fields the contract reads. */
const CnpgClusterSchema = z.object({
  metadata: METADATA,
  spec: z
    .object({
      bootstrap: z
        .object({
          initdb: z
            .object({
              database: z.string().min(1).max(63).optional(),
              secret: z.object({ name: OBJECT_NAME.optional() }).optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * A Crunchy PGO PostgresCluster, pruned to the one user of its row, or to its metadata alone for the default user,
 * which PGO names after the cluster when spec.users is absent or empty.
 */
const PgoClusterSchema = z.object({
  metadata: METADATA,
  spec: z.object({ users: z.array(z.object({ name: PGO_USER_NAME })).length(1) }).optional(),
});

/** A MongoDB Community resource, pruned to the one user of its row, its TLS switch and its Service name. */
const MongoCommunitySchema = z.object({
  metadata: METADATA,
  spec: z.object({
    users: z
      .array(
        z.object({
          name: USER_NAME,
          db: MONGO_DB_NAME.optional(),
          connectionStringSecretName: OBJECT_NAME.optional(),
          roles: z.array(z.object({ db: MONGO_DB_NAME })).max(MONGO_ROLES_MAX),
        }),
      )
      .length(1),
    security: z.object({ tls: z.object({ enabled: z.boolean() }) }).optional(),
    statefulSet: z.object({ spec: z.object({ serviceName: SERVICE_NAME }) }).optional(),
  }),
});

/**
 * A row's credential Secret: its kept keys, or the problem that stopped the exporter keeping them, never both. The name
 * is absent exactly when the exporter could not compute it (unsupported_name).
 */
function secretSchema<Data extends z.ZodRawShape>(data: z.ZodObject<Data>) {
  return z
    .object({
      name: OBJECT_NAME.optional(),
      data: data.optional(),
      problem: z.enum(KUBERNETES_DISCOVERY_PROBLEMS).optional(),
      key: z.enum(KUBERNETES_DISCOVERY_SECRET_KEYS).optional(),
    })
    .refine((secret) => (secret.data === undefined) !== (secret.problem === undefined))
    .refine((secret) => (secret.name === undefined) === (secret.problem === "unsupported_name"));
}

const CNPG_DATA = z.object({
  username: SECRET_VALUE.optional(),
  password: SECRET_VALUE.optional(),
  dbname: SECRET_VALUE.optional(),
  port: SECRET_VALUE.optional(),
});

const PGO_DATA = z.object({
  user: SECRET_VALUE.optional(),
  password: SECRET_VALUE.optional(),
  host: SECRET_VALUE.optional(),
  port: SECRET_VALUE.optional(),
  dbname: SECRET_VALUE.optional(),
});

const MONGO_DATA = z.object({
  "connectionString.standard": SECRET_VALUE.optional(),
  username: SECRET_VALUE.optional(),
  password: SECRET_VALUE.optional(),
});

/** One schema per kind: zod keeps only that kind's resource fields and that row's kept keys. */
const DatabaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cnpg"), resource: CnpgClusterSchema, secret: secretSchema(CNPG_DATA) }),
  z.object({ kind: z.literal("edbpg"), resource: CnpgClusterSchema, secret: secretSchema(CNPG_DATA) }),
  z.object({ kind: z.literal("pgo"), resource: PgoClusterSchema, secret: secretSchema(PGO_DATA) }),
  z.object({ kind: z.literal("mongo"), resource: MongoCommunitySchema, secret: secretSchema(MONGO_DATA) }),
]);

export const KubernetesDiscoveryExportSchema = z
  .object({
    version: z.literal(KUBERNETES_DISCOVERY_EXPORT_VERSION),
    platform: z.literal("kubernetes"),
    generatedAt: ISO_TIME.nullable(),
    checkedAt: ISO_TIME,
    status: ExportStatusSchema,
    // The counts are checked before any element is validated, so an oversized list costs one issue, not one per element.
    namespaces: z
      .array(z.unknown())
      .max(256)
      .pipe(z.array(z.object({ name: NAMESPACE_NAME, status: NamespaceStatusSchema }))),
    databases: z.array(z.unknown()).max(500).pipe(z.array(DatabaseSchema)),
  })
  // Before its first successful scan the exporter has no namespaces or databases to report, and no success.
  .superRefine((file, ctx) => {
    if (file.generatedAt !== null) return;
    for (const field of ["namespaces", "databases"] as const) {
      if (file[field].length === 0) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must be empty before the first successful scan`,
        path: [field],
      });
    }
    if (file.status.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status must be an error before the first successful scan",
        path: ["status"],
      });
    }
  });

export type KubernetesDiscoveryExport = z.infer<typeof KubernetesDiscoveryExportSchema>;
export type KubernetesDiscoveredDatabase = KubernetesDiscoveryExport["databases"][number];
export type KubernetesDiscoveredResource = KubernetesDiscoveredDatabase["resource"];

/** The schema has no record, so an issue's path holds only its own keys and indices, never text the file chose. */
function describeIssues(issues: z.ZodError["issues"]): string {
  const [first] = issues;
  const path = first.path.length > 0 ? first.path.map(String).join(".") : "the top level";
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
  return `${path} (${first.code})${more}`;
}

export function parseKubernetesDiscoveryExport(
  raw: string,
): { ok: true; value: KubernetesDiscoveryExport } | { ok: false; reason: string } {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > KUBERNETES_DISCOVERY_FILE_MAX_BYTES) {
    return {
      ok: false,
      reason: `the file is ${bytes} bytes, over the ${KUBERNETES_DISCOVERY_FILE_MAX_BYTES}-byte limit`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "the file is not valid JSON" };
  }
  const result = KubernetesDiscoveryExportSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: `the file does not match the export schema at ${describeIssues(result.error.issues)}` };
  }
  return { ok: true, value: result.data };
}
