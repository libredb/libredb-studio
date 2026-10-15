/**
 * Opening the sealed credentials of governed connections (docs/GOVERNANCE.md#sealed-credentials-lsb1).
 *
 * A control plane stores each connection's read and write credentials as `lsb1` envelopes sealed to Studio's public
 * key. `openGovernedSecret` opens one with the keyring of this process (`keyring.ts`) through `openSealedSecret`
 * (`lsb1.ts`), which binds it to its connection id, level, engine, key id and canonical definition, so an envelope
 * moved to another row fails with AUTH_FAILED.
 *
 * Every reload of the governance source sees the same envelopes again, so what opened is cached in memory, under the
 * SHA-256 of the envelope together with the additional authenticated data it opened under. A cache hit therefore
 * never skips the binding check: the same envelope under another binding is another entry, and it has to open on its
 * own. The cache belongs to the keyring it opened with, keeps the most recently used secrets up to a bound, and never
 * keeps a failure. Nothing here logs, and an envelope that does not open throws a SealedSecretError that carries its
 * code alone.
 */
import { createHash } from "node:crypto";
import { governanceKeyring } from "./keyring";
import { bindingAad, type Keyring, type OpenedSecret, openSealedSecret, type SecretBinding } from "./lsb1";

/**
 * The most opened secrets the cache keeps, two per connection for 2048 connections. Past it, the secret used least
 * recently is dropped and opened again when it is next needed.
 */
export const OPENED_SECRETS_MAX = 4096;

/** The opened secrets of each keyring, least recently used first, as a Map iterates. */
const openedByKeyring = new WeakMap<Keyring, Map<string, OpenedSecret>>();

function cacheOf(keyring: Keyring): Map<string, OpenedSecret> {
  let cache = openedByKeyring.get(keyring);
  if (cache === undefined) {
    cache = new Map();
    openedByKeyring.set(keyring, cache);
  }
  return cache;
}

/**
 * The cache key of `envelope` opened for `binding`: the SHA-256 of the envelope, then the additional authenticated
 * data it opens under, which binds the kid the envelope names. Only a well-formed envelope ever opens, and its kid is
 * its second field, so whatever a malformed envelope holds there never keys an entry.
 */
function cacheKey(envelope: string, binding: SecretBinding): string {
  const kid = envelope.split(".")[1] ?? "";
  const digest = createHash("sha256").update(envelope, "utf8").digest("hex");
  return `${digest} ${bindingAad(binding, kid).toString("utf8")}`;
}

/**
 * Opens `envelope` for `binding` with the keyring of this process and returns the credential set it carries, frozen,
 * because the cache hands the same object to the next caller.
 *
 * It throws the SealedSecretError of `openSealedSecret` when the envelope does not open, the error of
 * `governanceKeyring()` when there is no keyring, and the CanonicalJsonError of `bindingAad` for a definition outside
 * the values docs/GOVERNANCE.md#sealed-credentials-lsb1 admits, which admission refuses before any envelope is opened
 * (docs/GOVERNANCE.md#row-admission-and-skip-codes).
 */
export function openGovernedSecret(envelope: string, binding: SecretBinding): OpenedSecret {
  const keyring = governanceKeyring();
  const cache = cacheOf(keyring);
  const key = cacheKey(envelope, binding);
  const cached = cache.get(key);
  if (cached !== undefined) {
    // Moved to the end, so the bound drops the secret unused the longest.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const secret = Object.freeze(openSealedSecret(keyring, envelope, binding));
  cache.set(key, secret);
  if (cache.size > OPENED_SECRETS_MAX) cache.delete(cache.keys().next().value as string);
  return secret;
}
