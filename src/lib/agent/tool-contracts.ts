/**
 * The language-neutral contracts the tool layer and the language packs both state (#1821).
 *
 * Each of these is said identically wherever it is said: the selector and evidence schemas a definition offers, the
 * evidence and answer contracts its description quotes, the refusal sentences, and the few helpers that render a
 * citation or read a run's own ledger. `tools.ts` imports them, and so does every language pack, so a pack never has
 * to reach into `tools.ts` for a sentence or a schema.
 *
 * The refusal tables are the core's rows merged with the language packs' rows (`languages/refusals.ts`): the codes
 * stay in the core's unions, because the ledger persists them, and only a sentence one language alone says lives in
 * that language's pack. `mergeDisjoint` makes a code said by both sides a load-time error.
 *
 * Below `tools.ts`: every import from it is `import type`, so loading this module never evaluates the tool layer.
 */

import { z } from "zod";
import { mergeDisjoint } from "./disjoint-merge";
import { LANGUAGE_READING_REFUSAL_TEXT, LANGUAGE_UNAVAILABLE_TEXT } from "./languages/refusals";
import type { AgentProfileFinding } from "./table-profile";
import type { AgentComposedAnswer, AgentOperationId, AgentToolOutcome, AgentToolUnavailableCode } from "./tools";
import type {
  AgentChartSpec,
  AgentContextSnapshot,
  AgentEvidenceReference,
  AgentReadingDenyCode,
  AgentRunEvent,
} from "./types";
import { fenceUntrustedContent } from "./untrusted-content";

export const catalogSelectorSchema = z.strictObject({
  /**
   * Which inventory to read. Absent means the column inventory, which is what a
   * bare catalog inspection has always meant — so a model that never sends this
   * field gets exactly the behaviour it got before the field existed.
   */
  kind: z.enum(["columns", "relations", "indexes"]).optional(),
  schema: z.string().optional(),
  table: z.string().optional(),
});

/**
 * A profile names a TABLE, never columns and never SQL. The columns come from the
 * run's own captured inventory, so a profile cannot be aimed at something the run
 * never established exists — the same rule `compare_plans` follows about plans.
 * Exported for the SQL pack's arms (`languages/sql/index.ts`), which declare it as the SQL
 * arm's input, held equal to the offered schema by `tool-offer-census.test.ts`.
 */
export const profileSelectorSchema = z.strictObject({
  /*
    Described, because an undescribed optional string next to a fingerprint-heavy set of
    rules is an invitation. `qwen3:8b` filled it with the snapshot fingerprint
    (`ctx_3b6b…`), which resolved to nothing and cost it the run. Omitting the field
    entirely is the right answer whenever the inventory names a table bare, so the
    description leads with that rather than with what a schema is.
  */
  schema: z
    .string()
    .describe(
      "Omit this unless the inventory qualifies the table as schema.table. It is a database schema name — never an artifact id or a snapshot fingerprint.",
    )
    .optional(),
  table: z.string().min(1),
  depth: z.enum(["basic", "distribution", "pattern"]).optional(),
  /** Where in the table's column list to start. The server bounds how many follow. */
  fromColumn: z.number().int().min(0).optional(),
});

export const evidenceSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("artifact"),
    correlationId: z.string().min(1),
    locator: z.string().min(1).optional(),
  }),
  z.strictObject({
    source: z.literal("context-snapshot"),
    fingerprint: z.string().min(1),
    locator: z.string().min(1).optional(),
  }),
]);

/**
 * ONE citation, rendered as the object the schema above accepts (#350).
 *
 * A function rather than a pair of string constants, because the same two calls
 * produce both things that have to agree: the EXAMPLE a description shows, with a
 * placeholder where the id goes, and the CONCRETE citation a completed step hands
 * over with the id filled in. A model that copies what it was shown is producing
 * what the parser was going to accept, because the same code wrote both.
 *
 * `satisfies AgentEvidenceReference` is what ties them to the durable contract, and
 * `tests/unit/lib/agent/tools.test.ts` closes the loop from the other side: it lifts
 * every literal object out of each description and parses it through that tool's own
 * `inputSchema`, so a description offering a shape the schema refuses fails there
 * rather than in a run.
 *
 * Why it exists at all: the evidence contract is a two-arm discriminated union, and
 * two live runs (#350) inferred it wrong from the serialized JSON schema alone — the
 * ledger records the model asking itself whether an evidence item is "an array of
 * table row objects or strings?" and spending a database round trip on the question.
 * Nothing it was TOLD named `source`, `correlationId` or `fingerprint`.
 */
