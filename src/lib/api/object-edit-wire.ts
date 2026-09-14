import type {
  ObjectEditConsequenceClass,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditPreimage,
  ObjectEditRefusal,
  ObjectEditRefusalClass,
  ObjectEditStrategy,
} from "@/lib/db/types";

/**
 * The wire types and shape checks for the object edit path (#789 Phase 3, discussion #778).
 *
 * NO SERVER IMPORT IN THIS FILE. The browser narrows a HOST's answer with the same predicates the
 * route narrows a provider's answer with, and a predicate that lived beside the plan token would
 * drag `jose` and `node:crypto` into the client bundle.
 *
 * Every predicate asserts EXACTLY the properties of the arm its discriminant names and refuses any
 * other own property, because the type cannot: MEASURED against tsc 6.0.3 and recorded on
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
 */
function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (!required.every((key) => Object.hasOwn(value, key))) return false;
  return Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

/** A string that carries a fact, rather than one that is present and says nothing. */
function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** A 0-based UTF-16 offset into the user's part text: an integer, never negative, never a NaN. */
function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isDuration(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

const STRATEGIES: readonly string[] = [
  "guarded-atomic-batch",
  "transactional-replace",
  "replace-in-place-statement",
  "replace-in-place-command",
  "alter-in-place",
  "temp-name-test-create",
] satisfies readonly ObjectEditStrategy[];

const CONSEQUENCE_CLASSES: readonly string[] = [
  "replaces-whole-container",
  "destroys-sibling-part",
  "destroys-overloads",
  "destroys-index",
  "destroys-comment",
  "forks-object",
  "transfers-security-principal",
  "changes-module-semantics",
] satisfies readonly ObjectEditConsequenceClass[];

const REFUSAL_CLASSES: readonly string[] = [
  "identity",
  "privilege",
  "definition",
  "guard",
  "unsupported",
] satisfies readonly ObjectEditRefusalClass[];

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
 * One statement or one command payload.
 *
 * `segments` is required to be non-empty. A step whose map is empty cannot be rendered as a
 * preview at all, and it is the population a "every segment is valid" loop certifies nothing over
 * when it runs zero times.
 */
function isStep(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["text", "language", "segments"])) return false;
  if (typeof value.text !== "string") return false;
  if (!isFilledString(value.language)) return false;
  if (!Array.isArray(value.segments) || value.segments.length === 0) return false;
  return value.segments.every(isSegment);
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
    return value.steps.every(isStep);
  }
  if (value.medium === "command") {
    if (!hasExactKeys(value, ["medium", "name", "arguments", "payload"])) return false;
    if (!isFilledString(value.name)) return false;
    if (!isStringArray(value.arguments)) return false;
    return isStep(value.payload);
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
    if (!isFilledString(value.token) || !isFilledString(value.basis)) return false;
    return value.scope === "server" || value.scope === "connection";
  }
  if (value.check === "unavailable") {
    return hasExactKeys(value, ["check", "reason"]) && isFilledString(value.reason);
  }
  return false;
}

/** A session setting the plan depends on: `asserted` compares and never writes, `pinned` writes. */
function isSessionPin(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.mode !== "asserted" && value.mode !== "pinned") return false;
  if (!hasExactKeys(value, ["mode", "setting", "value"])) return false;
  return isFilledString(value.setting) && typeof value.value === "string";
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
  return isFilledString(fact.source) && isFilledString(fact.observed);
}

/**
 * Where a refusal points, in the coordinates of the text the USER submitted.
 *
 * Three arms and not an optional pair. 1-based on both axes, which is what Monaco's
 * `IMarkerData.startLineNumber` and `startColumn` take, and a coordinate the provider could not
 * place inside the user's own text is `outside` rather than a number Monaco will silently clamp.
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
  if (!isFilledString(value.sentence)) return false;
  if (Object.hasOwn(value, "code") && !isFilledString(value.code)) return false;
  if (Object.hasOwn(value, "hint") && !isFilledString(value.hint)) return false;
  return isPosition(value.at);
}

/** The truncation mark. Its `reason` is rendered verbatim, so a mark with no reason is refused. */
function isTruncation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["limit", "reason"])) return false;
  return typeof value.limit === "number" && Number.isFinite(value.limit) && isFilledString(value.reason);
}

/**
 * A block of definition text with the language it is highlighted as: the build's pre-image, and
 * the conflict outcome's current server text. `text` may be empty, because an object whose part
 * read back empty is a fact the diff has to be able to show.
 */
function isTextBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ["text", "language"], ["truncated"])) return false;
  if (typeof value.text !== "string") return false;
  if (!isFilledString(value.language)) return false;
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
 */
export function isObjectEditPlanShape(value: unknown): value is ObjectEditPlan {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, PLAN_KEYS)) return false;
  if (value.planVersion !== 1) return false;
  if (!isFilledString(value.planId)) return false;
  if (!isFilledString(value.issuedAt)) return false;
  if (!isFilledString(value.connectionFingerprint)) return false;
  if (!isFilledString(value.type)) return false;
  if (!isStringArray(value.path) || (value.path as readonly string[]).length === 0) return false;
  if (!isFilledString(value.kind)) return false;
  if (!isFilledString(value.partId)) return false;
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
      return !Object.hasOwn(value, "wrote") || isFilledString(value.wrote);
    case "conflict":
      // The SECOND discriminant, because the reader's next action differs between the two arms:
      // one is "look at the diff" and the other is "send the same plan again".
      if (value.conflict === "object-changed") {
        return hasExactKeys(value, ["outcome", "conflict", "current", "duration"]) && isTextBlock(value.current);
      }
      if (value.conflict === "engine-refused-concurrent") {
        if (!hasExactKeys(value, ["outcome", "conflict", "sentence", "duration"], ["code"])) return false;
        if (!isFilledString(value.sentence)) return false;
        return !Object.hasOwn(value, "code") || isFilledString(value.code);
      }
      return false;
    case "refused":
      return hasExactKeys(value, ["outcome", "refusal", "duration"]) && isObjectEditRefusalShape(value.refusal);
    case "interrupted":
      if (!hasExactKeys(value, ["outcome", "committed", "sentence", "duration"])) return false;
      // `rolled-back` may be claimed only by a strategy that opened the transaction itself, and
      // any other spelling is a claim about a rollback this design may not make.
      if (value.committed !== "unknown" && value.committed !== "rolled-back") return false;
      return isFilledString(value.sentence);
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
    return !Object.hasOwn(value, "planToken") || isFilledString(value.planToken);
  }
  if (value.built === false) {
    return hasExactKeys(value, ["built", "refusal"]) && isObjectEditRefusalShape(value.refusal);
  }
  return false;
}
