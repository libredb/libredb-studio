/**
 * One seed config text, from a file or a variable, parsed, validated and turned into operator entries. The origin
 * (a file path or a variable name) is in every message; the text never is.
 */
import { parseDocument, YAMLError } from "yaml";
import type { ZodError } from "zod";
import { authProvider } from "@/lib/config/auth-provider";
import { mergeDefaults } from "../connection-filter";
import { SeedConfigSchema, type SeedConfig } from "../types";
import { OperatorSourceError, type OperatorEntry } from "./types";

export type SeedConfigFormat = "json" | "yaml";

/** "json" when the name ends in ".json", else "yaml". */
export function seedConfigFormatOf(fileName: string): SeedConfigFormat {
  return fileName.endsWith(".json") ? "json" : "yaml";
}

/** "path.joined: message" per issue, or the message alone for an issue with an empty path, joined by "; ". */
export function describeIssues(error: ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`))
    .join("; ");
}

/**
 * Where the text fails to parse, without the text. A parser's message quotes the line it failed on, and in a seed
 * config that line can hold a plaintext password; this message reaches every caller of a `seed:` route through the
 * error response, and the admin seed-sources view, before any role filter runs. The parser's own error stays
 * attached as `cause`.
 */
function parseFailure(err: unknown, format: SeedConfigFormat): string {
  if (err instanceof YAMLError) {
    const at = err.linePos?.[0];
    return at ? `${err.code} at line ${at.line}, column ${at.col}` : err.code;
  }
  return format === "json" ? "the file is not valid JSON" : "the file is not valid YAML";
}

/**
 * YAML text to a value, with a warning treated as a failure. `parse` from `yaml` hands every warning to
 * process.emitWarning, which prints it to stderr outside the logger, quoting the source line: an unquoted
 * `password: !TEST_PASSWORD` is an unresolved tag, its warning names the password, and the value silently becomes "".
 * `logLevel: "error"` keeps the warnings in `doc.warnings` and prints none.
 */
function parseYAMLText(text: string): unknown {
  const doc = parseDocument(text, { logLevel: "error" });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem !== undefined) throw problem;
  return doc.toJS();
}

const STANDARD_ROLES = new Set(["*", "admin", "user"]);
const RESERVED_ROLES = new Set(["*", "admin", "user"]);

function validateCustomRoles(config: SeedConfig, origin: string): void {
  const isOidc = authProvider() === "oidc";
  const prefix = process.env.OIDC_ROLE_PREFIX;

  for (const conn of config.connections) {
    for (const role of conn.roles) {
      if (STANDARD_ROLES.has(role)) continue;
      if (RESERVED_ROLES.has(role.toLowerCase())) {
        throw new OperatorSourceError(
          "invalid",
          `Invalid seed config at ${origin}: connection "${conn.id}" declares reserved role "${role}"`,
        );
      }
      if (!isOidc || !prefix) {
        throw new OperatorSourceError(
          "invalid",
          `Invalid seed config at ${origin}: connection "${conn.id}" declares custom role "${role}", which requires NEXT_PUBLIC_AUTH_PROVIDER="oidc" and OIDC_ROLE_PREFIX to be set`,
        );
      }
      if (!role.startsWith(prefix)) {
        throw new OperatorSourceError(
          "invalid",
          `Invalid seed config at ${origin}: connection "${conn.id}" declares role "${role}", which does not start with OIDC_ROLE_PREFIX "${prefix}"`,
        );
      }
    }
  }
}

/** Parses and validates one config text; throws OperatorSourceError("unparseable" | "invalid"). */
export function parseSeedConfigText(text: string, origin: string, format: SeedConfigFormat): SeedConfig {
  let parsed: unknown;
  try {
    parsed = format === "json" ? JSON.parse(text) : parseYAMLText(text);
  } catch (err) {
    const message = `Failed to parse seed config at ${origin}: ${parseFailure(err, format)}`;
    throw new OperatorSourceError("unparseable", message, { cause: err });
  }
  const result = SeedConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new OperatorSourceError("invalid", `Invalid seed config at ${origin}: ${describeIssues(result.error)}`);
  }
  validateCustomRoles(result.data, origin);
  return result.data;
}

/** One entry per connection, `mergeDefaults(conn, config.defaults)` applied, all with this origin and literal flag. */
export function entriesFromConfig(config: SeedConfig, origin: string, literal: boolean): OperatorEntry[] {
  return config.connections.map((conn) => ({ connection: mergeDefaults(conn, config.defaults), literal, origin }));
}