const citeArtifact = (correlationId: string): string =>
  JSON.stringify({ source: "artifact", correlationId } satisfies AgentEvidenceReference);

export const citeSnapshot = (fingerprint: string): string =>
  JSON.stringify({ source: "context-snapshot", fingerprint } satisfies AgentEvidenceReference);

/**
 * The evidence contract in one sentence, said identically wherever it is said.
 *
 * Exported because `investigation.ts` states it too — in the run's opening rules —
 * and two wordings of the same contract would be two things to keep equal, with the
 * one that drifted being the one a model followed into a refusal.
 */
export const AGENT_EVIDENCE_CONTRACT = [
  `Each evidence item is ONE object: ${citeArtifact("<the artifact id a completed step reported>")} for a result this run read,`,
  `or ${citeSnapshot("<the fingerprint of the schema snapshot this run captured>")} for that inventory.`,
  'Add "locator" only to point at a part of it.',
].join(" ");

/**
 * The chart types a spec may ask for, as a total record over the durable union.
 *
 * A record rather than a bare list, for the reason `EVENT_KINDS` is one: the compiler
 * is the exhaustiveness check. A type added to `AgentChartSpec` and not offered here
 * would be a type the ledger can hold and the model is never told about.
 */
const CHART_TYPES: Readonly<Record<AgentChartSpec["type"], true>> = Object.freeze({
  bar: true,
  line: true,
  area: true,
  pie: true,
  scatter: true,
  "stacked-bar": true,
});

const CHART_TYPE_NAMES = Object.keys(CHART_TYPES) as [AgentChartSpec["type"], ...AgentChartSpec["type"][]];

const chartSpecSchema = z.strictObject({
  type: z.enum(CHART_TYPE_NAMES),
  x: z.string().min(1),
  y: z.array(z.string().min(1)).min(1),
  caption: z.string().min(1),
});

/**
 * An answer names ONE artifact and how to show it, and nothing else.
 *
 * Deliberately no statement text, for the reason `compare_plans` takes none: the
 * ledger already records which statement produced which result, so the server joins
 * them itself. A model-supplied statement would let an answer hand the user a
 * statement that produced something other than the result on screen.
 */
export const presentAnswerSchema = z.strictObject({
  artifact: z.string().min(1),
  presentation: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("table") }),
    z.strictObject({ kind: z.literal("chart"), spec: chartSpecSchema }),
  ]),
});

/** ONE presentation, rendered as the object `presentAnswerSchema` accepts for its `presentation`. */
const showAs = (presentation: AgentComposedAnswer["presentation"]): string => JSON.stringify(presentation);

/**
 * The presentation contract in one place, said identically wherever it is said.
 *
 * The `AGENT_EVIDENCE_CONTRACT` pattern, and it exists for the same reason: the
 * EXAMPLE the description shows and the object the parser accepts are produced by the
 * same call, so the two cannot disagree. `tests/unit/lib/agent/tools.test.ts` closes
 * the loop from the other side — it lifts every literal object out of the description
 * and parses it through this tool's own `inputSchema`.
 *
 * Exported, and it was module-private until the `data-analysis` workflow arrived:
 * that workflow's opening rules state the contract too, and the whole point of one
 * string is that the description and the rules cannot tell a model two different
 * bars for one tool. It is stated in a second file by importing this, never by
 * copying it.
 */
export const AGENT_ANSWER_CONTRACT = [
  `"presentation" is ONE object: ${showAs({ kind: "table" })} for a table,`,
  `or ${showAs({
    kind: "chart",
    spec: {
      type: "bar",
      x: "<a column of that result>",
      y: ["<a numeric column of that result>"],
      caption: "<what the chart shows, in your own words>",
    },
  })} for a chart.`,
  `"type" is one of: ${CHART_TYPE_NAMES.join(", ")}. For several series, name several y columns: there is no separate series field.`,
  "Every column a chart names must be a column of THAT result, spelled as the result spells it, and every y column must hold numbers.",
  "A chart needs at least two rows; a pie takes exactly one y; a scatter needs a numeric x as well.",
  "Present a table when the result is a single number, has one row, or has no numeric column: that is a complete answer, not a lesser one.",
  "When the objective asks for a chart and the result can carry one, chart it: the user named the shape of the answer they wanted.",
].join(" ");

/** The codes whose sentence the core says; a language pack says the rest (`languages/refusals.ts`). */
type CoreUnavailableCode = Exclude<AgentToolUnavailableCode, keyof typeof LANGUAGE_UNAVAILABLE_TEXT>;

