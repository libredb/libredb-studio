/**
 * The id generator for things this browser names for itself — a query-history row, a
 * saved query, an editor tab, a connection the user typed in.
 *
 * `crypto.getRandomValues` rather than `Math.random`, which a scanner reads as a
 * pseudorandom generator standing where a secure one belongs. Nothing here is a
 * secret, but the two cost the same and only one of them has to be argued about in
 * every review. The generator was written once for the history row and the other
 * three sites kept their own `Math.random().toString(36).substring(7)` — one of them
 * still on the deprecated `substr` — which is 4–6 characters of entropy standing in
 * for identity, and identity is what `storage.saveQuery` and the tab list key on.
 *
 * Deliberately NOT `crypto.randomUUID`: it is restricted to secure contexts, and
 * Studio is served over plain HTTP on several of its distribution channels, where it
 * is simply undefined. `getRandomValues` carries no such restriction.
 */
export function newLocalId(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(2));
  return `${bytes[0].toString(36)}${bytes[1].toString(36)}`;
}
