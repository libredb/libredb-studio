import { EDIT_BODY_BYTE_LIMIT, planExecutableLength } from "@/lib/db/object-edit";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import type {
  ObjectEditConsequenceClass,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditPreimage,
  ObjectEditRefusal,
  ObjectEditRefusalClass,
  ObjectEditStrategy,
  ObjectEditUnit,
} from "@/lib/db/types";

/**
 * The wire types and shape checks for the object edit path (#789 Phase 3, discussion #778).
 *
 * NO SERVER IMPORT IN THIS FILE. The browser narrows a HOST's answer with the same predicates the
 * route narrows a provider's answer with, and a predicate that lived beside the plan token would
 * drag `jose` and `node:crypto` into the client bundle. The two VALUE imports above are within
 * that rule and are checked rather than assumed: `object-edit.ts` and `object-kinds.ts` reach
 * `errors.ts` and `api/error-codes.ts` and nothing else, and both are already imported by the
 * client components in `src/components/object-source/`. The rule used to hold BY CONSTRUCTION,
 * when every import here was type-only, and now holds by a property of files that grow, so
 * `tests/unit/lib/api/object-edit-wire.test.ts` walks the closure and fails on the first bare
 * value import anywhere in it.
 *
 * Every predicate asserts EXACTLY the properties of the arm its discriminant names and refuses any
 * other own STRING-KEYED property, enumerable or not (see `hasExactKeys` for why the distinction is
 * load-bearing and why symbols are left alone), because the type cannot: MEASURED against tsc 6.0.3 and recorded on
 * `ObjectSourcePart` in `src/lib/db/types.ts`, a literal carrying the properties of two arms of a
 * union compiles with no cast, since the excess-property check on a union admits any property
 * declared on ANY member of it. So a command unit carrying `steps`, an outcome that succeeded and
 * conflicted, and an `unavailable` revision carrying a token are all representable, and a runtime
 * refusal at a named boundary is the only thing that stops them.
 *
 * What that costs if it is missing: a read that lies shows the wrong text, and an apply that lies
 * tells a reader their change landed when it did not.
 *
 * Every level is walked. `Array.isArray` alone accepts `[null]`, which is this repository's own
 * hard-learned rule that a cast is not a check.
 */

/**
 * The one type that is NOT published: a host returns `ObjectEditBuild` and has no key to seal
 * with, so `planToken` is optional here and required nowhere.
 */
export type ObjectEditBuildResponse =
  | {
      readonly built: true;
      readonly plan: ObjectEditPlan;
      readonly preimage: ObjectEditPreimage;
      readonly planToken?: string;
    }
  | { readonly built: false; readonly refusal: ObjectEditRefusal };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A record whose own keys are exactly `required`, plus any subset of `optional` and nothing else.
 *
 * This is the helper that makes "exactly the properties of the arm the discriminant names" true,
 * and dropping the second half of it is what lets every hybrid through.
 *
 * THE EXCLUSION ARM READS `Object.getOwnPropertyNames` AND NOT `Object.keys`, and that is the
 * whole of the check rather than a preference. MEASURED against the first draft of this module: a
 * command unit carrying `Object.defineProperty(unit, "steps", { value: [step], enumerable: false })`
 * passed `isObjectEditUnitShape`, an `applied` outcome carrying a non-enumerable `conflict` getter
 * passed `isObjectEditOutcomeShape`, and a `built: true` response carrying a non-enumerable
 * `refusal` passed `isObjectEditBuildResponseShape`, because `Object.keys` returns only the
 * ENUMERABLE own keys while `value.conflict` reads the hidden one. The live population is precisely
 * the one this module was written for, the EMBEDDED seam, where the host's answer is a live JS
 * object: `JSON.parse` cannot produce a non-enumerable own property, so the route path never had it.
 *
 * Symbol-keyed own properties are NOT refused, and that is also deliberate. Every read in this
 * module and in every consumer of these shapes is by string key, so a symbol cannot be the second
 * half of a hybrid, and refusing one would reject a host object some wrapper had tagged.
 */
