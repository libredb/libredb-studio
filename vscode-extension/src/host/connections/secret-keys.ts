// Where a connection's secrets live in SecretStorage (part 2, "Secrets"): one entry per connection id and secret path,
// keyed "connection/<id>/<path>".
// Which paths are secret comes only from P7's classification maps, at the three levels walkSecretFields covers, so the
// host side names no secret field and a field LibreDB classifies secret later joins with no change here.
import {
  type FieldClass,
  CONNECTION_FIELDS as SECRET_CLASS,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
} from "@/lib/storage/secret-fields";

/** What a connection id is (part 2's schema pattern): it keys the setting entry, the secrets, the child's registry and the editor bindings. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const KEY_PREFIX = "connection/";

/** An object, not null and not an array: what an entry, an ssl setting or a container a path is written into must be. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** walkSecretFields' three levels: the root, then the ssl and sshTunnel containers, each with its own map. */
const LEVELS: readonly { container?: "ssl" | "sshTunnel"; map: Readonly<Record<string, FieldClass>> }[] = [
  { map: SECRET_CLASS },
  { container: "ssl", map: SSL_FIELDS },
  { container: "sshTunnel", map: SSH_TUNNEL_FIELDS },
];

/** The secret field names of one level's map. */
function secretsOf(map: Readonly<Record<string, FieldClass>>): string[] {
  return Object.keys(map).filter((key) => map[key] === "secret");
}

/** A level's path prefix: "" at the root, "ssl." or "sshTunnel." below it. */
function prefixOf(container: string | undefined): string {
  return container === undefined ? "" : `${container}.`;
}

/** Every path P7's classification maps call secret, at the three levels walkSecretFields covers: the root, "ssl." and "sshTunnel.". */
export const SECRET_PATHS: ReadonlySet<string> = new Set(
  LEVELS.flatMap(({ container, map }) => secretsOf(map).map((key) => `${prefixOf(container)}${key}`)),
);

/** The secret paths a record carries as keys, whatever their values (rule 9 refuses "" and non-strings too, which the walk skips). */
export function secretPathsIn(record: Readonly<Record<string, unknown>>): string[] {
  const paths: string[] = [];
  for (const { container, map } of LEVELS) {
    const holder = container === undefined ? record : record[container];
    // A container that is not an object holds no path.
    if (!isPlainObject(holder)) continue;
    for (const key of secretsOf(map)) if (Object.hasOwn(holder, key)) paths.push(`${prefixOf(container)}${key}`);
  }
  return paths;
}

/** "connection/<id>/<path>"; throws Error('"<id>" is not a connection id.') off ID_PATTERN. */
export function secretKey(id: string, path: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`"${id}" is not a connection id.`);
  return `${KEY_PREFIX}${id}/${path}`;
}

/** The id of a key of the form "connection/<id>/<non-empty rest>", else undefined. */
export function idOfSecretKey(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const rest = key.slice(KEY_PREFIX.length);
  // An id holds no "/", so the first one ends it.
  const slash = rest.indexOf("/");
  if (slash === -1 || slash === rest.length - 1) return undefined;
  const id = rest.slice(0, slash);
  return ID_PATTERN.test(id) ? id : undefined;
}
