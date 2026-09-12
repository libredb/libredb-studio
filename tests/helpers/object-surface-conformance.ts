/**
 * The assertions every provider's object surface must satisfy, in one place.
 *
 * Six invariants, each of which a provider has a real way to get wrong:
 *   1. every declared kind appears in countObjects, so a folder never silently vanishes;
 *   2. countObjects never answers for a kind the provider did not declare;
 *   3. every kind counted non-empty LISTS something, so no folder opens onto nothing;
 *   4. every object's path starts with its container's path, so the tree can address it;
 *   5. no two objects of ONE kind share a path, so that kind's folder can address each;
 *   6. describeObject accepts a path listObjects ACTUALLY PRODUCED, with its kind;
 *   7. describeObjects, where a provider declares it, describes objects listObjects NAMED,
 *      matched on path, and reports its own truncation when a bound bites.
 *
 * **Invariant 5 stops at the kind boundary, and that is a decision rather than an
 * oversight.** A tree row is identified by path PLUS kind id, not by path alone, which is
 * also why `describeObject` takes the kind: `DatabaseObject.path` promises a segment
 * unique within its PARENT, and it never promised uniqueness against a different kind's
 * namespace. Asserting across kinds is stricter than the type's contract and stricter than
 * anything downstream needs, and it would fail an engine whose namespaces really are
 * separate: MySQL keeps stored routines apart from tables, so a table and a procedure may
 * share a name in one schema and a cross-kind assertion would report that correct engine
 * as a broken provider. Do not tighten this back.
 *
 * Invariant 6 is exactly that and nothing more: a routine, a trigger and a sequence
 * legitimately have no columns, so an assertion that `columns` is non-empty would fail
 * correct providers for every kind that is not a relation.
 *
 * **Four vacuity guards, because this helper twice certified a provider that answered
 * nothing.** Measured the first time: a provider declaring `view`, reporting
 * `{view: {count: 4}}` and returning `[]` from `listObjects` passed every check, because
 * the path loop iterated zero times and `describeObject` was handed
 * `expected.sampleObject.path` - a path the TEST AUTHOR typed, which no provider had to
 * produce. Measured the second time, one kind narrower: `listObjects` was called once, for
 * the sample's kind, so a provider declaring seven kinds, counting seven and returning `[]`
 * from six was still certified. Every counted kind is listed now. Fifteen provider tasks would have been certified by a check a provider listing
 * nothing passes. So the sample object is now looked up in the returned array and the
 * FOUND object's path is what `describeObject` is given; a listing that does not contain
 * it fails by name. The same hole one level up is closed by requiring the provider to
 * declare at least one kind and the expectation to name at least one, since with neither
 * the two kind loops also iterate zero times. Both guards are derived from emptiness
 * rather than pinned to a number: a helper that asserted "seven kinds" would have to be
 * edited for every engine and would then be asserting the engine's inventory rather than
 * this contract.
 *
 * Invariant 4 replaced an assertion that `name` equals the last path segment. That is no
 * longer true and must not be: `DatabaseObject.path` addresses, `DatabaseObject.name`
 * labels, and an overloaded PostgreSQL routine is `["app", "order_total(integer)"]`
 * displayed as `order_total`. Uniqueness is what the old assertion was reaching for and
 * is the thing a tree actually needs.
 *
 * Invariant 7 is skipped entirely for a provider that does not declare `describeObjects`,
 * which is sixteen of the seventeen while the bulk read lands one family at a time. What it
 * asserts, and why each part of it is not vacuous, is in `assertBulkColumnRead()` below.
 *
 * One further check guards the caller rather than the provider: an expectation naming a
 * kind countObjects never answered for is reported by name. That is a caller-side
 * mistake, a kind id written into the expectation that this engine never declares, and
 * without the explicit throw it surfaces as `Cannot use 'in' operator ... in undefined`,
 * which names neither the kind nor the expectation.
 */
import { expect } from "bun:test";
import type { DatabaseObject, DatabaseProvider, KindCount, ObjectDetailBatch } from "@/lib/db/types";
import { callerBoundTruncationReason, declaredKinds, isCountUnavailable, relationKindIds } from "@/lib/db/object-kinds";
// The SAME key the providers and the joins use. A helper keying paths its own way could
// certify a provider whose own reader disagrees with it about what one path is.
import { pathKey } from "@/lib/db/object-path";

