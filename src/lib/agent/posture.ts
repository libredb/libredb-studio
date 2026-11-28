/**
 * What the SELECTED MODE does to the database, on one axis: what does it execute?
 *
 * The rail used to answer that question in six places at once - a mode description, a
 * consent paragraph, a budget note, a guard line, a refusal and a claim under the answer -
 * and a user comparing two of them could not tell which one bounded the run. This module is
 * the single reading, in four levels, and it is the ONLY thing the safety strip renders.
 *
 * It states nothing new. Every claim here is a claim some other module enforces:
 * `GRANTED_AGENT_EXECUTION_ENGINES` is the review record the profile gate reads, the figures come from the
 * workflow policy rows and from `AGENT_HANDOVER_BUDGET`, and the hand-over paragraph IS the
 * sentence the consent step shows - `autoExecuteTerms` below is that one source, exported so
 * the strip and the consent card cannot drift into two versions of a sentence a user agrees
 * to.
 *
 * Four properties are load-bearing and easy to lose:
 *
 *  - **The tone and the headline are this module's.** A language pack supplies the qualifier, the
 *    title and the body of its arms (`AgentPostureCopy` in `languages/pack.ts`) and cannot write a
 *    tone or a headline; the arm decides both, and the arm is read here from the review record and
 *    from the language's workflow variants, so no pack ranks its own claim.
 *  - **Client-safe imports only** - types, Studio's grant `GRANTED_AGENT_EXECUTION_ENGINES`, the legacy engine's
 *    grants through the agent manifest (`legacyAgentEngine`, which also guards the type id), the language packs' client
 *    facets (`languages/client.ts`, where each language's reads, widened and hand-over words live), the engines' client
 *    facets (`languages/engines/client.ts`), `getDBConfig` and the policy constants. A provider module here would drag `oracledb`/`mssql` toward a bundle
 *    that must not have them, which is the rule the review record's docblock in `src/lib/db/claim-grants.ts` records.
 *  - **Every engine name and every number is DERIVED.** Not one is typed as a literal, and
 *    not one is a count. The point of #425 is that "7+" was written when the answer was 7
 *    and stayed while the answer became 11; the same trap is one edit away here, because
 *    each of these sentences names a set the server decides.
 *  - **The qualifier is visible, never folded into the popover.** A bare "executes nothing"
 *    overclaims: on the dialects with a `catalogCapture`, plan mode's grounding capture IS a
 *    catalog read, and the review record's docblock in `src/lib/db/claim-grants.ts` says that copy compressing these
 *    facts overclaims. The strip therefore shows both halves on one line, and the popover
 *    carries the full claim rather than the missing half.
 */

