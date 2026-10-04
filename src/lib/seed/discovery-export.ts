/**
 * The CapRover discovery export: the file docker/discover.mjs writes into the shared volume, and the
 * parser Studio reads it with.
 *
 * The file is untrusted input. It is checked for size before it is parsed, refused whole when it does
 * not match the schema, and a refusal names a field path and an issue code, never the file's text:
 * the env values are database passwords, and an env key is text the file chose. The schema keeps only
 * the declared keys (zod strips the rest), so nothing in the file can set a connection's roles,
 * managed flag or MCP opt-in; those are forced in code (discovery-fingerprint.ts).
 *
 * The host is deliberately not checked here. A service with an odd host is one bad entry among good
 * ones, so the mapping skips it alone (HOST_PATTERN in discovery-fingerprint.ts) instead of the whole
 * file failing. An empty image or appName is different: the exporter leaves such a service out and
 * counts it in droppedValues, so a file that carries one did not come from the exporter.
 *
 * `excluded` lists the app names DISCOVERY_EXCLUDE left out of the last good scan, so the loader can
 * report them as skipped. It is always present and empty before the first successful scan.
 */
import { z } from "zod";

/** The exporter's own cap on the file (LIMITS.fileBytes in docker/discover.mjs). */
export const DISCOVERY_FILE_MAX_BYTES = 2 * 1024 * 1024;

const ISO_TIME = z.iso.datetime();

// Discriminated on the literal ok: the inferred ExporterStatus narrows (code and message exist only when ok is
// false), and an invalid status names its bad field instead of failing as an unmatched union.
const ExporterStatusSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      "socket_unavailable",
      "swarm_unavailable",
      "api_version",
      "network_not_found",
      "docker_error",
      "limit_exceeded",
    ]),
    httpStatus: z.number().int().optional(),
    message: z.string().max(512),
  }),
]);

// The most env keys one service may carry. The exporter projects at most its ten allow-listed keys. 64 leaves room
// for a newer exporter when the exporter and Studio run different image versions, and stays far below the key count
// at which zod's issue collection overflows the stack on Node.
const ENV_KEYS_MAX = 64;

const DiscoveredServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(63),
  appName: z.string().min(1).max(63),
  host: z.string().min(1).max(253),
  image: z.string().min(1).max(512),
  // As with the lists below, the keys are counted before any value is validated, so an oversized record costs one
  // issue instead of one per value.
  env: z
    .record(z.string(), z.unknown())
    .refine((env) => Object.keys(env).length <= ENV_KEYS_MAX)
    .pipe(z.record(z.string(), z.string().max(1024))),
  // The exporter's derivation only ever yields an env var name, never a value.
  requirepassEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .nullable(),
  tasks: z.object({
    running: z.number().int().nonnegative(),
    desired: z.number().int().nonnegative(),
  }),
});

export const DiscoveryExportSchema = z
  .object({
    version: z.literal(1),
    platform: z.literal("caprover"),
    generatedAt: ISO_TIME.nullable(),
    checkedAt: ISO_TIME,
    status: ExporterStatusSchema,
    network: z.object({ name: z.string().min(1), id: z.string().min(1) }).nullable(),
    // The count is checked before any element is validated, so an oversized list costs one issue, not one per element.
    services: z.array(z.unknown()).max(500).pipe(z.array(DiscoveredServiceSchema)),
    excluded: z
      .array(z.unknown())
      .max(500)
      .pipe(z.array(z.string().min(1).max(63))),
  })
  // Before its first successful listing the exporter has no services or excluded apps to report, and no success.
  .superRefine((file, ctx) => {
    if (file.generatedAt !== null) return;
    if (file.services.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "services must be empty before the first successful scan",
        path: ["services"],
      });
    }
    if (file.excluded.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "excluded must be empty before the first successful scan",
        path: ["excluded"],
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

export type DiscoveryExport = z.infer<typeof DiscoveryExportSchema>;
export type DiscoveredService = DiscoveryExport["services"][number];
export type ExporterStatus = DiscoveryExport["status"];

/**
 * Where an issue sits, without any text the file chose: the only record in the schema is `env`, so
 * the path stops there and never names an env key.
 */
function issuePath(path: readonly PropertyKey[]): string {
  const envAt = path.indexOf("env");
  const kept = envAt === -1 ? path : path.slice(0, envAt + 1);
  return kept.length > 0 ? kept.map(String).join(".") : "the top level";
}

function describeIssues(issues: z.ZodError["issues"]): string {
  const first = issues[0];
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
  return `${issuePath(first.path)} (${first.code})${more}`;
}

export function parseDiscoveryExport(
  raw: string,
): { ok: true; value: DiscoveryExport } | { ok: false; reason: string } {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > DISCOVERY_FILE_MAX_BYTES) {
    return { ok: false, reason: `the file is ${bytes} bytes, over the ${DISCOVERY_FILE_MAX_BYTES}-byte limit` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "the file is not valid JSON" };
  }
  const result = DiscoveryExportSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: `the file does not match the export schema at ${describeIssues(result.error.issues)}` };
  }
  return { ok: true, value: result.data };
}
