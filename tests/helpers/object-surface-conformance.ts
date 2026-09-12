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
 * Two further checks guard the caller rather than the provider. An expectation naming a
 * kind countObjects never answered for is reported by name. That is a caller-side
 * mistake, a kind id written into the expectation that this engine never declares, and
 * without the explicit throw it surfaces as `Cannot use 'in' operator ... in undefined`,
 * which names neither the kind nor the expectation. And a source-bearing kind the
 * expectation counts at ZERO must carry a reason in `emptyKinds`, because a zero is the one
 * count this contract reads nothing for: see that field's docblock.
 */
import { expect } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type {
  DatabaseObject,
  DatabaseProvider,
  KindCount,
  ObjectDetailBatch,
  ObjectSourceDocument,
} from "@/lib/db/types";
import {
  callerBoundTruncationReason,
  declaredKinds,
  findKind,
  isCountUnavailable,
  isSourcePartUnavailable,
  relationKindIds,
  sourceBoundTruncationReason,
} from "@/lib/db/object-kinds";
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
  /**
   * A path whose last segment names nothing, and the source-bearing kind to ask it under.
   *
   * AUTHORED rather than found, which is the deliberate asymmetry with `sampleObject`: only
   * the test author knows what is illegal or impossible on that engine, and there is by
   * definition no listing that produced it. Required whenever the provider declares a
   * source-bearing kind, and the helper throws by name when it is missing.
   */
  readonly absentSource?: { readonly path: readonly string[]; readonly kind: string };
  /**
   * WHY a source-bearing kind is expected at ZERO, one sentence per kind id.
   *
   * Required for every source-bearing kind this expectation counts at 0, or at anything else
   * that is not positive, and the helper throws by name without it. A zero is the one count that READS NOTHING: the source loop
   * walks the kinds counted above zero, so a kind at zero has its `readObjectSource` path
   * driven by no object at all while every assertion around it stays green. Naming a kind at
   * zero and naming it truthfully are two different acts, and this field is the second one.
   * An expectation that names eight of an engine's nine source-bearing kinds truthfully and
   * the ninth at zero certifies that ninth unread.
   *
   * A non-zero is deliberately NOT demanded instead, because legitimate zeros exist and this
   * repository already commits three: Trino counts `view` at 0 beside a materialized view at
   * 1 (`tests/integration/db/trino-provider.test.ts`), and Druid counts `lookup` and
   * `system_table` at 0 (`tests/integration/db/druid-provider.test.ts`). So the bar is the
   * repository's own grammar for an absence, the one `KindCount` already uses in its
   * `{ unavailable }` arm: an absence that says WHICH absence it is, in the engine's or the
   * fixture's own words.
   *
   * Write the FACT, for someone reading a red build who has never seen this engine, and write
   * it about THE CONTAINER THIS REPOSITORY STARTS rather than about the engine's defaults,
   * because the two differ and the compose service is what decides. Cassandra is the worked
   * example of getting that wrong: the 5.0 image does ship `materialized_views_enabled` and
   * `user_defined_functions_enabled` disabled, so "the Cassandra image ships materialized
   * views disabled" reads like a fact and is FALSE here, because the compose service rewrites
   * both into `cassandra.yaml` precisely so the fixture measures an engine and not a
   * configuration, and the committed expectation counts `materialized_view` at 1 and
   * `function` at 4 (`tests/integration/db/cassandra-provider.test.ts`,
   * `docs/providers/cassandra.md`). Check the fixture, then write the sentence.
   *
   * "not applicable", "n/a", "none" and "TODO" are verdicts rather than facts, and all four
   * are refused by name, as is a blank one. The helper also asks `listObjects` for the kind,
   * so a reason over a kind this fixture demonstrably holds is refused rather than reviewed:
   * the half of the sentence that is machine-decidable is decided.
   *
   * Say which of the two absences it is, because they are different facts and only the
   * sentence can tell them apart: the FIXTURE holds none of this kind today, which whoever
   * owns the fixture can close by adding one, or this DEPLOYMENT cannot hold one at all,
   * which nobody can close here. A fixture shortfall is debt and belongs in the backlog as
   * well as here; a deployment that cannot hold one is the end of the matter. One field
   * carries both honestly only if you write which one you mean.
   *
   * A reason for a kind that is NOT a source-bearing kind counted at zero is refused too, so
   * a sentence cannot outlive the absence it was written about.
   */
  readonly emptyKinds?: Readonly<Record<string, string>>;
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
    if (isCountUnavailable(got)) {
      // A kind that declares `hasSource` and answers the unavailable arm STRUCTURALLY has no
      // expectation a task can write: naming it throws here, and omitting it throws as
      // unexercised in the source check below. Two providers answer it that way already, so
      // the diagnostic names the dead end rather than leaving a wave-4 task to conclude that
      // dropping the declaration is the repair. The grammar for it is an open ruling (#789).
      const cannotBeWritten = findKind(capabilities, id)?.hasSource === true;
      throw new Error(
        `kind "${id}" was unavailable: ${got.unavailable}` +
          (cannotBeWritten
            ? `; and "${id}" declares hasSource, which this expectation shape cannot express, because naming the ` +
              "kind throws here and omitting it is refused as unexercised (#789)"
            : ""),
      );
    }
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
  await assertSourceSurface(provider, expected, container, listings);
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