import {
  type AgentEngine,
  type AgentStatementLanguageId,
  type AgentWorkflowAvailability,
  legacyAgentEngine,
  noStatementSessionSentence,
  notReviewedSentence,
  operationsWorkflowOpens,
} from "@/lib/agent/agent-manifest";
import { namedList } from "@/lib/agent/engine-support";
import { GRANTED_AGENT_EXECUTION_ENGINES } from "@/lib/db/claim-grants";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { grantedAgentStatementLanguage, languageClientPack } from "@/lib/agent/languages/client";
import { enginesSupporting } from "@/lib/agent/languages/engines/client";
import type { AgentPostureCopy, StatementBudgets } from "@/lib/agent/languages/pack";
import type { AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

/**
 * The four levels, named by what they say about execution rather than by a colour: a tone
 * is chosen by this module and a palette is chosen by the strip, so a restyle cannot change
 * a claim.
 */
export type AgentPostureTone = "safe" | "reads" | "widened" | "blocked";

export interface AgentPosture {
  readonly tone: AgentPostureTone;
  /** The pill. Short enough to read at a glance, and true on its own. */
  readonly headline: string;
  /** Beside the pill, always visible: the half a compressed headline would drop. */
  readonly qualifier: string;
  /** The popover's heading. */
  readonly title: string;
  /** The popover's text, and the whole claim. */
  readonly body: string;
}

/**
 * One arm's posture: core's tone and headline over a copy's three members, read by name. Not a spread, so a copy that
 * carries anything else, a tone or a headline cast past `AgentPostureCopy` among it, carries none of it to the strip.
 */
function rendered(tone: AgentPostureTone, headline: string, copy: AgentPostureCopy): AgentPosture {
  return { tone, headline, qualifier: copy.qualifier, title: copy.title, body: copy.body };
}

/**
 * The dialects whose grounding capture is a COMPOSED CATALOG READ rather than a request that
 * the provider describe its own schema: the engines whose server `catalogCapture` is supplied.
 *
 * Read from the engines' client dialects rather than the server one, and for the reason this
 * module exists at all: the server dialect reaches the composed reads and the tool layer, so
 * importing it would put the agent's server tree behind a browser bundle. Each client overlay
 * is typed from its server overlay, so the two cannot disagree, and
 * `tests/unit/lib/agent/posture.test.ts` reads the server dialect to hold the copy to it.
 */
const CATALOG_CAPTURE_ENGINES: readonly DatabaseType[] = enginesSupporting("catalogCapture");

/**
 * The per-statement bounds agent mode runs under, taken from one policy row.
 *
 * One row and not a fold, because the posture is read with no workflow in hand: the strip is
 * shown before a run is opened and beside a run whose workflow the user did not choose.
 * `workflowBudget()` writes `statementTimeoutMs` and `maxResultRows` once for every row and
 * varies only the per-run ceilings, so one row's figures are every row's figures - and the
 * test asserts exactly that, so a row that ever varied them fails CI rather than quietly
 * making this sentence wrong for one workflow. The fix then is to give the posture a
 * workflow, never to edit a digit.
 */
const STATEMENT_BOUNDS = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;

/**
 * The engines agent mode can execute on, named as the product names them.
 *
 * The join is `namedList` and not `join(" and ")`: with three execution engines the local
 * join printed "PostgreSQL and SQLite and DuckDB" here and on the login hero, which had a
 * copy of the same line. One helper serves both.
 */
const engineNames = (types: readonly DatabaseType[]): string => namedList(types.map((type) => getDBConfig(type).label));

/**
 * The terms of the auto-execute consent, as ONE sentence-run rather than as JSX prose: the
 * figures are interpolated and a formatter is free to reflow JSX text around them, which is
 * how "500-row limit" becomes "500 -row limit" without anyone touching the copy. This is the
 * sentence a user consents to, so it is written and rendered as written.
 *
 * It takes the workflow rather than reading a selection, because there is no longer a
 * selection to read at the moment it is shown: the consent step is reached with a workflow
 * already decided — by the classifier or by the user under Advanced — and the bounds it names
 * are that workflow's own.
 *
 * It lives here, beside the posture that quotes it, so the strip's widened body and the
 * checkbox's accessible description are one string with one author.
 *
 * The language has no default. The terms are that language's own, and a caller that named
 * none would be shown SQL's on whatever engine it is on; a language whose variants offer no
 * hand-over says so in its own sentence rather than borrowing another language's terms.
 */
export function autoExecuteTerms(workflowType: AgentRunWorkflowType, language: AgentStatementLanguageId): string {
  return handoverTerms(AGENT_WORKFLOW_BUDGETS[workflowType].policy.budgets, language);
}

/** The consent sentence itself, over whichever row named it, in the language's own terms. */
function handoverTerms(budgets: StatementBudgets, language: AgentStatementLanguageId): string {
  return languageClientPack(language).posture.handoverTerms(budgets);
}

/** The plan words every engine reads unless its language says its own. */
function sharedPlanCopy(): AgentPostureCopy {
  return {
    qualifier: "one schema read grounds it, nothing else reaches the database",
    title: "Plan mode drafts, and never runs what it drafted",
    body: `Plan mode never executes the statement it wrote, on any engine — production included. Its one reach is the schema capture that grounds it: metadata only, no data rows, and it is where the inventory in Run details came from. On ${engineNames(CATALOG_CAPTURE_ENGINES)} that capture is itself a catalog read; on every other engine it asks the provider to describe its own schema.`,
  };
}

/**
 * Plan mode, on every engine, with or without the hand-over ticked: the shared words, or the language's own where the
 * shared ones are not true of it (its pack's `posture.plan`, Modbus's among them). Safe either way, because plan mode
 * never executes what it drafts.
 */
function planPosture(language: AgentStatementLanguageId | null): AgentPosture {
  const own = language === null ? undefined : languageClientPack(language).posture.plan?.();
  return rendered("safe", "Executes nothing it drafts", own ?? sharedPlanCopy());
}

/**
 * Agent mode on an engine whose provider implements no read-only statement path.
 *
 * Two facts travel with the refusal because leaving either out reads as a dead end: plan
 * mode drafts here, and the `operations` workflow runs here too where it opens - it composes no
 * statement at all, so its acquisition never asks the engine for a read-only one. The body is
 * `noAdapterSentence`, the start route's refusal, so the strip and the refusal say one thing.
 *
 * The body says the refusal happens AT START, which is what `POST /api/agent/runs` now
 * does: a run whose workflow sends a statement is refused from the connection's own type
 * before a run id exists (#512). It used to say the run ends
 * `engine-unsupported` before its first statement, which was true while the refusal was
 * the provider factory's alone - and would now describe a run this build does not open.
 *
 * It says "a boundary it declares" and not "database-native": the engines it lists are not
 * all bounded by the database. The SQL engines are, by a read-only session; Kubernetes is
 * bounded by Studio's request allowlist and the identity's RBAC. Each executable engine's
 * own posture names its boundary, so this arm only promises that one is declared.
 */
function unsupportedPosture(engine: AgentEngine, engineLabel: string): AgentPosture {
  const operationsOpens = operationsWorkflowOpens(engine);
  return {
    tone: "blocked",
    headline: `Cannot execute on ${engineLabel}`,
    qualifier: operationsOpens
      ? "plan mode drafts here, and the operations workflow still runs"
      : "plan mode drafts here",
    title: `Agent mode has no read-only statement path on ${engineLabel}`,
    body: noAdapterSentence(engineLabel, operationsOpens),
  };
}

/**
 * The refusal of a statement-sending run on an engine with no statement language, naming it and the ways forward that
 * remain on it: the operations workflow only where it opens, `operationsOpens` (`operationsWorkflowOpens`), as
 * `notReviewedSentence` names it. Every legacy engine with no language opens the operations workflow, since every
 * legacy engine opens at least one workflow in agent mode (tests/unit/lib/agent/agent-manifest.test.ts), so the
 * unsupported posture of each says it.
 */
export function noAdapterSentence(engineLabel: string, operationsOpens: boolean): string {
  const refusal = `Agent mode executes only where the provider implements a read-only statement path under a boundary it declares: ${engineNames(GRANTED_AGENT_EXECUTION_ENGINES)}. On ${engineLabel} a run whose workflow sends a statement is refused when it is started, before a run is opened.`;
  return operationsOpens
    ? `${refusal} The operations workflow still runs here, because it sends no statement at all: it takes the operational readings this engine offers agent mode. Plan mode drafts on every engine.`
    : `${refusal} Plan mode drafts on every engine.`;
}

/**
 * The sentence the start route refuses a run with where `workflowAvailability` is closed on `engine`, its engine
 * record, naming the engine by the record's display name and the operations workflow only where it opens: the
 * no-adapter sentence for an engine with no language (the unsupported posture's body on a legacy engine), the
 * not-reviewed sentence, the no-statement-session sentence, and the manifest's own sentence for a missing variant or an
 * unmet requirement.
 */
export function startRefusalSentence(
  availability: Extract<AgentWorkflowAvailability, { open: false }>,
  engine: AgentEngine & { readonly displayName: string },
): string {
  const operationsOpens = operationsWorkflowOpens(engine);
  switch (availability.cause) {
    case "no-adapter":
      return noAdapterSentence(engine.displayName, operationsOpens);
    case "not-reviewed":
      return notReviewedSentence(engine.displayName, operationsOpens);
    case "no-statement-session":
      return noStatementSessionSentence(engine.displayName, operationsOpens);
    default:
      return availability.sentence;
  }
}

/**
 * Agent mode on an engine whose language would run its statements but whose grants hold no agent execution.
 *
 * The start route refuses such a run with `notReviewedSentence` (`workflowAvailability`'s `not-reviewed`), so the
 * body is that sentence, and the strip and the refusal say one thing; both name the operations workflow only where it
 * opens (`operationsWorkflowOpens`). The pill is the unsupported arm's, which is true here too; the title is not,
 * because such an engine may well have a read-only statement path: what it lacks is Studio's review of it. No shipped
 * engine reaches this arm, since an engine has a language exactly when its row grants it agent execution
 * (`tests/unit/lib/agent/agent-manifest.test.ts`); a language registered for an engine with no such grant reads as
 * blocked rather than as reads.
 */
function notReviewedPosture(engine: AgentEngine, engineLabel: string): AgentPosture {
  const operationsOpens = operationsWorkflowOpens(engine);
  return {
    tone: "blocked",
    headline: `Cannot execute on ${engineLabel}`,
    qualifier: operationsOpens
      ? "plan mode drafts here, and the operations workflow still runs"
      : "plan mode drafts here",
    title: `Studio has not reviewed agent mode's read-only statement path on ${engineLabel}`,
    body: notReviewedSentence(engineLabel, operationsOpens),
  };
}

/**
 * Agent mode on a connection whose last run was refused for the connection itself: its user, its credential or the
 * server behind it. The engine runs agent mode, so the reads posture would be true of the engine and false of this
 * connection: measured 2026-10-17 on an admin MongoDB seed, the strip said "Reads only, enforced by the server" before
 * Start, and Start then refused the run. The sentence is the refusal's own, so the strip, the card and the timeline
 * say one thing. The operations workflow is named as still running only where it opens (`operationsWorkflowOpens`):
 * an engine that offers agent mode no curated reading does not open it.
 */
function refusedPosture(engine: AgentEngine, engineLabel: string, refusal: string): AgentPosture {
  const title = `Agent mode cannot run on this ${engineLabel} connection as it is configured`;
  if (!operationsWorkflowOpens(engine)) {
    return {
      tone: "blocked",
      headline: "Refused on this connection",
      qualifier: "plan mode drafts here",
      title,
      body: `${refusal} Plan mode drafts on every connection.`,
    };
  }
  return {
    tone: "blocked",
    headline: "Refused on this connection",
    qualifier: "plan mode drafts here, and the operations workflow still runs",
    title,
    body: `${refusal} Plan mode drafts on every connection, and the operations workflow still runs here, because it sends no statement.`,
  };
}

/**
 * Agent mode with no resolved connection.
 *
 * Blocked, because agent mode cannot execute anything from here - but blocked WITHOUT the
 * engine claim, which is the whole reason this is its own arm rather than
 * `unsupportedPosture("this connection")`. Nothing has been read, so "has no read-only
 * statement path" would be a statement about an engine this panel has not seen; what is true
 * is that it does not know which engine you are on. The caller's `engineLabel` is ignored on
 * purpose: with `engine` null it is a label for nothing.
 */
function unresolvedPosture(): AgentPosture {
  return {
    tone: "blocked",
    headline: "Cannot execute yet",
    qualifier: "no connection is resolved, so no engine has been established",
    title: "Agent mode has no connection to execute on",
    body: `Agent mode executes only where the provider implements a read-only statement path under a boundary it declares: ${engineNames(GRANTED_AGENT_EXECUTION_ENGINES)}. No connection is resolved here, so this panel cannot say which engine you are on, or whether it is one of those: until one is resolved, agent mode executes nothing. The operations workflow sends no statement at all, so it runs on every engine that offers agent mode an operational reading, and plan mode drafts on every engine.`,
  };
}

/**
 * Whether a tick of the hand-over widens anything in this language: some workflow variant of it hands a statement to
 * the editor. The same fact the start route refuses `autoExecute` from and the rail offers the tick from, read off the
 * language's variants rather than off its posture words, so a pack cannot widen or narrow the strip by its copy.
 */
function offersHandover(language: AgentStatementLanguageId): boolean {
  return Object.values(languageClientPack(language).variants).some((variant) => variant?.canAutoExecute === true);
}

/**
 * Agent mode with the editor hand-over consented, in the language's own words (its client pack's `widened`).
 *
 * @throws {Error} When the language offers the hand-over and its pack supplies no widened words: its reads words
 *   would say nothing reaches the editor, which is false under a consented hand-over.
 */
function widenedPosture(language: AgentStatementLanguageId): AgentPosture {
  const widened = languageClientPack(language).posture.widened;
  if (widened === undefined) {
    throw new Error(
      `The "${language}" language pack offers the editor hand-over and supplies no widened posture copy.`,
    );
  }
  return rendered("widened", "Reads only, and one statement in your editor", widened(STATEMENT_BOUNDS));
}

/** Agent mode, executing on its own path and nowhere else, in the language's own words (its client pack's `reads`). */
function readsPosture(language: AgentStatementLanguageId): AgentPosture {
  return rendered("reads", "Reads only", languageClientPack(language).posture.reads(STATEMENT_BOUNDS));
}

/**
 * The rail's reading of the selected mode, in the order the arms EXCLUDE each other.
 *
 * Plan mode first, because the hand-over cannot widen it - there is no statement of the run's
 * to hand over. It is safe on every engine, in the shared words except where the engine's language pack
 * says its own, because the shared ones are not true of it (Modbus). Then the arms that know no bounds to
 * state: no connection, an engine with no statement language, and an engine whose language the review
 * record does not back. Only then does a refusal of this connection, and only then the hand-over, which
 * is why a ticked hand-over on an unsupported engine still reads as blocked rather than as widened. The
 * hand-over widens only in a language some of whose variants hand a statement over; elsewhere a tick
 * consents to nothing and the reading stays the reads one.
 *
 * Each arm decides its tone and its headline here; a language pack supplies the words of the plan,
 * reads and widened arms and nothing that ranks them.
 *
 * Whether the engine executes is its legacy grants' answer, `statementLanguage` and then `agentExecution`
 * (`legacyAgentEngine`), in the order the start route refuses from them (`workflowAvailability`),
 * so the strip and the refusal cannot disagree about an engine. Both are read on every call,
 * not folded into a constant at module load, so the copy follows the grants in the process
 * that is running. The language is also what the executing arms speak
 * in, so a cluster's posture names Studio's allowlist and RBAC where a SQL engine's names
 * the database's read-only session.
 *
 * Before every arm, plan mode's included, an engine that is not a type id is refused by name, as the start route
 * refuses it, so no arm answers for an engine that names no provider.
 *
 * @throws {UnknownProviderError} When `engine` is neither null nor a type id.
 */
export function agentPosture(input: {
  readonly mode: AgentRunMode;
  readonly engine: DatabaseType | null;
  readonly engineLabel: string;
  readonly handover: boolean;
  /** The refusal the last run on THIS connection met for the connection itself, if it met one. */
  readonly refusedHere?: string | null;
}): AgentPosture {
  const engine = input.engine === null ? null : legacyAgentEngine(input.engine);
  const language = engine === null ? null : grantedAgentStatementLanguage(engine);
  if (input.mode === "planning") return planPosture(language);
  if (engine === null) return unresolvedPosture();
  if (language === null) return unsupportedPosture(engine, input.engineLabel);
  if (!engine.grants.agentExecution) return notReviewedPosture(engine, input.engineLabel);
  if (typeof input.refusedHere === "string") {
    return refusedPosture(engine, input.engineLabel, input.refusedHere);
  }
  return input.handover && offersHandover(language) ? widenedPosture(language) : readsPosture(language);
}