function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const own = Object.getOwnPropertyNames(value);
  if (!required.every((key) => own.includes(key))) return false;
  return own.every((key) => required.includes(key) || optional.includes(key));
}

/** A string that carries a fact, rather than one that is present and says nothing. */
function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * EVERY STRING THIS MODULE ACCEPTS IS BOUNDED, and this pair of helpers is where (D80).
 *
 * The strings are not this application's prose. A refusal `sentence` is the ENGINE's own message,
 * `libraryFact` in `src/lib/db/providers/keyvalue/redis.ts` builds a consequence's `observed` from
 * `FUNCTION LIST`, and a `revision.basis` or a `truncated.reason` is whatever the provider wrote.
 * MEASURED 2026-09-14 and recorded in D80: every bound the two edit routes enforce is on what they
 * RECEIVE, so without these helpers a producer's answer reaches the dialog's DOM at whatever
 * length it was written at, on the standalone path as well as the embedded one.
 *
 * TWO NUMBERS AND BOTH ALREADY EXIST, which is deliberate: a third constant here would be a third
 * place for the same question to be answered differently.
 *
 * - `SOURCE_CHARACTER_LIMIT` (1,000,000) bounds every PROSE and IDENTIFIER string, and it is the
 *   number Phase 2's `isSourceDocumentShape` already bounds its four host-supplied rendered
 *   strings with (`src/components/object-source/source-reader.ts`). A block of definition text,
 *   `preimage` and a conflict's `current`, takes the same number for the reason `object-edit.ts`
 *   gives for `EDIT_CHARACTER_LIMIT`: it is a part as a READ may answer it.
 * - `EDIT_BODY_BYTE_LIMIT` (8,388,608) bounds the unit's EXECUTABLE text, measured with
 *   `planExecutableLength` and applied to the WHOLE unit rather than to one step. Why the BODY
 *   bound and not `EDIT_PLAN_EXECUTABLE_LIMIT`, which is the number that names this quantity, is
 *   written out in `isWithinTheExecutableBound`: it is about which seam gets to say the sentence.
 *
 * A provider SEGMENT's text needs no bound of its own: `spansTheText` proves those bytes ARE the
 * step's bytes at that offset, so the executable bound is already the segment's bound.
 *
 * AN OVERRUN IS A REFUSED SHAPE, never a silent truncation, which is `isSourceDocumentShape`'s own
 * rule at the matching seam: this module cannot cut an engine's sentence honestly, so it says the
 * producer answered a body it cannot read.
 */
function isBoundedString(value: unknown): value is string {
  return isFilledString(value) && value.length <= SOURCE_CHARACTER_LIMIT;
}

/** A string that may be empty and still may not be unbounded: a text, a pinned setting's value. */
function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length <= SOURCE_CHARACTER_LIMIT;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isBoundedText);
}

