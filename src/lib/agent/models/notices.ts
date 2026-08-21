/**
 * The baseline wording of every sentence the drive says to a run.
 *
 * Here, beside the model files, rather than in `investigation.ts` where these used to live —
 * because a model file has to be able to state the wording IT was measured with, and it cannot
 * import the drive that imports it.
 *
 * What this file is NOT is the source the drive reads. Every measured model carries its own
 * copy in its own file, so changing a sentence here changes nothing for any of them; it is the
 * text a generated file is written from, and the text a model nobody has measured is given.
 *
 * Why the copies exist at all, in one line: a wording is read by a model and acted on by that
 * model, so it is a measured value and not a constant. Twice this repository changed a shared
 * sentence, won several cells and lost others, and had nothing to do but revert the whole
 * change and hand back the wins. A per-model sentence keeps the wins where they landed.
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