const CORE_UNAVAILABLE_TEXT: Readonly<Record<CoreUnavailableCode, string>> = Object.freeze({
  // "Produce a plan in prose" until 2026-08-15, when the plan-mode design made the
  // deliverable ONE runnable statement (or an explicit `NO STATEMENT:` refusal) for
  // every workflow but `operations`. This sentence is said to a model that has just
  // reached for a tool, which is exactly the moment it must not be handed a second,
  // looser contract than the one its rules state: two wordings of one contract is how
  // #350 happened. So it says what is true here — nothing can be called — and leaves
  // what to produce to the rules that already say it.
  MODE_HAS_NO_TOOLS:
    "This run is in planning mode, which has no tools at all: no database call is possible from here. Answer with what your instructions asked you to produce.",
  // Said by every tool, including the two that reach no database and compose no SQL,
  // so it may not promise a statement (#350). `recommend_change` and `compose_report`
  // shared a sentence written for the SQL-composing tools, and a model that got an
  // evidence object wrong was answered with a sentence about statements.
  INVALID_TOOL_INPUT:
    "The arguments did not match the shape this tool declares, so nothing was done. Correct them and call the tool again.",
  /*
    The true sentence for an inventory that exists and is empty.

    Split from `CATALOG_MATCHED_NOTHING` because that one denies the OBJECT, and here the
    objects are present and simply carry nothing. "No secondary index" answers an optimization
    question; it is not a missing name. The old sentence sent 79 of 133 measured optimization
    runs looking for a misspelling on their opening turn.

    It also closes the door rather than leaving it ajar: the run is told the inventory it was
    already handed carries the same fact, so there is nothing further to read and no reason to
    ask again with a different spelling.
  */
  CATALOG_INVENTORY_EMPTY:
    "That inventory is empty: the objects exist and declare none of these, so nothing was inspected. This database has no secondary index and no declared foreign key beyond what the schema inventory in this conversation already shows — reading it again with another spelling will return the same nothing. Treat the absence as a finding: it is an answer about how this database is built, and you may state it in a claim citing that inventory.",
  CATALOG_MATCHED_NOTHING:
    "There is no object of that name in this database, so nothing was inspected. Check the inventory this run was given and inspect a name it lists — a name from the objective may be the name of a query or a report rather than of a table.",
  UNVERIFIABLE_EVIDENCE: `At least one evidence reference does not match anything this run produced. Cite an artifact this run actually read, or the schema snapshot it captured. ${AGENT_EVIDENCE_CONTRACT}`,
  UNVERIFIABLE_PLAN:
    "At least one of those references is not an estimated plan this run produced. Inspect the plan of each statement first, then compare the two artifacts those inspections returned.",
  /*
    Offers names instead of a tool, and the tool it used to offer is the reason.

    This said "Call inspect_schema for it first" — and the comment just below, written for
    the sibling refusal, already states why that is wrong: the `no-table-profile` hold
    narrows a run to `profile_table` and `compose_report`, so `inspect_schema` is gone. The
    measured sequence was two dead refusals in a row: held and narrowed, asked for a
    profile, names a table slightly wrong, told to call a tool it no longer holds, calls
    it, told there is no such tool.

    The inventory is in hand at the refusal site, so the call site appends names from it.
    Not gated on whether the run was narrowed: a run that cannot spell a table is helped by
    seeing the spellings either way.
  */
  TABLE_NOT_INVENTORIED:
    "That table is not in the schema inventory this run captured, so nothing was profiled. Profile one the inventory lists, spelled the way it spells it.",
  // Names no tool, for the reason the two refusals around it name none: a held run has been
  // narrowed out of `inspect_schema`, and this one does not need it anyway, since the objects
  // are already inventoried. What it needs is the spellings, and they arrive as the `detail`
  // because they are this inventory's own addresses and this sentence may not invent them.
  // One that is not a plain name arrives quoted (`nameForPrompt`), and `resolveProfileTarget`
  // takes it back quoted as well, so "spelled in full" holds for the copy as the model reads it,
  // except where one candidate's raw name is another's quoted form (see `resolveProfileTarget`).
  TABLE_SPELLING_AMBIGUOUS:
    "More than one object in this run's inventory is spelled that way, so nothing was profiled: this run cannot say which one you meant. Call profile_table again with one of the addresses below, spelled in full.",
  // Says what to change, which is the whole of it: the call this replaces was repeated
  // verbatim three times because the sentence it got named nothing that could be edited.
  // It also may not send the model to `inspect_schema` — a held run has been narrowed out
  // of holding it, and the fix does not need it, since the table is already inventoried.
  // Confirms the object and refuses the profile, and names neither a tool nor a kind: the
  // kind is the engine's own word and arrives as the refusal's `detail`, since a sentence
  // that hardcoded "view or table" would be wrong on the engines whose relation kinds this
  // repository has never heard of.
  OBJECT_NOT_PROFILABLE:
    "That name is in this run's inventory, and not as something with rows to count, so nothing was profiled. Profile one of the objects the inventory lists under a kind that holds rows.",
  TABLE_QUALIFIER_UNKNOWN:
    "The table is in this run's inventory, but not under the schema you named — this run's inventory has no such schema, so nothing was profiled. Call profile_table again with the same table and NO schema field at all: the inventory's own name for it is what this tool matches. The schema field takes a database schema name, never an artifact id or a snapshot fingerprint.",
  NO_COLUMNS_AT_OFFSET:
    "That column offset is past the end of the table, so there is nothing there to profile. Start from an earlier column, or profile a different table.",
  PROFILE_UNREADABLE:
    "The profile ran but its result could not be read as counts. Try a shallower depth, or profile a different table.",
  IDENTICAL_PLANS:
    "Both sides of that comparison name the same plan, so there is no before and no after. Inspect the plan of your rewrite as well, then compare the two.",
  RECOMMENDATION_SHAPE_MISMATCH:
    "That statement is not the kind of change the card claims. An index recommendation must be one CREATE INDEX statement; a rewrite must be one bounded read.",
  PLAN_RESULT_RELEASED:
    "That plan was this run's, but its rows are no longer held and cannot be read again. Inspect the plan once more if the comparison still matters.",
  // The answer refusals each restate the half of the contract they enforce, and each
  // one names the way out. A description is read by a model that is not yet confused;
  // these are read by one that demonstrably is, and a table is almost always a correct
  // answer it can give instead.
  //
  // This first one is the exception to that shape: nothing about the arguments was
  // wrong, so there is no contract half to restate and no second attempt to invite.
  // The only thing left for the run to do is say what the answer MEANS.
  ANSWER_ALREADY_RECORDED:
    "This run has already recorded its answer, and a run answers once: nothing was changed and no second answer was composed. If that answer was the wrong one, say so in your claims. Now call compose_report — the presentation shows the result, the claims are the answer.",
  ANSWER_ARTIFACT_UNKNOWN:
    "That is not the id of a result this run read, so there is nothing to present. Pass the artifact id a completed read reported in this run, or read the data first.",
  ANSWER_NOT_A_DATA_READ:
    "That result is this run's, and it is not a reading of the data, so it cannot be the answer: a plan DESCRIBES a statement without running it, and a profile returns counts the server composed about a table. Present the result of a run_read_query you drafted — run the read first if you have not. A plan or a profile can still be cited as evidence in your report.",
  ANSWER_STATEMENT_UNKNOWN:
    "That result was not produced by a statement you wrote, so there is no statement to put behind the answer. Answer with a read you drafted yourself.",
  ANSWER_RESULT_RELEASED:
    "That result was this run's, but its rows are no longer held, so a chart's columns cannot be checked against them. Read it again, or present the answer as a table.",
  CHART_COLUMN_NOT_IN_RESULT:
    "A chart may only name columns of the result it presents, and at least one of these is not one. The result's own column names follow: spell them exactly as they are spelled there, or present the answer as a table.",
  CHART_COLUMN_NOT_NUMERIC:
    "Every y column of a chart has to hold numbers in the rows that were delivered, and at least one of these does not. Chart a column that holds numbers, or present the answer as a table — a table is a complete answer.",
  CHART_TOO_FEW_ROWS:
    "A chart needs at least two rows and this result has fewer, so a chart of it would render an empty state. Present the answer as a table: one row is a complete answer, not a lesser one.",
  CHART_SHAPE_MISMATCH:
    "That chart type does not fit the columns named: a pie takes exactly one y column, and a scatter needs a numeric x as well as a numeric y. Choose a type that fits the columns, or present the answer as a table.",
  STATEMENT_NOT_ADMITTED:
    "This statement was refused before anything was sent, for the reason in parentheses; write a read inside the read-only subset.",
  /*
    Both of these name `compose_report`, and that is the whole correction.

    They used to end "Stop calling tools and finish with what has already been established"
    and "Ask for something cheaper, or finish now." Finishing IS a tool call: `compose_report`
    is ledger-only, reaches no database, and is short-circuited before the deadline gate is
    consulted, so it is still available to a run with nothing left. A model that reads those
    sentences literally answers in prose instead, and prose is scored `no-report` — the
    largest single shortfall measured, blocking 28 of the cells that do not lock.

    So each says which call still works, and why it works, rather than telling a run to stop
    doing the only thing that can still end it well.
  */
  RUN_DEADLINE_EXCEEDED:
    "The run has spent its whole time budget, so no further reading is possible. Call compose_report now with what has already been established: it needs no time budget, because it reaches no database. A run that ends without a report answers nothing at all.",
  INSUFFICIENT_TIME_REMAINING:
    "Too little time is left in the run for a call of this size. Ask for something cheaper, or call compose_report now with what you have — it needs no time budget, because it reaches no database.",
  STATEMENT_ALREADY_FAILED:
    "This exact statement has already failed in this run. Draft a different statement rather than sending the same one again.",
  REPAIR_BUDGET_EXHAUSTED:
    "This run has used all of its repair attempts. Stop drafting statements and report what has been established.",
});