/** A 0-based UTF-16 offset into the user's part text: an integer, never negative, never a NaN. */
function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isDuration(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The three accepted-value lists, each derived from a FULL keyed record of its union.
 *
 * `Object.keys(... satisfies Record<Union, true>)` and not `[...] satisfies readonly Union[]`, and
 * the difference is the whole point. MEASURED with this repository's tsc 6.0.3 on a standalone
 * probe: `const L: readonly string[] = ["a", "b"] satisfies readonly ("a" | "b" | "c")[]` compiles
 * SILENTLY, so the array form catches a misspelling (TS2322) and NOT a union that grew a member
 * the list does not carry. The same probe in the keyed form fails the build both ways: a missing
 * member is TS1360 ("Property 'c' is missing") and an extra one is TS2353.
 *
 * What that buys, in the failure it prevents: a later phase adds a seventh `ObjectEditStrategy`,
 * nobody updates this file, and typecheck, lint and the 100 percent line gate all stay green while
 * every plan carrying the new strategy is refused at this seam and the feature silently does not
 * work for that engine.
 */
const STRATEGIES: readonly string[] = Object.keys({
  "guarded-atomic-batch": true,
  "transactional-replace": true,
  "replace-in-place-statement": true,
  "replace-in-place-command": true,
  "alter-in-place": true,
  "temp-name-test-create": true,
} satisfies Record<ObjectEditStrategy, true>);

const CONSEQUENCE_CLASSES: readonly string[] = Object.keys({
  "replaces-whole-container": true,
  "destroys-sibling-part": true,
  "destroys-overloads": true,
  "destroys-index": true,
  "destroys-comment": true,
  "forks-object": true,
  "transfers-security-principal": true,
  "changes-module-semantics": true,
} satisfies Record<ObjectEditConsequenceClass, true>);

const REFUSAL_CLASSES: readonly string[] = Object.keys({
  identity: true,
  privilege: true,
  definition: true,
  guard: true,
  unsupported: true,
} satisfies Record<ObjectEditRefusalClass, true>);

/**
 * One piece of the executed text and where it came from.
 *
 * The user arm is a half-open range over the user's own text, so `start <= end` is the invariant
 * and a reversed range is refused rather than clamped: a reversed range renders as an empty slice
 * and would silently drop the user's bytes out of a preview that claims to show what executes.
 */
function isSegment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.from === "provider") {
    return hasExactKeys(value, ["from", "text"]) && typeof value.text === "string";
  }
  if (value.from === "user") {
    if (!hasExactKeys(value, ["from", "start", "end"])) return false;
    if (!isOffset(value.start) || !isOffset(value.end)) return false;
    return value.start <= value.end;
  }
  return false;
}

/**
 * The map is checked AGAINST the bytes, which is ruling 1a at the only boundary this seam has.
 *
 * `ObjectEditStep.text` is authoritative: it is what the engine receives. `segments` is what the
 * dialog renders and what `userPositionOf` converts a coordinate through. A step whose map does
 * not correspond to its own text is a preview that shows one thing while the engine gets another,
 * and it is checkable FROM THE STEP ALONE, with no input this predicate does not already hold:
 *
 * - laid end to end, the segments must span the text EXACTLY, so
 *   `sum(provider text lengths) + sum(end - start) === text.length`;
 * - every PROVIDER segment's bytes are fully determined, so the text at that segment's computed
 *   offset must BE those bytes. This subsumes the whole-step case: a step with no user segment is
 *   completely determined by its map and must equal it.
 *
 * Only the user segments are unverifiable here, because this module never sees the reader's text.
 *
 * MEASURED against the first draft, which checked neither: a step
 * `{ text: "DROP DATABASE prod", segments: [{ from: "provider", text: "SELECT 1" }] }` was accepted,
 * and `renderSegments("", segments)` answered "SELECT 1" while the engine would have received
 * "DROP DATABASE prod". A second, `{ text: <34 chars>, segments: [{ from: "user", start: 0,
 * end: 999999 }] }`, was accepted, and `userPositionOf(step, 5)` then answered a line and column
 * computed off a map overrunning its own text by 999,965 units.
 */
function spansTheText(text: string, segments: readonly unknown[]): boolean {
  let cursor = 0;
  for (const segment of segments) {
    const piece = segment as Record<string, unknown>;
    if (piece.from === "provider") {
      const written = piece.text as string;
      if (text.slice(cursor, cursor + written.length) !== written) return false;
      cursor += written.length;
      continue;
    }
    cursor += (piece.end as number) - (piece.start as number);
  }
  return cursor === text.length;
}

/**
 * One statement or one command payload.
 *
 * `segments` is required to be non-empty. A step whose map is empty cannot be rendered as a
 * preview at all, and it is the population a "every segment is valid" loop certifies nothing over
 * when it runs zero times.
 *
 * `text` IS BOUNDED, one level out: the unit sums it across every step and checks the total
 * against `EDIT_BODY_BYTE_LIMIT` (see `isWithinTheExecutableBound`, which says why that constant
 * and not the tighter one), because the quantity being bounded is the whole unit's executable
 * text and not one step's.
 */