export interface ObjectSurfaceExpectation {
  readonly containers: readonly (readonly string[])[];
  /**
   * WHICH of the answered containers the counts, listings and the join run in.
   *
   * Absent means the first one, which is what every engine but one wants. Druid is the
   * exception and the reason this exists: it publishes five schemas and the server orders
   * them by name, so `containers[0]` is `INFORMATION_SCHEMA` and the contract ran against
   * four system tables while the datasources sat in `druid`. The flat reading is scoped to
   * `TABLE_SCHEMA = 'druid'` (`druid/introspect.ts`), so the two readings shared no name
   * and the join was reported vacuous on a provider whose join is correct.
   *
   * It is not a way out of a red. The container named must be one `listContainers`
   * ANSWERED, checked below, so an expectation cannot point the contract at a container
   * the engine does not publish.
   */
  readonly container?: readonly string[];
  readonly kinds: Readonly<Record<string, number>>;
  readonly sampleObject: { readonly path: readonly string[]; readonly kind: string };
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

export async function assertObjectSurface(
  provider: DatabaseProvider,
  expected: ObjectSurfaceExpectation,
): Promise<void> {
  const capabilities = provider.getCapabilities();
  const declared = declaredKinds(capabilities).map((kind) => kind.id);
  if (declared.length === 0) {
    throw new Error("the provider declares no object kinds, so every kind assertion below is vacuous");
  }
  if (Object.keys(expected.kinds).length === 0) {
    throw new Error("the expectation names no kinds, so no count is being checked");
  }

  const containers = await provider.listContainers!();
  expect(containers.map((container) => container.path)).toEqual(expected.containers.map((path) => [...path]));

  // An engine with no container level addresses every object at the root container.
  const container = expected.container ?? expected.containers[0] ?? [];
  if (
    expected.container !== undefined &&
    !containers.some((answered) => pathKey(answered.path) === pathKey(container))
  ) {
    throw new Error(
      `the expectation names the container ${JSON.stringify(container)}, which listContainers did not answer; ` +
        `it answered ${JSON.stringify(containers.map((answered) => answered.path))}`,
    );
  }
  const counts: Record<string, KindCount> = await provider.countObjects!(container);

  for (const id of Object.keys(counts)) {
    if (!declared.includes(id)) throw new Error(`countObjects answered for undeclared kind "${id}"`);
  }
  for (const id of declared) {
    if (!(id in counts)) throw new Error(`declared kind "${id}" is missing from countObjects`);
  }
  for (const [id, want] of Object.entries(expected.kinds)) {
    if (!(id in counts)) throw new Error(`countObjects returned nothing for expected kind "${id}"`);
    const got = counts[id];
    if (isCountUnavailable(got)) throw new Error(`kind "${id}" was unavailable: ${got.unavailable}`);
    expect(got.count).toBe(want);
  }

  // EVERY kind the expectation says is non-empty is listed, not just the sample's. Listing
  // one kind left the other six unchecked, which is how a provider that counted seven and
  // listed one was certified.
  //
  // A kind expected to hold zero is skipped, because listing nothing is the correct answer
  // there. And `objects.length === want` is deliberately NOT asserted: a count and a
  // listing are two reads at two instants and a live engine may legitimately disagree
  // between them, so pinning the magnitude would make this helper flaky rather than
  // strict. Non-emptiness is the part that cannot be a timing artefact.
  const listings = new Map<string, DatabaseObject[]>();

  for (const [id, want] of Object.entries(expected.kinds)) {
    if (want === 0) continue;
    const listed = await provider.listObjects!(container, id);
    if (listed.length === 0) {
      throw new Error(`countObjects reported ${want} of kind "${id}" and listObjects returned none`);
    }
    // Fresh per kind, deliberately. See the note above on why uniqueness stops at the
    // kind boundary.
    const seen = new Set<string>();
    for (const object of listed) {
      if (object.kind !== id) {
        throw new Error(
          `listObjects("${id}") returned an object of kind "${object.kind}": ${JSON.stringify(object.path)}`,
        );
      }
      if (!startsWith(object.path, container)) {
        throw new Error(`path ${JSON.stringify(object.path)} is not inside container ${JSON.stringify(container)}`);
      }
      const key = pathKey(object.path);
      if (seen.has(key)) {
        throw new Error(
          `two objects of kind "${id}" both answer the path ${JSON.stringify(object.path)}, so neither can be addressed`,
        );
      }
      seen.add(key);
    }
    listings.set(id, listed);
  }

  // The sample's kind need not be one the expectation counts, so list it on its own when
  // the loop above did not already reach it.
  const objects =
    listings.get(expected.sampleObject.kind) ?? (await provider.listObjects!(container, expected.sampleObject.kind));
  listings.set(expected.sampleObject.kind, objects);

  // The sample must be a path the PROVIDER produced, not one the expectation typed.
  const sample = objects.find((object) => pathKey(object.path) === pathKey(expected.sampleObject.path));
  if (sample === undefined) {
    throw new Error(
      `listObjects for kind "${expected.sampleObject.kind}" did not return the expected sample ` +
        `${JSON.stringify(expected.sampleObject.path)}; it returned ${JSON.stringify(objects.map((o) => o.path))}`,
    );
  }

  // The kind travels with the path. A caller always has it, because an object is only
  // ever reached through its kind's folder, and without it a provider has to infer what
  // it is holding from what the name happens to match.
  const detail = await provider.describeObject!(sample.path, sample.kind);
  expect(detail.path).toEqual([...sample.path]);

  await assertBulkColumnRead(provider, container, listings);
}

/**
 * The fifth method, checked against the provider's OWN listing (#789).
 *
 * Skipped entirely when the provider does not declare it, which is where sixteen of the
 * seventeen are while the bulk read lands one family at a time. That skip is the reason
 * every assertion below is written against `listings`: the only thing that makes this
 * block non-vacuous is that it compares two answers the provider gave, never one the test
 * author typed.
 *
 * Five properties, one per ruling:
 *
 *   1. one round trip per container and kind, which is the SHAPE of the call and is
 *      pinned by the argument assertion in the helper's own suite rather than here;
 *   2. keyed by `path`, so every column set must match an object `listObjects` named, by
 *      path and never by a joined name, and - the direction this helper was missing until
 *      the bulk-read review measured it - every object `listObjects` named must be in a
 *      complete batch. One-directional, a provider dropping one listed table passed the
 *      whole contract: `mysql.ts`'s `described.slice(1)` left it at 2 pass 0 fail, and the
 *      same mutation on clickhouse and duckdb was equally invisible. After Task 26b
 *      deletes the flat surface, an object missing from a bulk read is an object that
 *      exists nowhere in the product;
 *   3. truncation is reported, which is checked by bounding a read whose unbounded answer
 *      is already known to be larger - the only probe that can tell a provider that stops
 *      short and says so from one that stops short silently;
 *   4. the sentence it is reported with is the ONE sentence every engine uses for a
 *      caller's bound, `callerBoundTruncationReason()`. A non-empty reason was the old bar
 *      and eleven implementers cleared it with three unrelated phrasings. CONTAINS rather
 *      than equals, because a provider with a second bound of its own names both.
 *
 * The zero-iteration case of each loop is what the two throws guard: a provider answering
 * `{ details: [] }` for every kind satisfies every check inside them, so the richest
 * listing has to hold something, and it has to hold TWO of something or a limit of 1
 * returns the whole answer and the truncation probe can only pass.
 */
async function assertBulkColumnRead(
  provider: DatabaseProvider,
  container: readonly string[],
  listings: ReadonlyMap<string, DatabaseObject[]>,
): Promise<void> {
  const describeObjects = provider.describeObjects.bind(provider);
  const relations = new Set(relationKindIds(provider.getCapabilities()));

  /**
   * `bound` is the limit the call was given, `undefined` for an unbounded one. It is a
   * parameter rather than a closure because the two cases are checked DIFFERENTLY: only an
   * unbounded call can be held to completeness, and only an unbounded call must not report
   * a caller's bound.
   */
  function check(
    kind: string,
    batch: ObjectDetailBatch,
    addressable: ReadonlyMap<string, readonly string[]>,
    bound: number | undefined,
  ): void {
    const seen = new Set<string>();
    for (const detail of batch.details) {
      const key = pathKey(detail.path);
      if (!addressable.has(key)) {
        throw new Error(
          `describeObjects("${kind}") answered for ${JSON.stringify(detail.path)}, which listObjects did not name`,
        );
      }
      if (seen.has(key))
        throw new Error(`describeObjects("${kind}") answered twice for ${JSON.stringify(detail.path)}`);
      seen.add(key);
    }
    if (batch.truncated === undefined) {
      // The OTHER direction, and the one this helper was missing: the loop above asks
      // whether every column set was listed, and nothing asked whether every listed object
      // was described. A provider that silently drops one satisfies every check above, and
      // after Task 26b deletes the flat surface a dropped object is an object that exists
      // nowhere in the product.
      //
      // Only an UNBOUNDED and complete answer is held to this. A truncated batch is
      // legitimately short, and so is a bounded one - a bounded call that returns less and
      // says nothing is caught by name further down, where the shortfall can be reported
      // against the unbounded answer instead of against the listing.
      //
      // Recorded rather than thrown, so the two vacuity guards below still speak first: a
      // provider answering `{ details: [] }` for every kind is a vacuous fixture and not
      // one dropped object, and that distinction is what its own message carries.
      //
      // A kind that is not a RELATION is the one case an empty batch is not a drop: a
      // routine, a trigger and a package legitimately have no columns, and every provider
      // answers `{ details: [] }` for them without a round trip. That exemption is read
      // from the provider's own `role` declaration and it is narrow - it covers an empty
      // batch and nothing else, so a non-relation kind that describes SOME of its objects
      // is held to all of them. Which kinds those are is a per-engine measurement that the
      // eleven disagree on correctly: a MariaDB sequence describes and an Oracle one does
      // not, a ClickHouse dictionary describes and a function does not.
      if (bound === undefined && (relations.has(kind) || batch.details.length > 0)) {
        const missing = [...addressable].filter(([key]) => !seen.has(key)).map(([, path]) => JSON.stringify(path));
        if (missing.length > 0 && incomplete === undefined) incomplete = { kind, missing };
      }
      return;
    }
    if (batch.details.length > batch.truncated.limit) {
      throw new Error(
        `describeObjects("${kind}") reported a limit of ${batch.truncated.limit} and returned ` +
          `${batch.details.length} column sets`,
      );
    }
    if (batch.truncated.reason.length === 0) {
      throw new Error(`describeObjects("${kind}") reported truncation with no reason a person can read`);
    }
    if (bound === undefined && batch.truncated.reason.includes(callerBoundTruncationReason(batch.truncated.limit))) {
      // The escape hatch the completeness check would otherwise leave open: a provider
      // could answer short on an unbounded call and wave the truncation flag at it. A bound
      // of its OWN is legitimate there and stays certifiable - redis and libredb walk a
      // bounded keyspace and say so on an unbounded read - but the CALLER's bound is not,
      // because no caller passed one.
      throw new Error(
        `describeObjects("${kind}") was called with no limit and reported one: "${batch.truncated.reason}"`,
      );
    }
  }

  let incomplete: { kind: string; missing: string[] } | undefined;
  let richest: { kind: string; count: number } | undefined;
  for (const [kind, listed] of listings) {
    const batch = await describeObjects.call(provider, container, kind);
    check(kind, batch, new Map(listed.map((object) => [pathKey(object.path), object.path])), undefined);
    if (richest === undefined || batch.details.length > richest.count) {
      richest = { kind, count: batch.details.length };
    }
  }

  if (richest === undefined || richest.count === 0) {
    throw new Error("describeObjects answered no column set for any listed kind, so every check of it is vacuous");
  }
  // Before the fixture bar below, because a dropped object SHRINKS the richest kind: a
  // provider that describes one of two tables would otherwise be reported as a fixture
  // holding one table, which is the wrong diagnosis for the defect this guard exists for.
  if (incomplete !== undefined) {
    throw new Error(
      `describeObjects("${incomplete.kind}") reported no truncation and did not describe ` +
        `${incomplete.missing.join(", ")}, which listObjects named`,
    );
  }
  if (richest.count < 2) {
    throw new Error(
      `describeObjects answered at most one column set per kind (${richest.kind}), so no kind holds two objects, ` +
        "so a bounded read cannot be told from an unbounded one",
    );
  }

  const bounded = await describeObjects.call(provider, container, richest.kind, 1);
  check(
    richest.kind,
    bounded,
    new Map(listings.get(richest.kind)!.map((object) => [pathKey(object.path), object.path])),
    1,
  );
  if (bounded.truncated === undefined) {
    throw new Error(
      `describeObjects("${richest.kind}", limit 1) returned ${bounded.details.length} of ${richest.count} ` +
        "column sets and reported no truncation",
    );
  }
  expect(bounded.truncated.limit).toBe(1);
  // Short of its own reported bound is the same silent drop wearing the flag: the richest
  // kind holds at least two objects, so a limit of 1 has exactly one complete answer.
  if (bounded.details.length !== 1) {
    throw new Error(
      `describeObjects("${richest.kind}", limit 1) returned ${bounded.details.length} column sets under a bound ` +
        `of 1 while ${richest.count} objects were listed`,
    );
  }
  const callerSentence = callerBoundTruncationReason(1);
  if (!bounded.truncated.reason.includes(callerSentence)) {
    throw new Error(
      `describeObjects("${richest.kind}", limit 1) reported "${bounded.truncated.reason}", which does not carry ` +
        `the one sentence a caller's bound is reported with: "${callerSentence}"`,
    );
  }
}