/**
 * The strings a reason may NOT be, refused by name rather than only described.
 *
 * A docblock that enumerates forbidden words while the code accepts them is the weaker half
 * of a rule: a task under gate pressure writes `none`, clears every check, and the guard that
 * exists to turn a silence into a sentence has produced a different silence. Trimmed and
 * case-folded before the lookup, because `  None ` is the same non-answer.
 *
 * It is a NAMED list and not a test of meaning: a verdict spelled another way still passes,
 * and review is what catches that. What this closes is the four spellings a hurried author
 * actually reaches for.
 */
const NOT_A_REASON: ReadonlySet<string> = new Set(["not applicable", "n/a", "none", "todo"]);

/**
 * A reason may not outlive the absence it was written about.
 *
 * Runs in BOTH arms of the source check, including the one that returns early for a provider
 * implementing no source read at all, because a reason left behind when a `hasSource`
 * declaration is dropped is exactly the sentence a reader would still trust.
 */
function assertNoStaleReason(reasons: Readonly<Record<string, string>>, zeroed: readonly string[]): void {
  for (const id of Object.keys(reasons)) {
    if (!zeroed.includes(id)) {
      throw new Error(
        `emptyKinds names "${id}", which is not a source-bearing kind this expectation counts at zero, so its ` +
          "reason describes nothing",
      );
    }
  }
}

/**
 * The optional sixth method, checked against the provider's OWN listing (#789 Phase 2).
 *
 * Every path driven here is one the PROVIDER produced, for the reason `assertBulkColumnRead`
 * records: the only thing that makes an assertion about a read non-vacuous is that it compares
 * two answers the provider gave, never one the test author typed. The single exception is
 * `absentSource`, which cannot be found by definition, and which therefore carries a POSITIVE
 * CONTROL in the same helper: the loop above must already have read a document for that kind,
 * so a rejection cannot be a connection failure or a bad bind.
 *
 * The zero-iteration case of each loop is what the throws guard:
 *
 *   - the PAIRING is outside every loop, so the fifteen providers that implement nothing are
 *     certified exactly as strongly as the two that implement something: `false === false` is
 *     an assertion too, and it is the only thing standing between a declaration and a method
 *     that disagree;
 *   - a source-bearing kind the expectation never NAMES is refused by name, one notch narrower
 *     than "named none". Oracle declares nine of them and an expectation naming one would
 *     silence a "none" guard while eight kinds went unread;
 *   - a source-bearing kind the expectation counts at ZERO, or at anything else that is not
 *     positive, is exercised by nothing at all, so it must carry a reason in `emptyKinds`
 *     saying which absence it is, which is the closest a helper can come to reading a kind no
 *     object exists for. The one half of that sentence a machine can decide IS decided:
 *     `listObjects` is asked, and a reason over a kind the fixture actually holds is refused;
 *   - a reason is refused in the other direction too, and BEFORE the early return for a
 *     provider bearing no source, so a sentence cannot outlive the absence it describes;
 *   - a document of nothing but refusals answers no readable part, so the bound probe below
 *     would never run and every bound assertion would be vacuous;
 *   - a definition under two characters cannot be bounded distinguishably, which is the same
 *     bar `richest.count < 2` sets for the bulk read.
 */