function isStep(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["text", "language", "segments"])) return false;
  if (typeof value.text !== "string") return false;
  if (!isBoundedString(value.language)) return false;
  if (!Array.isArray(value.segments) || value.segments.length === 0) return false;
  if (!value.segments.every(isSegment)) return false;
  return spansTheText(value.text, value.segments);
}

/**
 * The unit's executable text, bounded here as a BACKSTOP and deliberately looser than the routes
 * (D80).
 *
 * `planExecutableLength` rather than a sum written out here, so the two cannot drift: the command
 * arm counts the name and the argument tokens as well as the payload, and a second copy of that
 * arithmetic would be a second answer to one question. The cast is safe at this call site and
 * nowhere else: every field the function reads has just been proved a string or an array of them
 * by the arm above it.
 *
 * WHY `EDIT_BODY_BYTE_LIMIT` AND NOT `EDIT_PLAN_EXECUTABLE_LIMIT`, which is the constant whose own
 * docblock names this exact quantity. Both edit routes call this predicate FIRST and measure the
 * executable length SECOND, and the second check is the one that can say what is wrong: "this
 * apply would send N characters and this server sends at most 1,200,000", with the number in it.
 * MEASURED: with this bound set to `EDIT_PLAN_EXECUTABLE_LIMIT`, a unit one character over it was
 * refused here instead and both routes answered "the build answered a plan this server cannot read
 * as a plan", which is a shape complaint about a size problem. A bound that takes a better
 * sentence away is a regression whatever it protects, so the wire's ceiling sits strictly above
 * the routes' and catches only what no route could have delivered at all.
 *
 * The number is honest at that job rather than borrowed for it: `EDIT_BODY_BYTE_LIMIT` is the
 * whole request body in BYTES, one UTF-16 code unit is at least one UTF-8 byte, so an executable
 * text longer than this many characters cannot have come through either route's body.
 *
 * WHAT IT IS AND IS NOT, because an earlier form of this docblock claimed a live uncounted seam and
 * that claim is FALSE in this tree. Every one of the four call sites has a tighter count in front
 * of it, so this predicate cannot answer `false` today:
 * - `edit-apply/route.ts` reads the body through `readBoundedJson` at `EDIT_BODY_BYTE_LIMIT` BYTES
 *   before the parse, and the unit is a fragment of that body;
 * - `edit-plan/route.ts` narrows a plan a provider built from text already bounded at
 *   `EDIT_CHARACTER_LIMIT`, and measures the same unit against `EDIT_PLAN_EXECUTABLE_LIMIT` on the
 *   very next line;
 * - the standalone `ObjectSourceView` narrows what those two routes answered;
 * - the embedded shell counts the WHOLE host answer at `EDIT_PLAN_EXECUTABLE_LIMIT * 2 +
 *   SOURCE_CHARACTER_LIMIT * 2` = 4,400,000 characters, as it snapshots it
 *   (`src/workspace/hooks/use-connection-adapter.ts`), which is tighter than this for the answer
 *   entire, let alone for the unit inside it.
 * So this is a CEILING held above every bound in front of it and nothing else: it exists so that a
 * fifth caller, or any of those four losing its own count, meets a number here rather than handing
 * an unbounded executable text to the dialog. The `SOURCE_CHARACTER_LIMIT` bounds elsewhere in this
 * module are NOT in that position and do bite today: a 2,000,000-character `refusal.sentence`
 * passes the embedded answer bound and both routes' body bounds and is refused here.
 *
 * `EDIT_PLAN_EXECUTABLE_LIMIT` stays the product's answer and is enforced, with its sentence, at
 * both routes and in `ApplyPreviewDialog`'s refusal to draw a diff above it.
 */