export const UNAVAILABLE_TEXT: Readonly<Record<AgentToolUnavailableCode, string>> = mergeDisjoint(
  [CORE_UNAVAILABLE_TEXT, LANGUAGE_UNAVAILABLE_TEXT],
  "UNAVAILABLE_TEXT",
);

/** The reading codes whose sentence the core says; a language pack says the rest. */
type CoreReadingDenyCode = Exclude<AgentReadingDenyCode, keyof typeof LANGUAGE_READING_REFUSAL_TEXT>;

/**
 * What a refused curated reading tells the model, and both sentences are advice it
 * can actually act on.
 *
 * `READING_OVER_BUDGET`'s advice is only worth giving because `limit` is applied by
 * the projection for EVERY kind rather than only by the two provider methods that
 * take one — see `runCuratedRead` in `tools.ts`. Advice a tool cannot honour is worse than none:
 * the model would spend its statement budget re-asking for a reading it can never be
 * given.
 */
const CORE_READING_REFUSAL_TEXT: Readonly<Record<CoreReadingDenyCode, string>> = Object.freeze({
  KIND_UNSUPPORTED_BY_PROVIDER:
    "This database serves no reading of that kind, so nothing was read. Ask for a different kind, or report what the other readings established — including that this one is unavailable here.",
  READING_OVER_BUDGET:
    "That reading came back larger than this run may carry, so none of it was kept: a partial reading would be a misleading one. Ask again with a smaller limit; it bounds every kind of reading, not only the ones the engine limits itself.",
});

