import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import type { AuditReason } from "@/lib/audit";
import type {
  ObjectEditCatalogFact,
  ObjectEditConsequence,
  ObjectEditConsequenceClass,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditPosition,
  ObjectEditRefusal,
  ObjectEditSegment,
  ObjectEditStep,
  ObjectEditUnit,
} from "@/lib/db/types";

/**
 * The inbound bound on the text a caller may submit for ONE part, answered 413 (#789 Phase 3).
 *
 * EQUAL TO `SOURCE_CHARACTER_LIMIT` BY CONSTRUCTION and not by coincidence: a text longer than
 * the route's own read bound cannot have come from a read of this object, and a readable part
 * must be a submittable one. Two numbers here would let the two drift and would refuse an edit of
 * something this product had just shown whole.
 */
export const EDIT_CHARACTER_LIMIT = SOURCE_CHARACTER_LIMIT;

/**
 * The bound on the PLAN'S TOTAL EXECUTABLE TEXT, a SEPARATE number from the one above, answered
 * 400 at build and re-checked at apply (#789 Phase 3, design 5.2).
 *
 * THE TWO BOUNDS ARE DIFFERENT QUESTIONS AND A LATER READER WILL OTHERWISE COLLAPSE THEM AGAIN,
 * so this paragraph is the reason rather than a restatement. `EDIT_CHARACTER_LIMIT` bounds what a
 * CALLER MAY SUBMIT for one part, and it is `SOURCE_CHARACTER_LIMIT` by construction because a
 * readable part must be a submittable one. This bounds what THIS PRODUCT WILL SEND, which is the
 * caller's text PLUS whatever the provider wrapped around it, and the two are never equal on any
 * day-one engine: the PostgreSQL unit is the reader's text plus a `SET LOCAL`, a pre-block and a
 * post-block. Setting them to one number refuses the route's OWN plan for any part within the
 * guard block's length of the read bound, and the PostgreSQL fixture's under-limit control sits at
 * about 975,134 characters, which is inside that distance.
 *
 * THE ARITHMETIC, done rather than asserted, and every number in it is measured:
 * - The inbound framework bound is 10,485,760 bytes. MEASURED: Next 16.3.4 clones every request
 *   body for middleware at exactly that size and TRUNCATES above it.
 * - 1,000,000 UTF-16 code units is up to 4 MB as UTF-8 and up to 6 MB once JSON-escaped, because
 *   the worst-case JSON escape of one code unit is the six ASCII bytes of `\uXXXX`.
 * - `EDIT_BODY_BYTE_LIMIT` is 8,388,608, so the byte wall's CHARACTER equivalent at that same
 *   worst case is 8,388,608 / 6 = 1,398,101 characters. A plan above that cannot be posted back
 *   at all.
 * - 1,200,000 therefore sits ABOVE `EDIT_CHARACTER_LIMIT` with 200,000 characters of headroom for
 *   provider framing, which is two orders of magnitude more than the PostgreSQL guard block needs,
 *   and BELOW 1,398,101, so a plan this route issues always fits the body bound it will come back
 *   through.
 *
 * What it refuses, stated as a cost rather than left to be discovered: a later
 * `temp-name-test-create` sends the reader's text TWICE, so it cannot edit a part above about
 * 600,000 characters. That is the intended answer. The alternative is a 12 MB apply body the
 * framework truncates into a 500, which is the failure this number exists to convert into a
 * sentence at build time.
 */
export const EDIT_PLAN_EXECUTABLE_LIMIT = 1_200_000;

/**
 * The inbound bound on the whole request body, in BYTES, read before the JSON parse (#789).
 *
 * The arithmetic, done rather than asserted. MEASURED: Next 16.3.4 clones every request body for
 * middleware at exactly 10,485,760 bytes and TRUNCATES above it, which surfaces as HTTP 500 with
 * a JSON parser's sentence on `/api/db/query` and as HTTP 400 "Empty request body" on
 * `/api/db/objects/source`: one condition reported two wrong ways. One maximal part is 1,000,000
 * UTF-16 code units, up to 4 MB as UTF-8 and up to 6 MB once JSON-escaped. The plan body carries
 * the reader's text once and the apply body carries the plan, whose unit contains that text once
 * plus the provider's segments, so both worst cases are about 6 MB. This number sits above that
 * and below the framework's wall, so an oversized body meets a true sentence rather than a
 * truncation reported as an empty body.
 *
 * Ruling 1a's rule that the apply never takes the source text again is therefore ALSO what keeps
 * the apply body under the framework bound, which is worth writing down because a future "send
 * the original too, for the diff" would break both at once.
 */