async function assertSourceSurface(
  provider: DatabaseProvider,
  expected: ObjectSurfaceExpectation,
  container: readonly string[],
  listings: ReadonlyMap<string, DatabaseObject[]>,
): Promise<void> {
  const capabilities = provider.getCapabilities();
  const sourceKinds = declaredKinds(capabilities).filter((kind) => kind.hasSource === true);
  const read = provider.readObjectSource;

  // The pairing, unconditional and outside every loop. A declaration with no method behind it
  // surfaces as a 400 at runtime rather than a red build, and this is what catches it.
  if (sourceKinds.length > 0 !== (typeof read === "function")) {
    throw new Error(
      `${provider.type} declares ${sourceKinds.length} source-bearing kind(s) and ` +
        `${typeof read === "function" ? "implements readObjectSource" : "does not implement readObjectSource"}`,
    );
  }
  // BEFORE the early return, which is where this guard was wrong: a provider bearing no
  // source at all left every reason unread, so a task that dropped a `hasSource` declaration
  // and kept the sentence was not refused. `sourceKinds` is empty here by the pairing above,
  // so every reason is stale by construction.
  const reasons = expected.emptyKinds ?? {};
  if (read === undefined) {
    assertNoStaleReason(reasons, []);
    return;
  }

  const absent = expected.absentSource;
  if (absent === undefined) {
    throw new Error(
      "the provider declares a source-bearing kind and the expectation names no absentSource, so the " +
        "absence raise is never driven",
    );
  }

  // NAMED rather than counted above zero. A kind the expectation names at zero is an
  // acknowledged absence that the count assertion already pins, and a fixture holding none of
  // a declared kind is a legitimate state. A kind the expectation OMITS is the silent hole,
  // and it is the one refused here.
  //
  // WHAT THIS LEAVES OPEN, stated so no provider task has to discover it: a source-bearing
  // kind named at ZERO has its `readObjectSource` path driven by NOTHING here, because there
  // is no object of it to read, and no assertion below can close that. The remedy is the
  // FIXTURE and not this helper: build one that holds an object of every source-bearing kind
  // the engine declares. What the helper CAN do, and does immediately below, is refuse a zero
  // that does not say which absence it is, so a kind dropping out of the contract is a
  // sentence a reviewer reads rather than a silence, and ask `listObjects` whether that
  // sentence is true, which is the one half of it a machine can settle. The half it cannot is
  // a fixture author's honest sentence against a convenient one about a kind the fixture
  // really is empty of, and that stays a REVIEW obligation. The `longest === undefined` throw
  // further down bounds the damage by requiring at least one readable part from at least one
  // kind, and that is all it does.
  const unexercised = sourceKinds.filter((kind) => !Object.hasOwn(expected.kinds, kind.id)).map((kind) => kind.id);
  if (unexercised.length > 0) {
    throw new Error(
      `${provider.type} declares source-bearing kinds the expectation never exercised (${unexercised.join(", ")}), ` +
        "so every source assertion for them is vacuous",
    );
  }

  // The zero, which is the case the `unexercised` guard above deliberately lets through and
  // which nothing else here exercises. A kind counted above zero is read by the loop below;
  // a kind the expectation OMITS is refused above; a kind NAMED AT ZERO is read by nothing,
  // and until this throw it passed in silence. Requiring a non-zero would refuse correct
  // fixtures, so what is required is the reason, in the same grammar `KindCount` uses for an
  // absence. What the reason must say is on `emptyKinds` above, and that docblock is the
  // instruction every provider task reads.
  //
  // NOT `=== 0`: the predicate is the exact complement of `wanted` below, because a count
  // that is neither zero nor positive is read by nothing either and a `=== 0` test let it
  // through both guards unexplained. `unexercised` above has already refused every
  // source-bearing kind the expectation does not name, so every id reaching here is named.
  const zeroed = sourceKinds.filter((kind) => !(expected.kinds[kind.id] > 0)).map((kind) => kind.id);
  for (const id of zeroed) {
    if (!Object.hasOwn(reasons, id)) {
      throw new Error(
        `${provider.type} counts the source-bearing kind "${id}" at ${expected.kinds[id]}, which reads nothing, ` +
          `and emptyKinds carries no reason for it; say in emptyKinds["${id}"] whether this fixture holds none of ` +
          "it yet or this deployment cannot hold one at all",
      );
    }
    const reason = reasons[id].trim();
    if (reason === "") {
      throw new Error(`emptyKinds["${id}"] carries no sentence a person can read, which is not a reason`);
    }
    if (NOT_A_REASON.has(reason.toLowerCase())) {
      throw new Error(
        `emptyKinds["${id}"] is the verdict "${reason}", which states no fact; write what is absent and why, in ` +
          "the fixture's or the engine's own words",
      );
    }
    // The half of the sentence's truthfulness a machine CAN decide. The listing loop skips a
    // kind counted at zero, so nothing else here ever asks the provider whether the fixture
    // really holds none of it, and a count and a listing that disagree for one kind (which
    // this helper tolerates in MAGNITUDE on purpose, two reads at two instants) would let a
    // written claim of absence stand over an object the fixture demonstrably holds. Zero
    // against non-empty is not a magnitude.
    const listed = await provider.listObjects!(container, id);
    if (listed.length > 0) {
      throw new Error(
        `emptyKinds["${id}"] explains an absence (${JSON.stringify(reason)}) while listObjects("${id}") returned ` +
          `${listed.length} object(s), the first at ${JSON.stringify(listed[0].path)}, so the fixture holds the ` +
          "kind the reason says it does not",
      );
    }
  }
  assertNoStaleReason(reasons, zeroed);

  const wanted = new Set(sourceKinds.filter((kind) => (expected.kinds[kind.id] ?? 0) > 0).map((kind) => kind.id));
  const entered = new Set<string>();
  let longest: { kind: string; path: readonly string[]; length: number } | undefined;

  // `listings` and not `wanted` drives the walk, because `listings` is what the provider
  // actually produced. Every entry it holds for a kind the expectation counts above zero is
  // known non-empty: the listing loop threw otherwise.
  for (const [kindId, objects] of listings) {
    if (!wanted.has(kindId)) continue;
    const object = objects[0];
    const document = await read.call(provider, object.path, kindId);
    entered.add(kindId);
    assertSourceDocument(document, object, kindId, findKind(capabilities, kindId)?.sourceLanguage);
    for (const part of document.parts) {
      if (isSourcePartUnavailable(part)) continue;
      // The escape hatch a bounded probe would otherwise leave open: a provider could answer
      // short on an unbounded call and wave the flag at it. A bound of its OWN stays
      // certifiable; the CALLER's bound is not, because no caller passed one.
      if (
        part.truncated !== undefined &&
        part.truncated.reason.includes(sourceBoundTruncationReason(part.truncated.limit))
      ) {
        throw new Error(
          `readObjectSource("${kindId}") was called with no limit and reported one: "${part.truncated.reason}"`,
        );
      }
      if (longest === undefined || part.text.length > longest.length) {
        longest = { kind: kindId, path: object.path, length: part.text.length };
      }
    }
  }

  if (longest === undefined) {
    throw new Error("no source-bearing kind answered a readable part, so every source assertion is vacuous");
  }
  // A bounded probe proves nothing unless the UNBOUNDED answer is longer than the bound.
  if (longest.length < 2) {
    throw new Error(
      `the longest definition read is ${longest.length} character(s), so a bound cannot be told from no bound`,
    );
  }

  const probe = Math.floor(longest.length / 2);
  const bounded = await read.call(provider, longest.path, longest.kind, probe);
  let marked = false;
  for (const part of bounded.parts) {
    if (isSourcePartUnavailable(part)) continue;
    if (part.text.length > probe) {
      throw new Error(`readObjectSource("${longest.kind}", limit ${probe}) returned ${part.text.length} characters`);
    }
    if (part.truncated === undefined) continue;
    // The NUMBER and the SENTENCE are two facts and a provider can get one right while the
    // other is wrong. An explicit throw rather than a bare `expect`, so the test that drives
    // this can pin the MESSAGE: `.rejects.toThrow()` with no pattern passes for any throw
    // ahead of it, which is how two doubles in this file were vacuous before.
    if (part.truncated.limit !== probe) {
      throw new Error(
        `readObjectSource("${longest.kind}", limit ${probe}) reported the bound as ${part.truncated.limit}, ` +
          `which is not the limit it was given (${probe}), and that number is what a reader is shown as ` +
          "the size of the bound",
      );
    }
    const sentence = sourceBoundTruncationReason(probe);
    if (!part.truncated.reason.includes(sentence)) {
      throw new Error(
        `readObjectSource("${longest.kind}", limit ${probe}) reported "${part.truncated.reason}", which does ` +
          `not carry the one sentence a caller's bound is reported with: "${sentence}"`,
      );
    }
    marked = true;
  }
  if (!marked) {
    throw new Error(
      `readObjectSource("${longest.kind}", limit ${probe}) bounded a ${longest.length}-character definition and ` +
        "reported no truncation",
    );
  }

  // The absence, with its positive control: the loop above already resolved a document for
  // this kind, so a rejection here cannot be a connection failure or a bad bind.
  if (!entered.has(absent.kind)) {
    throw new Error(
      `absentSource names the kind "${absent.kind}", which the source loop never read, so its rejection has no ` +
        "control",
    );
  }
  let raised: unknown;
  try {
    await read.call(provider, absent.path, absent.kind);
  } catch (error) {
    raised = error;
  }
  if (!(raised instanceof QueryError)) {
    throw new Error(
      `readObjectSource did not raise for ${JSON.stringify(absent.path)}; it answered ` +
        `${raised === undefined ? "a document" : String(raised)}`,
    );
  }
  const segment = absent.path[absent.path.length - 1];
  if (!raised.message.includes(segment)) {
    throw new Error(
      `readObjectSource raised for ${JSON.stringify(absent.path)} without naming "${segment}": "${raised.message}"`,
    );
  }
}

