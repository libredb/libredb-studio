/**
 * The two operations every reader of an object ADDRESS needs: an order over paths, and one
 * comparable spelling of a path (#789).
 *
 * One home, beside `object-kinds.ts` and `object-address.ts`, because this was written
 * sixteen times in `src/lib/db/providers` and three more times outside it, and sixteen copies
 * of an order are sixteen chances for two readers to disagree about where a row goes. Every
 * caller joins a listing to a bulk detail read on the path, so the two answers have to be
 * ordered and keyed by the same rule or the join is by accident.
 *
 * It lives here rather than in `object-kinds.ts`, which standing ruling 5h named while there
 * were still four copies: that file's own docblock scopes it to "pure derivations over a
 * provider's object declarations", and neither function below reads a declaration. The move
 * ruling 5h asked for is the one that happened; only the file name is different, and this
 * sentence is the record of that.
 */

/**
 * The separator that turns a path into one comparable, collision-free string.
 *
 * A control character (US, 0x1F), because it cannot occur inside an identifier on any engine
 * this product serves, so two different paths cannot produce one key. A dot or a slash can:
 * `["a.b"]` and `["a", "b"]` would collide, and a collision here silently joins one object's
 * columns onto another's.
 */
const SEGMENT_SEPARATOR = String.fromCharCode(31);

/**
 * One comparable spelling of a path, for EQUALITY and for map keys. Never for ordering:
 * `comparePaths` is the order, and a joined string orders the separator rather than the
 * segments.
 *
 * `JSON.stringify` is deliberately not used, for the reason standing ruling 5g gives: JSON
 * escaping rewrites a quote, a backslash and every control character, so a key built that way
 * here and another way in the object browser would agree on ordinary names and drift on
 * exotic ones. That is how two joins came to disagree before.
 */
export function pathKey(path: readonly string[]): string {
  return path.join(SEGMENT_SEPARATOR);
}

/**
 * Two paths ordered SEGMENT BY SEGMENT, with a prefix above every path that extends it.
 *
 * A prefix sorting first is the ordering the tree and every listing want: a container-level
 * row above the rows nested under its name, an Oracle schema-level trigger above the
 * table-level ones (standing ruling 5f's mixed depth). `JSON.stringify(path)` is the obvious
 * spelling and it is wrong twice, which is why standing ruling 5g refuses it: at mixed depth
 * the deeper path sorts FIRST, because the separator `,` (0x2C) is below the terminator `]`
 * (0x5D), and JSON escaping reorders exotic names by rewriting the characters being compared.
 *
 * **The comparison is over UTF-16 CODE UNITS and stays that way on purpose.** JavaScript's
 * `<` on strings compares code units, and that is not the order the servers cut a bounded
 * read in: Task 26a-2 measured four engines ordering by the UTF-8 BYTE order, and the two
 * answer the REVERSE for `U+E000` against `U+1F600` (`ee 80 80` is below `f0 9f 98 80` in
 * UTF-8, while in UTF-16 `U+1F600` is the surrogate pair `D83D DE00` and sorts BELOW
 * `U+E000`). Three reasons to keep the client's order rather than emulate the server's:
 *
 *  - the split is already MEASURED, DOCUMENTED and TESTED per engine, and each provider that
 *    can meet it says in its own docblock that a bounded read's MEMBERSHIP is the server's
 *    while the ORDER of the answer is ours. Changing the order here would make sixteen
 *    provider docblocks wrong in one commit;
 *  - the engines do not agree with each other either, so there is no single server order to
 *    adopt: this is a client-side presentation and join order, and it only has to be a total
 *    order that every reader in this process computes identically;
 *  - Cassandra is the one engine where the question provably cannot arise, and for a reason
 *    worth keeping: a CQL identifier is alphanumeric and underscore only, quoted or not, so
 *    neither character can name anything there and the two orders coincide over that
 *    alphabet.
 *
 * So this is a DELIBERATE UTF-16 comparison, not an unexamined use of `<`. Changing it to a
 * byte order would change the sort of every listing on seventeen engines, and standing ruling
 * 5b's discipline applies: that is a behaviour change and it needs its own failing test
 * first, not a quiet edit here.
 *
 * The final comparison is the DEPTH difference, and it is the arm that the epic measured as
 * reported-covered and dead in the provider-local copies. `tests/unit/db/object-path.test.ts`
 * pins it directly, at equal depth, one level apart and two levels apart, so mutating it to
 * `return 0` cannot pass.
 */
export function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}