function isWithinTheExecutableBound(unit: Record<string, unknown>): boolean {
  return planExecutableLength(unit as unknown as ObjectEditUnit) <= EDIT_BODY_BYTE_LIMIT;
}

/**
 * The exact artifact ONE apply sends.
 *
 * The hybrid this refuses is a `command` unit that also carries `steps`. The compiler admits it,
 * and a preview that rendered the steps while the apply sent the command payload would be the
 * exact failure ruling 1a exists to prevent.
 */
export function isObjectEditUnitShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.medium === "statement") {
    if (!hasExactKeys(value, ["medium", "steps"])) return false;
    if (!Array.isArray(value.steps) || value.steps.length === 0) return false;
    if (!value.steps.every(isStep)) return false;
    return isWithinTheExecutableBound(value);
  }
  if (value.medium === "command") {
    if (!hasExactKeys(value, ["medium", "name", "arguments", "payload"])) return false;
    if (!isBoundedString(value.name)) return false;
    if (!isStringArray(value.arguments)) return false;
    if (!isStep(value.payload)) return false;
    return isWithinTheExecutableBound(value);
  }
  return false;
}

/**
 * The three revision states H3 requires, with the third said out loud.
 *
 * An `unavailable` revision carrying a token is refused. It is the two-state collapse wearing the
 * three-state type: a reader who sees a token believes a check happened.
 */
function isRevision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.check === "guarded" || value.check === "compared") {
    if (!hasExactKeys(value, ["check", "token", "basis", "scope"])) return false;
    if (!isBoundedString(value.token) || !isBoundedString(value.basis)) return false;
    return value.scope === "server" || value.scope === "connection";
  }
  if (value.check === "unavailable") {
    return hasExactKeys(value, ["check", "reason"]) && isBoundedString(value.reason);
  }
  return false;
}

/** A session setting the plan depends on: `asserted` compares and never writes, `pinned` writes. */
function isSessionPin(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.mode !== "asserted" && value.mode !== "pinned") return false;
  if (!hasExactKeys(value, ["mode", "setting", "value"])) return false;
  return isBoundedString(value.setting) && isBoundedText(value.value);
}

/**
 * What a SUCCESSFUL apply of this shape destroys, and the catalog fact it was read from.
 *
 * `observed` MUST be non-empty. `""` is the shape a provider reaches for when the catalog read
 * came back NULL and it wants to warn anyway, and a NULL comment means NO consequence rather than
 * an empty one. A warning built from an empty read is an inference in a measurement's voice,
 * which is the one thing ruling 1b will not let a provider ship.
 */
function isConsequence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["loses", "fact"])) return false;
  if (!CONSEQUENCE_CLASSES.includes(value.loses as string)) return false;
  const fact = value.fact;
  if (!isRecord(fact)) return false;
  if (!hasExactKeys(fact, ["source", "observed"])) return false;
  return isBoundedString(fact.source) && isBoundedString(fact.observed);
}

/**
 * Where a refusal points, in the coordinates of the text the USER submitted.
 *
 * Three arms and not an optional pair. 1-based on both axes, which is what Monaco's
 * `IMarkerData.startLineNumber` and `startColumn` take, and a coordinate the provider could not
 * place inside the user's own text is `outside` rather than a number Monaco will silently clamp.
 *
 * WHICH HALF OF THE CLAMPING HAZARD THIS CLOSES, said plainly rather than left to read as both.
 * Monaco clamps in two directions and this boundary can only see one of them. It refuses a 0,
 * which is not a coordinate a 1-based `IMarkerData` can place at all and which Monaco snaps to the
 * first character. It CANNOT refuse a line past the end of the model: nothing in this module is
 * given the model, so `{ within: "user", line: 1e9, column: 1 }` is accepted here and Monaco
 * clamps it to the end of the model, and there is a test asserting exactly that. The far side of
 * that hazard belongs to whoever sets the markers, against a model whose length it can read.
 */
