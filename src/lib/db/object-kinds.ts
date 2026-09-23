/**
 * Pure derivations over a provider's object declarations.
 *
 * Exists so no consumer inlines a default. Every question a consumer asks about a kind
 * is answered here, in one place, so the defaults cannot drift: an absent
 * `acceptsRowWrites` reads as false in every caller because there is only one caller.
 */
import { QueryError } from "@/lib/db/errors";
import type {
  ContainerLevelSpec,
  DatabaseType,
  KindCount,
  ObjectKindSpec,
  ObjectSourcePart,
  ProviderCapabilities,
} from "@/lib/db/types";

/**
 * How many container levels this engine declares, as the tree models them.
 *
 * `>= 2` rather than `=== 2` is the CEILING, and it is stated in the type as well: since #789
 * `ContainerLevels` is a tuple union of nought, one or two levels, so a third one is a compile
 * error where a provider would write it rather than a level that exists in the declaration and
 * is read by nothing. This arm is what a cast past that type still meets, and what every
 * two-level provider's own path validation already refuses independently.
 */
export function containerDepth(capabilities: ProviderCapabilities): 0 | 1 | 2 {
  const levels = capabilities.containerLevels?.length ?? 0;
  if (levels >= 2) return 2;
  if (levels === 1) return 1;
  return 0;
}

export function declaredKinds(capabilities: ProviderCapabilities): readonly ObjectKindSpec[] {
  return capabilities.objectKinds ?? [];
}

export function findKind(capabilities: ProviderCapabilities, id: string): ObjectKindSpec | undefined {
  return declaredKinds(capabilities).find((kind) => kind.id === id);
}

/**
 * The engine half of `assertObjectPathShape`: the identity its error carries, and the one
 * policy the nine hoisted copies disagreed on.
 */
export type ObjectPathShapeEngine = {
  /** The engine code the thrown `QueryError` is stamped with. */
  code: DatabaseType;
  /** The message's opening subject, article included: "A PostgreSQL", "An Oracle". */
  label: string;
  /**
   * Whether a kind that declares `attachedTo` also admits the bare shape. MySQL and
   * Oracle answer yes; every other engine requires the attached segment.
   */
  attachedSegment: "required" | "optional";
};

/**
 * The container levels this engine declares, sliced to the depth `containerDepth()`
 * reports. The same derivation every provider kept locally; hoisted with the assert so
 * the depth rule and the level list cannot be taken by two different rules. Exported for
 * `jsonCommandAddress`, which reads a MongoDB statement's database the same way.
 */
