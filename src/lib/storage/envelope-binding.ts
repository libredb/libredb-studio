import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/governance/jcs";
import { identityFields, type SecretFieldRecord } from "./secret-fields";

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
 * `EnvelopeBinding` carries a brand only this module attaches, so a caller cannot hand-assemble one: a seal or an open
 * always goes through `connectionBinding` or `accountBinding`.
 */

/** The envelope format the binding names, and the version tag of every value sealed under it. */
export const BINDING_FORMAT = "v2";

declare const bindingBrand: unique symbol;

export interface EnvelopeBinding {
  readonly [bindingBrand]: true;
  readonly aad: Uint8Array;
}

/** The secret fields of an account row that are sealed. */
export type AccountFactorField = "totpSecret" | "totpPending";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64url");
}

function bind(table: "connections" | "accounts", owner: string, record: unknown, field: string, digest: string) {
  const text = canonicalJson({ d: digest, f: field, o: owner, r: record, s: BINDING_FORMAT, t: table });
  return { aad: new TextEncoder().encode(text) } as EnvelopeBinding;
}

/**
 * The bindings of one stored connection: `owner` is the user_storage row's `user_id`, and the record and the identity
 * digest are taken from `connection` as the store holds it, so a value bound for the record as written opens for the
 * record as read back. The digest is computed once per connection, not once per field.
 */
export function connectionBinding<T extends SecretFieldRecord>(
  owner: string,
  connection: T,
): { field(path: string): EnvelopeBinding } {
  const stored = JSON.parse(JSON.stringify({ id: connection.id })) as { id?: unknown };
  const record = Object.hasOwn(stored, "id") ? stored.id : null;
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
  return binding.aad;
}
