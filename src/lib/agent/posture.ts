/**
 * What the SELECTED MODE does to the database, on one axis: what does it execute?
 *
 * The rail used to answer that question in six places at once - a mode description, a
 * consent paragraph, a budget note, a guard line, a refusal and a claim under the answer -
 * and a user comparing two of them could not tell which one bounded the run. This module is
 * the single reading, in four levels, and it is the ONLY thing the safety strip renders.
 *
 * It states nothing new. Every claim here is a claim some other module enforces:
 * `AGENT_EXECUTION_ENGINES` mirrors the factory's profile gate, the figures come from the
 * workflow policy rows and from `AGENT_HANDOVER_BUDGET`, and the hand-over paragraph IS the
 * sentence the consent step shows - `autoExecuteTerms` below is that one source, exported so
 * the strip and the consent card cannot drift into two versions of a sentence a user agrees
 * to.
 *
 * Three properties are load-bearing and easy to lose:
 *
 *  - **Client-safe imports only** - types, `AGENT_EXECUTION_ENGINES`, the manifest's
 *    `AGENT_STATEMENT_LANGUAGE`, the language packs' client facets (`languages/client.ts`, where each
 *    language's reads, widened and hand-over sentences live), the engines' client facets (`languages/engines/client.ts`), `getDBConfig` and the policy constants. A provider module here would drag `oracledb`/`mssql` toward a bundle
 *    that must not have them, which is the rule `engine-support.ts` records in its header.
 *  - **Every engine name and every number is DERIVED.** Not one is typed as a literal, and
 *    not one is a count. The point of #425 is that "7+" was written when the answer was 7
 *    and stayed while the answer became 11; the same trap is one edit away here, because
 *    each of these sentences names a set the server decides.
 *  - **The qualifier is visible, never folded into the popover.** A bare "executes nothing"
 *    overclaims: on the dialects with a `catalogCapture`, plan mode's grounding capture IS a
 *    catalog read, and `engine-support.ts` says in its own header that copy compressing these
 *    facts overclaims. The strip therefore shows both halves on one line, and the popover
 *    carries the full claim rather than the missing half.
 */

import { AGENT_STATEMENT_LANGUAGE, type AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { languageClientPack } from "@/lib/agent/languages/client";
import { enginesSupporting } from "@/lib/agent/languages/engines/client";
import type { StatementBudgets } from "@/lib/agent/languages/pack";
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

/** Plan mode, on every engine, with or without the hand-over ticked. */
function planPosture(): AgentPosture {
  return {
    tone: "safe",
    headline: "Executes nothing it drafts",
    qualifier: "one schema read grounds it, nothing else reaches the database",
    title: "Plan mode drafts, and never runs what it drafted",
    body: `Plan mode never executes the statement it wrote, on any engine — production included. Its one reach is the schema capture that grounds it: metadata only, no data rows, and it is where the inventory in Run details came from. On ${engineNames(CATALOG_CAPTURE_ENGINES)} that capture is itself a catalog read; on every other engine it asks the provider to describe its own schema.`,
  };
}

/**
 * Agent mode on an engine whose provider implements no read-only statement path.
 *
 * Two facts travel with the refusal because leaving either out reads as a dead end: plan
 * mode drafts here, and the `operations` workflow runs here too - it composes no statement
 * at all, so its acquisition never asks the engine for a read-only one.
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
function unsupportedPosture(engineLabel: string): AgentPosture {
  return {
    tone: "blocked",
    headline: `Cannot execute on ${engineLabel}`,
    qualifier: "plan mode drafts here, and the operations workflow still runs",
    title: `Agent mode has no read-only statement path on ${engineLabel}`,
    body: `Agent mode executes only where the provider implements a read-only statement path under a boundary it declares: ${engineNames(AGENT_EXECUTION_ENGINES)}. On ${engineLabel} a run whose workflow sends a statement is refused when it is started, before a run is opened. The operations workflow still runs here, because it sends no statement at all: it calls the curated reporting methods every provider implements. Plan mode drafts on every engine.`,
  };
}

/**
 * Agent mode on a connection whose last run was refused for the connection itself: its user, its credential or the
 * server behind it. The engine runs agent mode, so the reads posture would be true of the engine and false of this
 * connection: measured 2026-10-17 on an admin MongoDB seed, the strip said "Reads only, enforced by the server" before
 * Start, and Start then refused the run. The sentence is the refusal's own, so the strip, the card and the timeline
 * say one thing.
 */
function refusedPosture(engineLabel: string, refusal: string): AgentPosture {
  return {
    tone: "blocked",
    headline: "Refused on this connection",
    qualifier: "plan mode drafts here, and the operations workflow still runs",
    title: `Agent mode cannot run on this ${engineLabel} connection as it is configured`,
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
    body: `Agent mode executes only where the provider implements a read-only statement path under a boundary it declares: ${engineNames(AGENT_EXECUTION_ENGINES)}. No connection is resolved here, so this panel cannot say which engine you are on, or whether it is one of those: until one is resolved, agent mode executes nothing. The operations workflow sends no statement at all, so it runs wherever a connection does, and plan mode drafts on every engine.`,
  };
}

/** Agent mode with the editor hand-over consented, in the language's own terms (its client pack's `widened`). */
function widenedPosture(language: AgentStatementLanguageId): AgentPosture {
  return languageClientPack(language).posture.widened(STATEMENT_BOUNDS);
}

/** Agent mode, executing on its own path and nowhere else, in the language's own terms (its client pack's `reads`). */
function readsPosture(language: AgentStatementLanguageId): AgentPosture {
  return languageClientPack(language).posture.reads(STATEMENT_BOUNDS);
}

/**
 * The rail's reading of the selected mode, in the order the arms EXCLUDE each other.
 *
 * Plan mode first, because the hand-over cannot widen it - there is no statement of the run's
 * to hand over. It reads the same on every engine except where the engine's language pack
 * declares a plan posture of its own, because the shared one is not true of it (Modbus). Then the two arms that know no bounds to
 * state: no connection, and an engine agent mode cannot execute a statement on. Only then
 * does the hand-over matter, which is why a ticked hand-over on an unsupported engine still
 * reads as blocked rather than as widened.
 *
 * Whether the engine executes is `AGENT_STATEMENT_LANGUAGE`'s answer, the record the start
 * route refuses from, so the strip and the refusal cannot disagree about an engine. It and
 * `AGENT_EXECUTION_ENGINES`, which names the engines in the copy, are read on every call,
 * not folded into a constant at module load, so the copy follows the lists in the process
 * that is running. The same record's answer is also the language the executing arms speak
 * in, so a cluster's posture names Studio's allowlist and RBAC where a SQL engine's names
 * the database's read-only session.
 */
export function agentPosture(input: {
  readonly mode: AgentRunMode;
  readonly engine: DatabaseType | null;
  readonly engineLabel: string;
  readonly handover: boolean;
  /** The refusal the last run on THIS connection met for the connection itself, if it met one. */
  readonly refusedHere?: string | null;
}): AgentPosture {
  const language = input.engine === null ? null : AGENT_STATEMENT_LANGUAGE[input.engine];
  if (input.mode === "planning") {
    return (language === null ? undefined : languageClientPack(language).posture.plan?.()) ?? planPosture();
  }
  if (input.engine === null) return unresolvedPosture();
  if (language === null) return unsupportedPosture(input.engineLabel);
  if (typeof input.refusedHere === "string") return refusedPosture(input.engineLabel, input.refusedHere);
  return input.handover ? widenedPosture(language) : readsPosture(language);
}