export const READING_REFUSAL_TEXT: Readonly<Record<AgentReadingDenyCode, string>> = mergeDisjoint(
  [CORE_READING_REFUSAL_TEXT, LANGUAGE_READING_REFUSAL_TEXT],
  "READING_REFUSAL_TEXT",
);

export function unavailable(
  reasonCode: AgentToolUnavailableCode,
  detail?: string,
): AgentToolOutcome & { kind: "unavailable" } {
  const base = UNAVAILABLE_TEXT[reasonCode];
  return {
    kind: "unavailable",
    reasonCode,
    modelText: detail === undefined ? base : `${base} (${detail})`,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** What a completed reach says about the artifact it just produced. */
export const handoverText = (correlationId: string): string =>
  `Stored as artifact ${correlationId}. To use it in a claim, cite it as ${citeArtifact(correlationId)}.`;

/**
 * The findings, in the server's own words.
 *
 * A column NAME is untrusted database content, so it is fenced rather than spliced
 * into a sentence the model would read as the server speaking, naming `relayedBy`, the
 * provider that relayed it. The finding codes and the counts are this repository's own.
 */
export function describeFindings(
  findings: readonly AgentProfileFinding[],
  operationId: AgentOperationId,
  relayedBy: string,
): string {
  if (findings.length === 0) return "Nothing crossed a finding threshold.";
  return fenceUntrustedContent(
    findings.map((finding) => `${finding.column}: ${finding.code} — ${finding.detail}`).join("\n"),
    { label: `${findings.length} profile finding(s)`, operationId, reference: "server-derived", relayedBy },
  );
}

/**
 * The most recent inventory this run captured, read off its own ledger.
 *
 * The LAST one, because a run may capture more than once and the newest is the one
 * its later statements were drafted against.
 */
export function capturedSnapshot(events: readonly AgentRunEvent[]): AgentContextSnapshot | null {
  let snapshot: AgentContextSnapshot | null = null;
  for (const event of events) {
    if (event.kind === "context-captured" && event.snapshot !== undefined) snapshot = event.snapshot;
  }
  return snapshot;
}
