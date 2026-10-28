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
 * Each database entry carries the contract's fields of its resource, pruned by the exporter, and either the
 * contract's keys of its credential Secret or the reason none could be kept. The names are checked as Kubernetes
 * names here, because the connection's host is built from them.
 */
import { z } from "zod";

/** Studio's cap on the file: the Secret it is projected from holds at most 1 MiB. */
export const KUBERNETES_DISCOVERY_FILE_MAX_BYTES = 1024 * 1024;

/** The keys of a credential Secret the contract keeps, the only ones an export may carry. */
export const KUBERNETES_DISCOVERY_SECRET_KEYS = ["username", "password", "dbname", "port"] as const;

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
    code: z.enum(["forbidden", "crd_missing"]),
    httpStatus: z.number().int().optional(),
    message: MESSAGE,
  }),
]);

/** A CloudNativePG Cluster, pruned to the fields the contract reads. */
const CnpgClusterSchema = z.object({
  metadata: z.object({ namespace: NAMESPACE_NAME, name: OBJECT_NAME }),
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

const SecretSchema = z
  .object({
    name: OBJECT_NAME,
    data: z
      .object({
        username: SECRET_VALUE.optional(),
        password: SECRET_VALUE.optional(),
        dbname: SECRET_VALUE.optional(),
        port: SECRET_VALUE.optional(),
      })
      .optional(),
    problem: z.enum(["not_found", "forbidden", "invalid_value"]).optional(),
    key: z.enum(KUBERNETES_DISCOVERY_SECRET_KEYS).optional(),
  })
  // The exporter writes the kept keys, or the reason it kept none, never both.
  .refine((secret) => (secret.data === undefined) !== (secret.problem === undefined));

const DatabaseSchema = z.object({
  kind: z.literal("cnpg"),
  resource: CnpgClusterSchema,
  secret: SecretSchema,
});

export const KubernetesDiscoveryExportSchema = z
  .object({
    version: z.literal(1),
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