export const EDIT_BODY_BYTE_LIMIT = 8_388_608;

/**
 * The sent text, rebuilt from the reader's text and the coordinate map (#789 Phase 3).
 *
 * `ObjectEditStep.text` is AUTHORITATIVE and this is never a second source of the bytes. It
 * exists so that a provider's own suite can assert `renderSegments(userText, step.segments) ===
 * step.text`, which is the invariant that stops the two drifting.
 */
export function renderSegments(userText: string, segments: readonly ObjectEditSegment[]): string {
  let rendered = "";
  for (const segment of segments) {
    rendered += segment.from === "provider" ? segment.text : userText.slice(segment.start, segment.end);
  }
  return rendered;
}

/**
 * The reader's own text, recovered from a step ALONE (#789 Phase 3).
 *
 * An apply holds the plan and nothing else, by ruling 1a, so a coordinate can only be converted
 * into the reader's line and column if the reader's text can be recovered from the step. It can:
 * every `user` segment names a half-open range of the reader's text and the bytes for that range
 * sit at a computable offset of `step.text`.
 *
 * `undefined` when the user segments leave a GAP, because a text with a hole in it would place a
 * marker on the wrong character. A strategy that sends the reader's text TWICE is fine and is
 * handled: the two copies are the same bytes.
 */
export function userTextOf(step: ObjectEditStep): string | undefined {
  const pieces: { readonly start: number; readonly text: string }[] = [];
  let sent = 0;
  for (const segment of step.segments) {
    if (segment.from === "provider") {
      sent += segment.text.length;
      continue;
    }
    const length = segment.end - segment.start;
    if (length < 0) return undefined;
    pieces.push({ start: segment.start, text: step.text.slice(sent, sent + length) });
    sent += length;
  }
  let recovered = "";
  for (const piece of [...pieces].sort((left, right) => left.start - right.start)) {
    if (piece.start > recovered.length) return undefined;
    const overlap = recovered.length - piece.start;
    if (overlap < piece.text.length) recovered += piece.text.slice(overlap);
  }
  return recovered;
}

/**
 * Where an offset into the SENT text lands in the READER'S text, 1-based on both axes (#789).
 *
 * `outside` rather than a number whenever the offset is in a provider segment, past the end, or
 * in a step whose user text cannot be recovered. MEASURED in a real browser with a control: an
 * out-of-range coordinate handed to `setModelMarkers` did not throw, did not warn and did not
 * look wrong, because Monaco silently CLAMPED it to the end of the model, so nothing in the
 * platform catches a coordinate this function gets wrong. A sentence the reader can act on is the
 * only honest answer for a position that is not in their text.
 *
 * 1-based because that is what `IMarkerData.startLineNumber` and `startColumn` take, while
 * `model.getPositionAt()` is 0-based and PostgreSQL's `position` is a 1-based CHARACTER offset
 * that arrives as a STRING although `QueryError.position` is typed `number`. Callers pass a
 * 0-based offset into `step.text`, so a provider reading a 1-based engine position subtracts one
 * before calling.
 */
export function userPositionOf(step: ObjectEditStep, sentOffset: number): ObjectEditPosition {
  if (!Number.isInteger(sentOffset) || sentOffset < 0 || sentOffset >= step.text.length) {
    return { within: "outside" };
  }
  let cursor = 0;
  for (const segment of step.segments) {
    const length = segment.from === "provider" ? segment.text.length : segment.end - segment.start;
    if (sentOffset < cursor + length) {
      if (segment.from === "provider") return { within: "outside" };
      const userText = userTextOf(step);
      if (userText === undefined) return { within: "outside" };
      const userOffset = segment.start + (sentOffset - cursor);
      const before = userText.slice(0, userOffset);
      const lastBreak = before.lastIndexOf("\n");
      return { within: "user", line: before.split("\n").length, column: userOffset - lastBreak };
    }
    cursor += length;
  }
  return { within: "outside" };
}

/**
 * The ranges of the SENT text this product wrote rather than the reader (#789 Phase 3).
 *
 * The preview's diff shades these, because for PostgreSQL the FIRST thing in the diff on the most
 * common day-one kind is a generated guard block, and for Trino the statement differs from what
 * the reader typed by eleven characters they never wrote. Shading them is what lets the dialog say
 * the whole right side is what will be sent without claiming the reader wrote all of it.
 */
