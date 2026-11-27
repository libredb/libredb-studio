/**
 * The canonical text of a JSON value, the one form both of the grant register's digests hash: the SQL grammar digest
 * (./grammar-digest) and the statement language data digest (./language-digest). The text is the value as JSON with no
 * white space, every object's members in ascending code-unit order and every list in its own order, so two declarations
 * stating the same facts in another member order have one text and any changed fact another.
 *
 * Pure: it imports nothing, so a module the browser loads may read it; the two digests, which hash with node:crypto,
 * are server-only (tests/unit/db/grammar-digest-boundary.test.ts).
 */

/**
 * The canonical text of `value`, a `subject` such as a grammar, which the refusal names.
 *
 * @throws {Error} Naming the subject and the type, for a value that is no JSON value: `undefined`, a function, a
 * symbol, a bigint or a number that is not finite, anywhere in the value.
 */
export function canonicalJsonText(value: unknown, subject: string): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonText(item, subject)).join(",")}]`;
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object") {
    throw new Error(
      `a ${subject}'s canonical text holds JSON values only, and this ${subject} holds a value of type ${typeof value}`,
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  const names = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const members = names.map((name) => `${JSON.stringify(name)}:${canonicalJsonText(record[name], subject)}`);
  return `{${members.join(",")}}`;
}