export function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * Refuses a path no shape of this kind admits, naming every shape it does admit.
 *
 * Hoisted from nine provider-local copies (#978) that had drifted apart in more than the
 * signature. MySQL and Oracle read an attached kind by EITHER address, so they name both
 * shapes in the error and carry `attachedSegment: "optional"`; PostgreSQL, SQLite,
 * libSQL and Cassandra require the attached segment; ClickHouse, Redis and MongoDB
 * declare no attached kind, so the policy never fires for them. The engine descriptor
 * keeps those behaviours exactly as they were, because a hoist that quietly picked one
 * would change what a bare-shaped path means on four engines.
 *
 * `kind` - not `spec.id` - stays in the message because that is what seven of the nine
 * copies printed. Callers resolve the kind before this call (findKind, requireSourceKind
 * or requireEditableKind), so the spec is always in hand and this function is not the
 * kind-existence check: refusing an undeclared kind stays the caller's job, in the
 * caller's own words.
 */
export function assertObjectPathShape(
  capabilities: ProviderCapabilities,
  spec: ObjectKindSpec,
  kind: string,
  path: readonly string[],
  engine: ObjectPathShapeEngine,
): void {
  const levels = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
  const attachedTo = spec.attachedTo;
  const shapes: string[][] =
    attachedTo === undefined
      ? [[...levels, "name"]]
      : engine.attachedSegment === "optional"
        ? [
            [...levels, attachedTo, "name"],
            [...levels, "name"],
          ]
        : [[...levels, attachedTo, "name"]];
  if (shapes.some((shape) => shape.length === path.length)) return;
  throw new QueryError(
    `${engine.label} "${kind}" path is ${shapes.map((shape) => `[${shape.join(", ")}]`).join(" or ")}, ` +
      `received ${JSON.stringify(path)}`,
    engine.code,
  );
}

/**
 * The engine half of `assertContainerPathShape`: the identity its error carries, and the
 * three things the fifteen hoisted copies disagreed on.
 */
export type ContainerPathShapeEngine = {
  /** The engine code the thrown `QueryError` is stamped with. */
  code: DatabaseType;
  /** The message's opening subject, article included: "A MySQL", "An Oracle". */
  label: string;
  /**
   * Which path depths this engine accepts. `exact` takes the declared depth and nothing
   * else; `prefixes` takes every depth up to it, because a container that names only the
   * outer levels is a real address on those engines (a bucket with no scope, a catalog
   * with no schema). Both refuse a path longer than the declaration.
   */
  shapes: "exact" | "prefixes";
  /**
   * What the message prints in place of a shape list when the declaration carries no
   * container level at all. The empty join would read as a formatting bug rather than as
   * the fact it is, so each engine spells it in its own words.
   */
  emptyShapes: string;
  /**
   * Which field of a declared level spells the shape. `label` is the engine's own word for
   * a person reading a refusal, which is what most engines print; `id` is what Trino and
   * PostgreSQL print, because a declaration whose label is prose would otherwise describe
   * a shape no read accepts, since every read binds its segment by `id`. On both engines'
   * own declarations the two are the same word, so only a varied declaration shows it.
   */
  shapeNames: "id" | "label";
  /**
   * A level this engine's readers cannot work without, refused whether or not the depth
   * matches. PostgreSQL's readers bind the segment by looking the level up, so a matching
   * depth over a declaration that named no `schema` would bind `undefined` where `$1`
   * belongs, which is the failure the check exists to prevent. Absent on every engine
   * whose segments are read by position.
   */
  requireLevel?: ContainerLevelSpec["id"];
};

/**
 * The path shapes a container is addressed by, spelled for a message: `[database]`,
 * `[bucket] or [bucket, scope]`, or nothing at all for an engine that declares no level.
 *
 * An engine with no declared level accepts exactly one shape, the empty path, and prints
 * `emptyShapes` rather than `[]` when a caller sends anything else.
 */
function containerShapeNames(
  capabilities: ProviderCapabilities,
  engine: ContainerPathShapeEngine,
): readonly string[][] {
  const names = declaredLevels(capabilities).map((level) =>
    engine.shapeNames === "id" ? level.id : level.label.toLowerCase(),
  );
  // The two families differ on exactly one case, the declaration that names no level. An
  // `exact` engine accepts the empty path there, because the depth it asks for is zero; a
  // `prefixes` engine accepts nothing at all, since every prefix of an empty list is a
  // shape it never declared, and the message says so in the engine's own words.
  if (engine.shapes === "exact") return names.length === 0 ? [[]] : [names];
  return names.map((_, index) => names.slice(0, index + 1));
}

function renderContainerShapes(shapes: readonly string[][], engine: ContainerPathShapeEngine): string {
  if (shapes.length === 0 || shapes.every((shape) => shape.length === 0)) return engine.emptyShapes;
  return shapes.map((shape) => `[${shape.join(", ")}]`).join(" or ");
}

/**
 * Refuses a container path that is not one of the shapes the DECLARATION describes.
 *
 * Hoisted from fifteen provider-local copies (#1065): eleven threw on a depth mismatch and
 * four carried their own `shapeList()`, and two of those four had already drifted. The
 * depth comes from `containerDepth()` through `declaredLevels` and the segment names from
 * the declared labels, so the check and its message are the same array and nothing here
 * can inherit a hardcoded 1. An engine's own opening words, its accepted depths and its
 * empty-declaration wording travel through the descriptor, because those differ by design.
 *
 * It raises rather than reading a segment and carrying on: `undefined` bound to a
 * parameter answers an empty folder that looks exactly like a container holding nothing,
 * and a path one segment too long would bind the object's own name as the missing level.
 */
export function assertContainerPathShape(
  capabilities: ProviderCapabilities,
  container: readonly string[],
  engine: ContainerPathShapeEngine,
): void {
  const shapes = containerShapeNames(capabilities, engine);
  const named =
    engine.requireLevel === undefined || declaredLevels(capabilities).some((level) => level.id === engine.requireLevel);
  if (named && shapes.some((shape) => shape.length === container.length)) return;
  throw new QueryError(
    `${engine.label} container path is ${renderContainerShapes(shapes, engine)}, received ${JSON.stringify(container)}`,
    engine.code,
  );
}

/**
 * Whether THIS KIND accepts a row write. Absent and undeclared both read as false.
 *
 * Deliberately NOT conjoined with the engine-wide `supportsInlineRowEdit`, and the name
 * says `kind` so a caller cannot mistake the scope. That flag gates the results grid's
 * inline row editor (`canEditRows` in `src/components/Studio.tsx`), and the two row
 * menus, which need both facts for Generate Test Data, conjoin it with this function at
 * the call site. Folding it in here would answer false for three engines
 * that do take row writes: MongoDB (`src/lib/db/providers/document/mongodb.ts:635`),
 * Couchbase (`src/lib/db/providers/document/couchbase/index.ts:352`) and Cassandra
 * (`src/lib/db/providers/sql/cassandra/index.ts:256`) all declare
 * `supportsInlineRowEdit: false`, and #789 declares a kind that accepts a row write on
 * each of the three, so a conjunction would silently drop all three out of the import
 * target list.
 *
 * A caller that needs both facts writes both, which is now visible at the call site.
 */
export function kindAcceptsRowWrites(capabilities: ProviderCapabilities, id: string): boolean {
  return findKind(capabilities, id)?.acceptsRowWrites === true;
}

/**
 * The ids of the kinds the provider declared `role: "relation"`.
 *
 * The ROLE and never a list of ids written here, for the reason every other derivation in
 * this file exists: `role` is the provider's own word about its own engine, and a hardcoded
 * set would be wrong for every engine this repository has not heard of.
 *
 * Two readers, and they want it for two different reasons. `use-connection-manager.ts` names
 * these kinds when it asks the inventory route for objects, which is both a correctness fact
 * and a cost one: the flat readings hold relations and nothing else, so every routine,
 * trigger and event in a full answer is an object the join can never match and can only
 * CONTEST - measured on MySQL 26.7.0, where a table, a procedure and an event called `foo`
 * carry the identical address and the table therefore came back with no kind at all - and
 * asking for three kinds instead of seven is three listings per container instead of seven.
 * `tests/helpers/object-surface-conformance.ts` reads it to perform that same join, so the
 * guard and the app narrow their population by one rule rather than two.
 */
export function relationKindIds(capabilities: ProviderCapabilities): readonly string[] {
  return declaredKinds(capabilities)
    .filter((kind) => kind.role === "relation")
    .map((kind) => kind.id);
}

/**
 * The `readonly` in the predicate is load-bearing, not decoration. A predicate written
 * `count is { unavailable: string }` narrows the true branch and NOTHING on the false
 * branch: subtracting a constituent uses the subtype relation, which does check readonly
 * modifiers, so `{ readonly unavailable: string }` survives the subtraction and every
 * caller is left holding the whole union with no `.count` on it. Measured against
 * TypeScript 6.0.3.
 */
export function isCountUnavailable(count: KindCount): count is { readonly unavailable: string } {
  return "unavailable" in count;
}

/**
 * Whether a number is a FLOOR rather than a total, because the provider counted what a
 * bounded read saw.
 *
 * The `readonly` is load-bearing for the reason `isCountUnavailable` records, and the
 * predicate asks for the FIELD rather than for a flag: `sampledFrom` is the only thing
 * that separates this member from the plain `{ count }` beside it in the union, and an
 * implementer that omits it is saying the number is a population.
 *
 * Callers that only need the number do not need this at all, which is the point of the
 * variant being additive: `count.count` narrows on both members. It is the RENDERER that
 * needs it, because "1,204 tables" and "at least 1,204 key groupings" are different facts
 * and the badge is the only place a person meets either (#789).
 */
export function isCountSampled(count: KindCount): count is { readonly count: number; readonly sampledFrom: string } {
  return "sampledFrom" in count;
}

/**
 * The one sentence every provider reports a CALLER's bulk-read bound with (#789).
 *
 * `ObjectDetailBatch.truncated.reason` is a sentence a person reads beside a partial
 * answer, and once the flat surface is gone it is the ONLY sentence explaining why an
 * answer is short. Eleven implementers wrote three unrelated phrasings for one event
 * ("column read limit reached", "the caller's limit on one <Engine> bulk column read",
 * and this one), so the same bound read three ways depending on which engine was open.
 * This is the shape that won, for two reasons that are not taste: it carries the NUMBER
 * that bit, which the terse spelling drops and a reader cannot recover, and it names no
 * engine, so there is nothing per-provider left to spell differently.
 *
 * It is a function rather than a constant because the number is the caller's and changes
 * per call, and it is here rather than in each provider because fourteen copies of a
 * sentence is how the three phrasings happened.
 *
 * A provider that applies a SECOND bound of its own - redis and libredb walk a bounded
 * keyspace - names that one in its own words and joins the two, because they are two
 * different bounds rather than two phrasings of one. The shared conformance guard asks
 * only that a caller-bounded batch's reason CONTAIN this sentence, never that it equal
 * it, so a composed sentence satisfies it.
 */
export function callerBoundTruncationReason(limit: number): string {
  return `the bulk column read was bounded at ${limit} object${limit === 1 ? "" : "s"} by its caller`;
}

/**
 * Whether THIS KIND has a readable definition (#789 Phase 2).
 *
 * Absent and undeclared both read as FALSE, and the name says the scope so a caller cannot
 * inline the default. It is NOT conjoined with anything, for the same reason
 * `kindAcceptsRowWrites` is not: the per-object question is a different one, and only the READ
 * can answer it. Four kinds in the fleet are readable for some of their objects and not
 * others, and this answers for the kind.
 */
export function kindHasSource(capabilities: ProviderCapabilities, id: string): boolean {
  return findKind(capabilities, id)?.hasSource === true;
}

/**
 * Whether THIS KIND has columns (#789, columns under an object row).
 *
 * Absent and undeclared both read as FALSE, and the name says the scope so a caller cannot inline
 * the default. It takes the SPEC rather than `(capabilities, id)` like its siblings, because both
 * readers already hold one: the tree walk holds the folder's spec, and the conformance guard
 * iterates them. A caller holding only an id passes `findKind(capabilities, id)` straight in.
 */
export function kindHasColumns(kind: ObjectKindSpec | undefined): boolean {
  return kind?.hasColumns === true;
}

/**
 * Whether THIS KIND accepts an edited definition back (#789 Phase 3).
 *
 * Absent and undeclared both read as FALSE, and it is NOT conjoined with `hasSource` for the
 * reason `kindHasSource` is not conjoined with anything: a kind that declared an edit and no
 * source is a broken DECLARATION, and the census refuses it by name. A derivation that hid it by
 * answering false would take the only guard that can see it away.
 */
export function kindAcceptsSourceEdits(capabilities: ProviderCapabilities, id: string): boolean {
  return findKind(capabilities, id)?.acceptsSourceEdits === true;
}

/**
 * The narrowing predicate for a refused part (#789 Phase 2).
 *
 * The `readonly` on every member is LOAD-BEARING and measured against TypeScript 6.0.3: a
 * predicate written without it narrows the true branch and NOTHING on the false branch, so
 * every caller is left holding the whole union with no `.text` on it. The one-property spelling
 * `isCountUnavailable` uses does not compile here at all, because `ObjectSourcePart` has three
 * required members on the refused arm, and that red build is the safe direction.
 */
export function isSourcePartUnavailable(
  part: ObjectSourcePart,
): part is { readonly id: string; readonly label: string; readonly unavailable: string } {
  return "unavailable" in part;
}

/** The default per-part character bound the source route applies when a caller names none. */
export const SOURCE_CHARACTER_LIMIT = 1_000_000;

/**
 * The most parts one document may carry before the route refuses it.
 *
 * The tuple type has no upper bound and the shipped maximum is two (an Oracle or MariaDB
 * package), but the embedded seam takes its document from a HOST outside our compiler, so the
 * real response size is `SOURCE_CHARACTER_LIMIT` times `parts.length` unless something bounds
 * the count. Four times the largest shape any engine produces, so no correct provider can
 * reach it.
 */
export const SOURCE_PART_LIMIT = 8;

/**
 * The ONE sentence a caller's source bound is reported with (#789 Phase 2).
 *
 * A function beside `callerBoundTruncationReason` rather than a reuse of it: the two bound
 * different things and the existing sentence names objects. One place for the same reason that
 * one records, which is that eleven implementers wrote three unrelated phrasings for one event
 * before it was written down.
 */
export function sourceBoundTruncationReason(limit: number): string {
  return `the source read was bounded at ${limit.toLocaleString("en-US")} characters by its caller`;
}

/**
 * One part's text under a caller's bound, with the mark the bound owes (#789 Phase 2).
 *
 * Hoisted here rather than written sixteen times, on the evidence that `comparePaths` was
 * written four times before anyone owned it. An exact answer is NEVER marked, which is the
 * rule `sampledFrom` already follows verbatim, because marking one teaches a reader to
 * discount every mark.
 */
export function applySourceBound(
  text: string,
  limit: number | undefined,
): { readonly text: string; readonly truncated?: { readonly limit: number; readonly reason: string } } {
  if (limit === undefined || text.length <= limit) return { text };
  const cut = text.slice(0, limit);
  // The bound counts UTF-16 CODE UNITS, so it can land BETWEEN the two halves of a surrogate
  // pair, and an astral character is exactly that: a PL/pgSQL body or a Lua library holding an
  // emoji, cut at that offset, would end in an unpaired high surrogate. That is not a
  // character, JSON serializes it as a lone escape and Monaco draws a replacement glyph, so
  // the pair is dropped whole. The last unit of the cut can only BE a high surrogate when its
  // low half sits at `limit` in the original, because this arm runs only when the text is
  // longer than the bound. `truncated.limit` still names the CALLER's number rather than the
  // emitted length: the bound is what was asked for, and reporting anything else describes a
  // bound nobody set.
  const last = cut.charCodeAt(cut.length - 1);
  const kept = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return { text: kept, truncated: { limit, reason: sourceBoundTruncationReason(limit) } };
}

/**
 * The entry guard every `readObjectSource` opens with, in ONE place (#789 Phase 2).
 *
 * Hoisted in the same spirit as `applySourceBound` above it and for the same measured reason
 * standing ruling 5h gives for `comparePaths`: this preamble was written NINE times, verbatim,
 * across `sqlite`, `libsql`, `clickhouse`, `cassandra`, `trino`, `postgres`, `mssql`, `mysql`
 * and `duckdb`, and SonarCloud's duplication report on PR #820 named one of its copies as a
 * block repeating across five providers at once. The only thing that ever differed between the
 * nine was the engine's display name and its type id, so both are arguments.
 *
 * THREE SEPARATE FACTS, THREE SEPARATE SENTENCES, and collapsing them would lose a distinction
 * a caller acts on. A kind the engine never declared is a caller asking for something that does
 * not exist here; a declared kind with no `hasSource` is the engine having no such text at all;
 * a source-bearing kind with no `sourceLanguage` is a DECLARATION missing half of itself, and
 * it raises rather than defaulting because an unregistered or absent Monaco id degrades to
 * plain text with no throw and nothing observable, so a kind that declared source and forgot
 * its language would ship a Source tab that had quietly stopped highlighting. The wording of
 * all three is carried over unchanged from the nine copies, because the provider suites assert
 * on those sentences and a reworded throw would be a behaviour change hiding inside a hoist.
 *
 * THE ENGINE IS ONE ARGUMENT rather than two adjacent strings: `displayName` and `type` are
 * both strings, a positional pair of them can be swapped silently, and an object at the call
 * site names each one. There is no display-name registry to read either from: `compatibility.ts`
 * holds no such map and `ProviderLabels` carries entity words rather than a product name, so
 * inventing one to serve one message would be a larger change than this one. Each provider
 * already writes its own name as a literal and passes that literal.
 *
 * The return narrows `sourceLanguage` to `string`, which is the whole point of the third throw:
 * the caller reads `spec.sourceLanguage` with no `??` and no second undefined check.
 */
export function requireSourceKind(
  capabilities: ProviderCapabilities,
  kind: string,
  engine: { readonly displayName: string; readonly type: DatabaseType },
): ObjectKindSpec & { readonly sourceLanguage: string } {
  const spec = findKind(capabilities, kind);
  if (spec === undefined) {
    throw new QueryError(`${engine.displayName} declares no object kind "${kind}"`, engine.type);
  }
  if (spec.hasSource !== true) {
    throw new QueryError(`${engine.displayName} publishes no definition text for the kind "${kind}"`, engine.type);
  }
  const { sourceLanguage } = spec;
  if (sourceLanguage === undefined) {
    throw new QueryError(
      `${engine.displayName} declares readable source for the kind "${kind}" and no sourceLanguage to render it with`,
      engine.type,
    );
  }
  return { ...spec, sourceLanguage };
}

/**
 * The entry guard every `buildObjectEdit` opens with, in ONE place (#789 Phase 3).
 *
 * Hoisted before the first provider is written, rather than after nine copies of it exist:
 * `assertObjectPathShape` is written out eight times in this tree (D67) and `requireSourceKind`
 * exists because nine copies of the same preamble tripped the duplication gate on PR #820 (D69).
 * Three providers will call this one on day one and a later phase adds more.
 *
 * THREE SEPARATE FACTS, THREE SEPARATE SENTENCES, and collapsing them would lose a distinction a
 * caller acts on: a kind the engine never declared, a declared kind this engine will not write
 * back, and an editable kind with no `sourceLanguage`, which is a DECLARATION missing half of
 * itself. The third raises rather than defaulting for the reason `requireSourceKind` gives: an
 * unregistered or absent Monaco id degrades to plain text with no throw and nothing observable.
 *
 * THE ENGINE IS ONE ARGUMENT rather than two adjacent strings, for `requireSourceKind`'s measured
 * reason: both are strings, a positional pair of them can be swapped silently, and an object at
 * the call site names each one.
 */
export function requireEditableKind(
  capabilities: ProviderCapabilities,
  kind: string,
  engine: { readonly displayName: string; readonly type: DatabaseType },
): ObjectKindSpec & { readonly sourceLanguage: string } {
  const spec = findKind(capabilities, kind);
  if (spec === undefined) {
    throw new QueryError(`${engine.displayName} declares no object kind "${kind}"`, engine.type);
  }
  if (spec.acceptsSourceEdits !== true) {
    throw new QueryError(
      `${engine.displayName} does not apply an edited definition for the kind "${kind}"`,
      engine.type,
    );
  }
  const { sourceLanguage } = spec;
  if (sourceLanguage === undefined) {
    throw new QueryError(
      `${engine.displayName} declares an editable kind "${kind}" and no sourceLanguage to render it with`,
      engine.type,
    );
  }
  return { ...spec, sourceLanguage };
}