export function providerRanges(step: ObjectEditStep): readonly { readonly start: number; readonly end: number }[] {
  const ranges: { readonly start: number; readonly end: number }[] = [];
  let cursor = 0;
  for (const segment of step.segments) {
    const length = segment.from === "provider" ? segment.text.length : segment.end - segment.start;
    if (segment.from === "provider") ranges.push({ start: cursor, end: cursor + length });
    cursor += length;
  }
  return ranges;
}

/**
 * How many characters this plan will execute, which is what the route bounds (#789 Phase 3).
 *
 * The bound is `EDIT_PLAN_EXECUTABLE_LIMIT` and never `EDIT_CHARACTER_LIMIT`, and the difference
 * is not pedantic: a PostgreSQL unit is the reader's text plus a guard block, so a bound of
 * `SOURCE_CHARACTER_LIMIT` applied to the unit would refuse the route's OWN plan for any part
 * within the guard block's length of the read bound. A later `temp-name-test-create` sends the
 * reader's text twice, and this is the number that catches it at build rather than at a framework
 * truncation.
 *
 * BOTH ROUTES CALL IT. The build refuses to issue a plan it knows cannot be posted back; the apply
 * re-checks the plan's own unit, ENFORCING rather than trusting, which is the precedent
 * `boundSourceDocument` set for a provider defect.
 */
export function planExecutableLength(unit: ObjectEditUnit): number {
  if (unit.medium === "command") {
    return (
      unit.name.length + unit.arguments.reduce((total, token) => total + token.length, 0) + unit.payload.text.length
    );
  }
  return unit.steps.reduce((total, step) => total + step.text.length, 0);
}

/**
 * The sentence for one collateral consequence, composed by CORE from the class and the catalog
 * fact (#789 Phase 3, ruling 1b amended).
 *
 * A provider may not write this prose, and the reason is a shipped defect in this tree: a
 * provider docblock claims a tail guarantee "in a measurement's voice" beside a real measurement
 * about a different thing, and it is MEASURED FALSE. The class is closed and the fact is a value
 * an engine answered, so the only thing left to get wrong is one sentence with one owner.
 *
 * Seven of the eight classes have no day-one producer. Each is named with its engine and version
 * in `ObjectEditConsequenceClass`, each appears in a provider doc, and each is exercised here by
 * a unit test, which is what stops the record being seven dead arms.
 */
const CONSEQUENCE_SENTENCE: Readonly<Record<ObjectEditConsequenceClass, (fact: ObjectEditCatalogFact) => string>> =
  Object.freeze({
    "replaces-whole-container": (fact) =>
      `Applying this replaces the whole container, so anything in it that your text does not re-create is deleted. ${fact.source} answers: ${fact.observed}.`,
    "destroys-sibling-part": (fact) =>
      `Applying this destroys the other part of this object, and nothing re-creates it. ${fact.source} answers: ${fact.observed}.`,
    "destroys-overloads": (fact) =>
      `Applying this deletes every other overload of this name. ${fact.source} answers: ${fact.observed}.`,
    "destroys-index": (fact) =>
      `Applying this drops the index on this object and reports success. ${fact.source} answers: ${fact.observed}.`,
    "destroys-comment": (fact) =>
      `Applying this discards the comment on this object. ${fact.source} answers: ${fact.observed}.`,
    "forks-object": (fact) =>
      `Applying this creates a SECOND object instead of replacing this one, and existing callers then fail. ${fact.source} answers: ${fact.observed}.`,
    "transfers-security-principal": (fact) =>
      `Applying this moves the object to the database account this connection uses, so it will run as a different principal. ${fact.source} answers: ${fact.observed}.`,
    "changes-module-semantics": (fact) =>
      `Applying this changes how the engine evaluates this module, with no error and no other visible sign. ${fact.source} answers: ${fact.observed}.`,
  });

export function describeConsequence(consequence: ObjectEditConsequence): string {
  return CONSEQUENCE_SENTENCE[consequence.loses](consequence.fact);
}

/** The value a plan PINS for one session setting, or undefined when it pins none. */
export function pinnedSessionValue(plan: ObjectEditPlan, setting: string): string | undefined {
  return plan.session.find((pin) => pin.mode === "pinned" && pin.setting === setting)?.value;
}

