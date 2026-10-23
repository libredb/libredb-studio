// A connection profile: one entry of the libredb.connections setting, which holds no secret (part 2, "The
// libredb.connections setting"), its load validation, and its split from and join to the WireConnection the child
// takes, both through P7's walker so the host never names a secret field.
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { secretFieldValues, withoutSecretFields, withSecretFieldValues } from "@/lib/storage/secret-fields";
import type { SSLMode } from "@/lib/types";
import type { WireConnection } from "../../protocol";
import { ID_PATTERN, isPlainObject, SECRET_PATHS, secretPathsIn } from "./secret-keys";

/** A valid libredb.connections entry: a WireConnection's public fields, plus the paths of the secrets it keeps in SecretStorage. */
export type ProfileEntry = WireConnection & { secretFields?: readonly string[] };

export type ProfileItem =
  | { kind: "valid"; entry: ProfileEntry }
  /** id once rule 3 passed, name once rule 4 passed. */
  | { kind: "invalid"; reason: string; id?: string; name?: string };

/** Every SSLMode as a key, so a mode missing here or one SSLMode does not have fails the typecheck. */
const SSL_MODE_KEYS: Readonly<Record<SSLMode, true>> = {
  disable: true,
  require: true,
  "verify-system": true,
  "verify-ca": true,
  "verify-full": true,
};

/** The five SSLMode values. */
export const SSL_MODES: readonly SSLMode[] = Object.freeze(Object.keys(SSL_MODE_KEYS) as SSLMode[]);

const EXTERNAL: ReadonlySet<string> = new Set(EXTERNAL_DATABASE_TYPES);

/** Part 2 "Validation at load", rules 1 to 10, in that order; the first rule an element breaks is its reason. */
export function readProfiles(raw: unknown): ProfileItem[] {
  if (!Array.isArray(raw)) {
    return [
      {
        kind: "invalid",
        reason: "libredb.connections in your user settings is not an array, so LibreDB lists no connection from it.",
      },
    ];
  }
  const seen = new Set<string>();
  return raw.map((element, index) => readEntry(element, index + 1, seen));
}

/** Rules 2 to 10 for the element at 1-based position n; seen holds the ids earlier elements gave. */
function readEntry(element: unknown, n: number, seen: Set<string>): ProfileItem {
  if (!isPlainObject(element)) {
    return { kind: "invalid", reason: `Entry ${n} of libredb.connections is not an object.` };
  }
  const { id, name } = element;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return {
      kind: "invalid",
      reason: `Entry ${n} of libredb.connections has no id of 1 to 64 letters, digits, _ or -.`,
    };
  }
  // No id on the repeat: removing by it would also remove the earlier entry and delete its secrets.
  if (seen.has(id)) {
    return { kind: "invalid", reason: `Entry ${n} of libredb.connections repeats the id ${id} of an earlier entry.` };
  }
  seen.add(id);
  if (typeof name !== "string" || name.trim() === "") {
    return { kind: "invalid", reason: `The connection ${id} has no name.`, id };
  }
  const reason = refusalOf(element, name);
  if (reason !== undefined) return { kind: "invalid", reason, id, name };
  // Every other key passes through unchanged, so an entry a newer version wrote still opens.
  return { kind: "valid", entry: element as unknown as ProfileEntry };
}

/** Rules 5 to 10 for an element whose id and name are usable: the first one it breaks, else undefined. */
function refusalOf(entry: Record<string, unknown>, name: string): string | undefined {
  const { type, createdAt, port, ssl, secretFields } = entry;
  // A type the channel does not enable passes: its open answers the factory gate's sentence.
  if (typeof type !== "string" || !EXTERNAL.has(type)) {
    return `The connection ${name} has the type ${String(type)}, which is not a database LibreDB Studio connects to.`;
  }
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    return `The connection ${name} has no createdAt date.`;
  }
  if (port !== undefined && !(typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535)) {
    return `The connection ${name} has a port that is not a whole number from 1 to 65535.`;
  }
  if (ssl !== undefined && !(isPlainObject(ssl) && SSL_MODES.some((mode) => mode === ssl.mode))) {
    return `The connection ${name} has an ssl setting whose mode is not disable, require, verify-system, verify-ca or verify-full.`;
  }
  // Refused rather than moved: a value in user settings has already travelled with Settings Sync.
  const secret = secretPathsIn(entry)[0];
  if (secret !== undefined) {
    return `Remove ${secret} from this connection in your user settings: LibreDB keeps secrets in VS Code's secret storage and asks for them when it connects.`;
  }
  if (secretFields !== undefined && !holdsSecretFields(entry, secretFields)) {
    return `The connection ${name} lists in secretFields a path that is not a distinct secret field it can hold.`;
  }
  return undefined;
}

/**
 * Whether secretFields is an array of distinct secret paths, each of whose container the entry has as an object:
 * withSecretFieldValues throws at open on a path whose container is missing.
 */
function holdsSecretFields(entry: Record<string, unknown>, secretFields: unknown): boolean {
  if (!Array.isArray(secretFields) || new Set(secretFields).size !== secretFields.length) return false;
  return secretFields.every((path) => {
    if (typeof path !== "string" || !SECRET_PATHS.has(path)) return false;
    // A root path holds no dot; a nested one is its container, a dot and a field name.
    const dot = path.indexOf(".");
    return dot === -1 || isPlainObject(entry[path.slice(0, dot)]);
  });
}

/** What connection/test and connection/open carry: the entry without secretFields, with the secrets written at their paths. */
export function toWireConnection(entry: ProfileEntry, secrets: Readonly<Record<string, string>>): WireConnection {
  const connection = { ...entry };
  delete connection.secretFields;
  return withSecretFieldValues(connection, secrets);
}

/** Splits a connection into the setting's entry and its non-empty secrets; throws if a secret key would stay in the entry. */
export function toEntry(connection: WireConnection): { entry: ProfileEntry; secrets: Record<string, string> } {
  const secrets = secretFieldValues(connection);
  const entry: ProfileEntry = withoutSecretFields(connection);
  // The walk skips an empty value, which would stay in the setting as a secret key.
  const left = secretPathsIn(entry)[0];
  if (left !== undefined) throw new Error(`${left} is a secret field and cannot be saved in the setting.`);
  const paths = Object.keys(secrets);
  return { entry: paths.length === 0 ? entry : { ...entry, secretFields: paths }, secrets };
}
