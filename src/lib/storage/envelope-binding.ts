import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/governance/jcs";
import { identityFields, identityFieldsAsGiven, type SecretFieldRecord } from "./secret-fields";

/**
 * Where a version 2 envelope may open (docs/STORAGE.md, "Where a sealed value opens").
 *
 * Every value the server store seals carries, as AES-256-GCM additional authenticated data, the UTF-8 of the RFC 8785
 * canonical JSON (`canonicalJson` in src/lib/governance/jcs.ts) of `{d, f, o, r, s, t}`:
 *
 * - `s`: `"v2"`, the envelope format;
 * - `t`: `"connections"` or `"accounts"`, where the value is stored;
 * - `o`: the owner: the `user_id` of the user_storage row for a connection, the account's email for a factor;
 * - `r`: the record: the connection's `id` as the store holds it (`null` when absent), the account's email for a factor;
 * - `f`: the field path (`password`, `ssl.clientKey`, `sshTunnel.passphrase`, ..., `totpSecret`, `totpPending`);
 * - `d`: the unpadded base64url SHA-256 of the UTF-8 canonical JSON of the record's identity projection
 *   (`identityFields` in ./secret-fields.ts); for an account, of `{}`.
 *
 * A value sealed under one binding fails authentication under any other, so it opens only in the place it was sealed
 * for. The text is never empty (it always names the format), which matters: GCM treats an empty additional data exactly
 * as none, the form version 1 envelopes were sealed with.
 *
 * `EnvelopeBinding` carries a type brand, and this module records every binding it builds, so a caller cannot
 * hand-assemble one: `bindingAad` throws for any object `connectionBinding` or `accountBinding` did not build, a type
 * assertion included, so every seal or open goes through them.
 *
 * A connection whose id or identity fields nest deeper than `MAX_BINDING_DEPTH` levels has no binding
 * (`connectionBindingProblem` says so, and `connectionBinding` throws it), because no connection holds such a value, so
 * the binding is defined only up to that depth.
 */

/** The envelope format the binding names, and the version tag of every value sealed under it. */
export const BINDING_FORMAT = "v2";

declare const bindingBrand: unique symbol;

export interface EnvelopeBinding {
  readonly [bindingBrand]: true;
  readonly aad: Uint8Array;
}

/**
 * The deepest a connection's id, or its identity fields, may nest. A real connection nests two levels (`ssl.caCert`,
 * an address in `dataServers`); a far deeper value is no connection, so it is refused by name instead of bound.
 */
export const MAX_BINDING_DEPTH = 32;

/** Every binding this module built; `bindingAad` refuses any other object. */
const built = new WeakSet<object>();

/** The secret fields of an account row that are sealed. */
export type AccountFactorField = "totpSecret" | "totpPending";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64url");
}

function bind(table: "connections" | "accounts", owner: string, record: unknown, field: string, digest: string) {
  const text = canonicalJson({ d: digest, f: field, o: owner, r: record, s: BINDING_FORMAT, t: table });
  const binding = { aad: new TextEncoder().encode(text) } as EnvelopeBinding;
  built.add(binding);
  return binding;
}

/** Whether `value` nests deeper than `MAX_BINDING_DEPTH` levels of arrays and objects, measured without recursion. */
function nestsTooDeep(value: unknown): boolean {
  const pending: [unknown, number][] = [[value, 0]];
  while (pending.length > 0) {
    const [current, depth] = pending.pop()!;
    if (typeof current !== "object" || current === null) continue;
    if (depth >= MAX_BINDING_DEPTH) return true;
    for (const member of Object.values(current)) pending.push([member, depth + 1]);
  }
  return false;
}

/** The connection's id as the store holds it: through JSON, `null` when absent. */
function storedId<T extends SecretFieldRecord>(connection: T): unknown {
  const stored = JSON.parse(JSON.stringify({ id: connection.id })) as { id?: unknown };
  return Object.hasOwn(stored, "id") ? stored.id : null;
}

const TOO_DEEP = `The connection's id or identity fields nest deeper than ${MAX_BINDING_DEPTH} levels, which no connection does, so it has no binding.`;

/**
 * Why `connection` has no binding (its id or identity fields nest deeper than `MAX_BINDING_DEPTH` levels), or null.
 * Measured on the record as given (`identityFieldsAsGiven`), never through JSON, so the check serializes nothing it
 * refuses, whatever the depth.
 */
export function connectionBindingProblem<T extends SecretFieldRecord>(connection: T): string | null {
  const id = (connection as { id?: unknown }).id;
  return nestsTooDeep(id) || nestsTooDeep(identityFieldsAsGiven(connection)) ? TOO_DEEP : null;
}

/**
 * The bindings of one stored connection: `owner` is the user_storage row's `user_id`, and the record and the identity
 * digest are taken from `connection` as the store holds it, so a value bound for the record as written opens for the
 * record as read back. The digest is computed once per connection, not once per field. Throws the
 * `connectionBindingProblem` of a connection that has none.
 */
export function connectionBinding<T extends SecretFieldRecord>(
  owner: string,
  connection: T,
): { field(path: string): EnvelopeBinding } {
  const problem = connectionBindingProblem(connection);
  if (problem !== null) throw new Error(problem);
  const record = storedId(connection);
  const digest = sha256(canonicalJson(identityFields(connection)));
  return { field: (path) => bind("connections", owner, record, path, digest) };
}

/** The bindings of one account's factors: owner and record are both the account's email, over no identity fields. */
export function accountBinding(email: string): { field(name: AccountFactorField): EnvelopeBinding } {
  const digest = sha256(canonicalJson({}));
  return { field: (name) => bind("accounts", email, email, name, digest) };
}

/** The additional authenticated data of a binding: the UTF-8 of its canonical JSON. */
export function bindingAad(binding: EnvelopeBinding): Uint8Array {
  if (!built.has(binding)) {
    throw new Error("A binding not built by connectionBinding or accountBinding was passed to a seal or an open.");
  }
  return binding.aad;
}