/**
 * SQLSTATEs whose complaint is an unresolved NAME, so a pinned `search_path` is the likely cause.
 *
 * Enumerated from PostgreSQL's own error-code table rather than from a fixture, per standing
 * ruling 5a: undefined_table, undefined_column, undefined_function, invalid_schema_name.
 */
const NAME_RESOLUTION_CODES: readonly string[] = Object.freeze(["42P01", "42703", "42883", "3F000"]);

/**
 * The one sentence OUR side owes when a pinned path is what refused the reader's text (#789,
 * ruling 2e).
 *
 * MEASURED on PostgreSQL 18.4: a `LANGUAGE sql` body and a `BEGIN ATOMIC` body are name-resolved
 * at CREATE time against the session `search_path`, a `LANGUAGE plpgsql` body is not, and
 * `pg_proc.proconfig` is NULL for a function that does not declare its own `SET search_path`, so
 * the path the object was created under cannot be recovered. Pinning is therefore deterministic
 * and it can refuse a previously-working cross-schema body. That refusal is deliberate, and this
 * is the sentence that makes it actionable instead of mysterious.
 *
 * `undefined` when the plan pinned no path, or when the engine's complaint is about something
 * else: attaching this to a syntax error would send the reader after the wrong cause.
 */
export function describePinnedPathRefusal(plan: ObjectEditPlan, refusal: ObjectEditRefusal): string | undefined {
  const pinned = pinnedSessionValue(plan, "search_path");
  if (pinned === undefined) return undefined;
  if (refusal.code === undefined || !NAME_RESOLUTION_CODES.includes(refusal.code)) return undefined;
  return (
    `LibreDB ran this apply with search_path set to ${pinned}, because this engine resolves a body's ` +
    `unqualified names when it is created and the session path on a shared connection is not yours to ` +
    `rely on. Qualify the name, or give this definition its own SET search_path clause.`
  );
}

/**
 * The audit key for an outcome, INCLUDING the second discriminant (#789 Phase 3, ruling 1c).
 *
 * DERIVED from the union rather than typed out, and it carries `conflict`'s second discriminant,
 * which is the correction that matters: a `Record<ObjectEditOutcome["outcome"], ...>` cannot see
 * it, so a third conflict arm added later would leave the record complete and compiling with no
 * audit reading, which is exactly the state the record exists to prevent.
 */
export type ObjectEditAuditKey =
  | Exclude<ObjectEditOutcome, { outcome: "conflict" }>["outcome"]
  | `conflict:${Extract<ObjectEditOutcome, { outcome: "conflict" }>["conflict"]}`;

/** A TOTAL map, so a new outcome with no audit reading fails to COMPILE, on the `DENY_REASONS` precedent. */
export const OBJECT_EDIT_AUDIT: Readonly<
  Record<ObjectEditAuditKey, { readonly result: "success" | "failure"; readonly reason?: AuditReason }>
> = Object.freeze({
  applied: { result: "success" },
  "applied-with-collateral": { result: "success", reason: "object_edit_collateral_loss" },
  "applied-elsewhere": { result: "failure", reason: "object_edit_applied_elsewhere" },
  "conflict:object-changed": { result: "failure", reason: "object_edit_conflict" },
  "conflict:engine-refused-concurrent": { result: "failure", reason: "object_edit_concurrent_update" },
  refused: { result: "failure", reason: "object_edit_refused" },
  interrupted: { result: "failure", reason: "object_edit_interrupted" },
});

export function auditKeyFor(outcome: ObjectEditOutcome): ObjectEditAuditKey {
  return outcome.outcome === "conflict" ? `conflict:${outcome.conflict}` : outcome.outcome;
}

/**
 * What the outcome event records, with the one refinement the key cannot carry.
 *
 * A `guard` refusal is filed under its own reason because it is THIS DESIGN'S precondition that
 * failed, the revision moving inside the guard or a session pin not holding, rather than the
 * engine refusing the reader's text. An operator reading the log has to be able to tell those
 * apart, which is the same separation `agent_operation` was added to preserve.
 */
export function auditReadingFor(outcome: ObjectEditOutcome): {
  readonly result: "success" | "failure";
  readonly reason?: AuditReason;
} {
  if (outcome.outcome === "refused" && outcome.refusal.refusal === "guard") {
    return { result: "failure", reason: "object_edit_guard_refused" };
  }
  return OBJECT_EDIT_AUDIT[auditKeyFor(outcome)];
}