/**
 * One document's own shape.
 *
 * A part carrying BOTH `text` and `unavailable` IS checked here, and the reason is a
 * correction of what this docblock claimed first. The claim was that the union makes the
 * shape a compile error for our own providers. MEASURED against tsc 6.0.3, with NO cast
 * anywhere: `{ id, label, text, language, form, origin, unavailable }` compiles as an
 * `ObjectSourcePart`, because TypeScript's excess-property check on a UNION admits any
 * property declared on ANY member of it, so the refusal key is legal on the readable arm.
 * `isSourcePartUnavailable` then narrows it to the refusal arm and this walk would continue
 * past every check below, certifying a well-formed refusal over a definition the engine
 * really returned. The type closes the path from a refusal to an editor buffer in ONE
 * direction only, and this throw closes the other.
 */
function assertSourceDocument(
  document: ObjectSourceDocument,
  object: DatabaseObject,
  kindId: string,
  declaredLanguage: string | undefined,
): void {
  expect(document.path).toEqual([...object.path]);
  expect(document.kind).toBe(kindId);
  const ids = new Set<string>();
  for (const part of document.parts) {
    if (ids.has(part.id)) {
      throw new Error(`two parts of ${JSON.stringify(object.path)} share the id "${part.id}"`);
    }
    ids.add(part.id);
    // BEFORE the narrowing, because the refusal branch continues past every check below it.
    if ("unavailable" in part && "text" in part) {
      throw new Error(
        `readObjectSource("${kindId}") answered a part that carries both a refusal and a text; ` +
          "a refusal and a definition are different facts and a reader must never be shown one over the other",
      );
    }
    if (isSourcePartUnavailable(part)) {
      if (part.unavailable.trim() === "") {
        throw new Error(`readObjectSource("${kindId}") answered a refusal with no sentence a person can read`);
      }
      continue;
    }
    if (part.text.trim() === "") {
      throw new Error(`readObjectSource("${kindId}") answered a part with no text, which is not a definition`);
    }
    if (declaredLanguage !== undefined && part.language !== declaredLanguage) {
      throw new Error(
        `kind "${kindId}" declares sourceLanguage "${declaredLanguage}" and the part carries "${part.language}"`,
      );
    }
  }
}
