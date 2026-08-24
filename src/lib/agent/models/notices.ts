/**
 * The wording of every sentence the drive says to a run, and the ONLY source of it.
 *
 * Read that literally, because this file used to say the opposite and the opposite is now false.
 * Each measured model once carried its own copy of these three sentences in its own module, so a
 * change here reached none of them. The modules are gone, the settings are data, and wording is
 * the one thing the document may not carry — so every run of every model is told exactly what is
 * written below. EDITING A SENTENCE HERE CHANGES WHAT ALL TEN MEASURED MODELS ARE TOLD.
 *
 * That is a real cost, and it is why the digests are pinned in
 * `tests/unit/lib/agent/model-resolution-table.test.ts`: an edit here turns that test red and asks
 * whether the models were re-measured. Twice this repository changed a shared sentence, won several
 * cells and lost others, and had nothing to do but revert the whole change and hand back the wins.
 * A wording is read by a model and acted on by that model, which makes it a measured value and not
 * a constant — so the red test is the point, not an obstacle.
 *
 * Wording stays in code rather than travelling in the document for two reasons. `planStatement`
 * interpolates `PLAN_NO_STATEMENT_MARKER`, so a literal copy in data would drift from the marker
 * the verifier looks for; and the document is shaped to be supplied from outside Studio, where
 * carrying prompt text would let whoever writes it decide what Studio says to a model mid-run.
 */

import { PLAN_NO_STATEMENT_MARKER } from "../plan-draft";
import type { AgentNotices } from "./profile";

/**
 * Repeated inside a notice rather than referenced, because a notice arrives on its own: a run
 * being told to report is not re-reading the rules it was opened with.
 */
const CITATION_RULE =
  "Every claim must cite evidence: an artifact id this run produced, or the fingerprint of the schema snapshot it captured.";

export const BASELINE_NOTICES: AgentNotices = Object.freeze({
  reportReminder: [
    "You have called this run's tools and then written your findings as prose, which records nothing: a run reports by CALLING compose_report, and text outside that call is not a report.",
    "Call compose_report now with what you established.",
    CITATION_RULE,
  ].join(" "),
  planStatement: [
    "Your plan describes the database but names no statement, and a plan is scored on what the user can run: it must end either with a fenced code block holding one statement for this engine, or with an explicit refusal.",
    `Write the statement in a fenced block now, or begin a line with ${PLAN_NO_STATEMENT_MARKER} and say what the database does not support.`,
  ].join(" "),
  presentBeforeReport: [
    "This run answers by PRESENTING a result, and nothing has been presented yet: a report on its own is scored as having answered nothing.",
    "Your compose_report call was not run. Call present_answer first, with the artifact id of the result that answers the objective, and then call compose_report.",
  ].join(" "),
});
