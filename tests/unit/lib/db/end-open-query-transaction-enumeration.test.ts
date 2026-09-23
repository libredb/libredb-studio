/**
 * The implementer list for `endOpenQueryTransaction` is written in prose, and prose goes stale
 * (D75).
 *
 * It said `postgres`, `sqlite` and `duckdb` for as long as that was true. D75 added `redis`, and
 * the sentence stayed wrong in `src/lib/db/types.ts` and `src/app/api/db/multi-query/route.ts`
 * through a whole wave, while eight provider docs were corrected around it, because nothing
 * derived the list from the providers themselves. The provider docs are already guarded, each by
 * its own `not.toContain` assertion; these two sites had no guard at all.
 *
 * So this derives the set from the provider sources and asserts each prose site names exactly it.
 * A future provider that implements the surface fails here until both sentences are updated, which
 * is the direction the failure has to point: the code is the fact and the prose is the claim.
 *
 * The detection is textual on purpose. Importing every provider to ask which carry the method
 * would load every driver, and a type-level check cannot see an optional method's presence on a
 * concrete class without instantiating it.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const PROVIDERS = path.join(ROOT, "src/lib/db/providers");

/** Every provider module, whether it is `<type-id>.ts` or `<type-id>/index.ts`. */
const providerSources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return providerSources(full);
    return name.endsWith(".ts") ? [full] : [];
  });

/** A provider IMPLEMENTS the surface when it declares the method, not when it merely names it. */
const implementers = providerSources(PROVIDERS)
  .filter((file) => /^\s*public async endOpenQueryTransaction\(/m.test(readFileSync(file, "utf8")))
  // `providers/<family>/<type-id>.ts`, or `providers/<family>/<type-id>/index.ts` when the
  // provider is split across modules. The family directory is never the type-id.
  .map((file) => (path.basename(file) === "index.ts" ? path.basename(path.dirname(file)) : path.basename(file, ".ts")))
  .sort();

// One site since D87. The second was the local shape check in `src/app/api/db/multi-query/route.ts`,
// which moved to `endsOpenQueryTransactions` in `types.ts` when `/api/db/query` became the second
// caller: two routes asking the same question in two copies is how one of them later asks it
// differently. The claim now lives beside the declaration it is about, which is where a reader of
// the surface meets it.
const PROSE_SITES = ["src/lib/db/types.ts"];

/**
 * The ONE sentence that makes the claim, found inside the ONE docblock that makes it.
 *
 * Three narrowings, each forced by a measured false pass of an earlier form of this test.
 * Reading the whole FILE made both assertions vacuous, because the surrounding prose names
 * `redis` for other reasons and deleting it from the enumeration changed nothing. Then taking the
 * first sentence containing "implement it" picked `queryReadOnly`'s docblock in `types.ts`, which
 * uses the same words about a different surface. So the block has to name this method first, and
 * the claim is the enumeration BEFORE the verb rather than the sentence that carries it.
 */
const claimSentence = (site: string): string => {
  const source = readFileSync(path.join(ROOT, site), "utf8");
  const blocks = [...source.matchAll(/\/\*\*[\s\S]*?\*\//g)];
  const block = blocks
    .map((match) => ({
      flat: match[0].replace(/\n\s*\*\s*/g, " "),
      // A DECLARATION's docblock does not contain the method's name; the line under it does.
      declares: source.slice(match.index + match[0].length, match.index + match[0].length + 200),
    }))
    .find(
      (candidate) =>
        candidate.flat.includes("implement it") &&
        (candidate.flat.includes("endOpenQueryTransaction") || candidate.declares.includes("endOpenQueryTransaction")),
    );
  if (block === undefined) throw new Error(`${site} has no endOpenQueryTransaction docblock claiming a list`);
  const sentence = block.flat.split(/(?<=\.)\s/).find((part) => part.includes("implement it"));
  if (sentence === undefined) throw new Error(`${site} has no sentence saying who implements it`);
  // The ENUMERATION, which is what precedes the verb. A third narrowing, and a third measured
  // false pass: `types.ts`'s sentence runs on past a colon and names `redis` again for a
  // different reason, so taking the whole sentence let the enumeration lose a name and still
  // pass. Everything after "implement it" is commentary and is not the claim.
  return sentence.slice(0, sentence.indexOf("implement it"));
};

const namedIn = (sentence: string): string[] => [
  ...new Set([...sentence.matchAll(/`([a-z]+)`/g)].map((match) => match[1])),
];

describe("the endOpenQueryTransaction implementer list", () => {
  test("the providers themselves are the list, and it is not empty", () => {
    expect(implementers).toEqual(["duckdb", "postgres", "redis", "sqlite"]);
  });

  for (const site of PROSE_SITES) {
    test(`${site} names every implementer in the enumeration that claims the list`, () => {
      const named = namedIn(claimSentence(site));
      expect(implementers.filter((id) => !named.includes(id))).toEqual([]);
    });

    test(`${site} names no provider that does not implement it`, () => {
      const named = namedIn(claimSentence(site));
      expect(named.filter((id) => !implementers.includes(id)).sort()).toEqual([]);
    });
  }
});