function isPosition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.within === "user") {
    if (!hasExactKeys(value, ["within", "line", "column"])) return false;
    return isOffset(value.line) && value.line >= 1 && isOffset(value.column) && value.column >= 1;
  }
  if (value.within === "outside" || value.within === "none") {
    return hasExactKeys(value, ["within"]);
  }
  return false;
}

/**
 * Why a build would not issue a plan, or why an apply was refused.
 *
 * `at` is REQUIRED, and its third arm is the only way to say "no coordinate". An absent `at` would
 * leave the dialog with nothing to render and the marker code with nothing to refuse.
 */
function isObjectEditRefusalShape(value: unknown): value is ObjectEditRefusal {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["refusal", "sentence", "at"], ["code", "hint"])) return false;
  if (!REFUSAL_CLASSES.includes(value.refusal as string)) return false;
  if (!isBoundedString(value.sentence)) return false;
  if (Object.hasOwn(value, "code") && !isBoundedString(value.code)) return false;
  if (Object.hasOwn(value, "hint") && !isBoundedString(value.hint)) return false;
  return isPosition(value.at);
}

/** The truncation mark. Its `reason` is rendered verbatim, so a mark with no reason is refused. */
function isTruncation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["limit", "reason"])) return false;
  return typeof value.limit === "number" && Number.isFinite(value.limit) && isBoundedString(value.reason);
}

/**
 * A block of definition text with the language it is highlighted as: the build's pre-image, and
 * the conflict outcome's current server text. `text` may be empty, because an object whose part
 * read back empty is a fact the diff has to be able to show.
 */
function isTextBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["text", "language"], ["truncated"])) return false;
  if (!isBoundedText(value.text)) return false;
  if (!isBoundedString(value.language)) return false;
  if (Object.hasOwn(value, "truncated") && !isTruncation(value.truncated)) return false;
  return true;
}

const PLAN_KEYS: readonly string[] = [
  "planVersion",
  "planId",
  "issuedAt",
  "connectionFingerprint",
  "type",
  "path",
  "kind",
  "partId",
  "strategy",
  "unit",
  "session",
  "revision",
  "consequences",
];

/**
 * The plan, which is the thing ruling 1a binds the preview to the apply with.
 *
 * All thirteen fields are required and no fourteenth is admitted. `planVersion` is pinned to 1
 * here as well as in the digest walk, so a plan minted by a process with a different walk is
 * refused rather than mis-verified. A plan with no `revision` is the two-state collapse H3
 * forbids and is refused at this boundary, not tolerated one level in.
 *
 * WHAT THIS PREDICATE DOES NOT CHECK, stated so a consumer does not read the narrowing as more
 * than it is. `ObjectEditPlan.type` is `DatabaseType`, and the check here is the brief's, a filled
 * string: MEASURED, `isObjectEditPlanShape({ ...plan, type: "not-an-engine-at-all" })` returns
 * true. Same class and lower stakes: `path: ["", ""]` and `issuedAt: "yesterday"` both pass. So a
 * route or a dialog that takes `plan.type` to the provider factory or to a capability table is
 * reading a string the CALLER typed, and owes its own lookup-failed path. Adding the engine list
 * here would mean importing a value module into a file that today imports types only.
 */
export function isObjectEditPlanShape(value: unknown): value is ObjectEditPlan {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, PLAN_KEYS)) return false;
  if (value.planVersion !== 1) return false;
  if (!isBoundedString(value.planId)) return false;
  if (!isBoundedString(value.issuedAt)) return false;
  if (!isBoundedString(value.connectionFingerprint)) return false;
  if (!isBoundedString(value.type)) return false;
  if (!isStringArray(value.path) || (value.path as readonly string[]).length === 0) return false;
  if (!isBoundedString(value.kind)) return false;
  if (!isBoundedString(value.partId)) return false;
  if (!STRATEGIES.includes(value.strategy as string)) return false;
  if (!isObjectEditUnitShape(value.unit)) return false;
  if (!Array.isArray(value.session) || !value.session.every(isSessionPin)) return false;
  if (!isRevision(value.revision)) return false;
  if (!Array.isArray(value.consequences) || !value.consequences.every(isConsequence)) return false;
  return true;
}

