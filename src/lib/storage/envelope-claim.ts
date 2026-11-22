/**
 * The shape rule (D4) that tells a stored envelope from plaintext without the storage key.
 *
 * A value whose first colon-separated segment matches `^v\d+$` CLAIMS to be an envelope, whatever follows, and is
 * never read as plaintext: a truncated or partially written envelope must not pass through as if it were a real
 * password. The accepted cost: a real plaintext password shaped exactly `^v\d+:` (for example "v1:x") reads as an
 * unopenable envelope, an empty field the user retypes.
 *
 * Pure and import-free, so a caller that only needs to recognise an envelope (the provider factory, and through it the
 * npm package) does not load the storage key code in ./encryption.ts.
 */
const VERSION_TAG = /^v\d+$/;

/** Whether `value` claims to be a stored envelope: its text before the first colon is `v` and digits. */
export function isEnvelopeClaim(value: string): boolean {
  return VERSION_TAG.test(value.split(":", 1)[0]);
}