/**
 * What an apply DID, dispatched on `outcome` and, for a conflict, on `conflict` as well.
 *
 * The hybrid this refuses first is an outcome that succeeded AND conflicted. That is the one that
 * matters most: a read that lies shows the wrong text, and an apply that lies tells a reader their
 * change landed when it did not.
 */
export function isObjectEditOutcomeShape(value: unknown): value is ObjectEditOutcome {
  if (!isRecord(value)) return false;
  if (!isDuration(value.duration)) return false;
  switch (value.outcome) {
    case "applied":
      return hasExactKeys(value, ["outcome", "revision", "duration"]) && isRevision(value.revision);
    case "applied-with-collateral":
      if (!hasExactKeys(value, ["outcome", "lost", "revision", "duration"])) return false;
      // A NON-EMPTY tuple in the type. An outcome that claims a collateral and names none is the
      // warning with nothing in it, one level past the compiler.
      if (!Array.isArray(value.lost) || value.lost.length === 0) return false;
      if (!value.lost.every(isConsequence)) return false;
      return isRevision(value.revision);
    case "applied-elsewhere":
      if (!hasExactKeys(value, ["outcome", "undone", "duration"], ["wrote"])) return false;
      if (typeof value.undone !== "boolean") return false;
      return !Object.hasOwn(value, "wrote") || isBoundedString(value.wrote);
    case "conflict":
      // The SECOND discriminant, because the reader's next action differs between the two arms:
      // one is "look at the diff" and the other is "send the same plan again".
      if (value.conflict === "object-changed") {
        return hasExactKeys(value, ["outcome", "conflict", "current", "duration"]) && isTextBlock(value.current);
      }
      if (value.conflict === "engine-refused-concurrent") {
        if (!hasExactKeys(value, ["outcome", "conflict", "sentence", "duration"], ["code"])) return false;
        if (!isBoundedString(value.sentence)) return false;
        return !Object.hasOwn(value, "code") || isBoundedString(value.code);
      }
      return false;
    case "refused":
      return hasExactKeys(value, ["outcome", "refusal", "duration"]) && isObjectEditRefusalShape(value.refusal);
    case "interrupted":
      if (!hasExactKeys(value, ["outcome", "committed", "sentence", "duration"])) return false;
      // `rolled-back` may be claimed only by a strategy that opened the transaction itself, and
      // any other spelling is a claim about a rollback this design may not make.
      if (value.committed !== "unknown" && value.committed !== "rolled-back") return false;
      return isBoundedString(value.sentence);
    default:
      return false;
  }
}

/**
 * What a build answered, over the wire.
 *
 * `planToken` is optional so an embedded HOST's answer passes: a host returns `ObjectEditBuild`
 * and has no key to seal with. A build that answers a plan AND a refusal is refused, because the
 * union narrows on the literal discriminant while a consumer testing property presence would pick
 * whichever it tested first.
 */
export function isObjectEditBuildResponseShape(value: unknown): value is ObjectEditBuildResponse {
  if (!isRecord(value)) return false;
  if (value.built === true) {
    if (!hasExactKeys(value, ["built", "plan", "preimage"], ["planToken"])) return false;
    if (!isObjectEditPlanShape(value.plan)) return false;
    if (!isTextBlock(value.preimage)) return false;
    return !Object.hasOwn(value, "planToken") || isBoundedString(value.planToken);
  }
  if (value.built === false) {
    return hasExactKeys(value, ["built", "refusal"]) && isObjectEditRefusalShape(value.refusal);
  }
  return false;
}
