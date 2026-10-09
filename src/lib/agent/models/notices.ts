/**
 * The wording of every sentence the drive says to a run, and the ONLY source of it.
 *
 * Read that literally, because this file used to say the opposite and the opposite is now false.
 * Each measured model once carried its own copy of these sentences in its own module, so a
 * change here reached none of them. The modules are gone, the settings are data, and wording is
 * the one thing the document may not carry — so every run of every model is told exactly what is
 * written below. EDITING A SENTENCE HERE CHANGES WHAT EVERY MEASURED MODEL IS TOLD.
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
  turnCutOff: [
    "Your last turn was cut off at this server's per-call limit and nothing from it was kept: whatever you were working out has not reached this run, and this run cannot see it.",
    "The run itself is not over. It has most of its time and nearly all of its steps left, and it ends only when you file something.",
    "Do not work that turn out again — a turn cut for taking too long will be cut again. Act in ONE short move now: if you already know what you would say, call compose_report with what this conversation established; otherwise make one tool call and nothing else.",
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
  unreadStop: [
    "You have stopped without reading anything, and there is nobody to reply to you: this run has no correspondent, so a request for information ends it with nothing established.",
    /*
      The sentence that answers the question these runs actually ask.

      "Read it yourself" answers "how do I read". Measured 2026-10-04, the question was WHICH
      statement: `devstral-small-2:24b` holds five of six surfaces at 5/5 and loses optimize the
      same way five times out of five - zero tools, stopped in nine to thirteen seconds with "I
      need the query text to investigate why it is slow. Please provide the employee listing query
      you are asking about." Told to call `inspect_plan` "for how a statement will run", it asked
      again: `inspect_plan` takes a statement, and it had none.

      It never would. The objective names a query in prose - this repository's own optimize
      objective is "Why is the employee listing query slow?" - and the sample holds no
      `employee_listing` object, which `composedSql`'s docblock records as the shape three other
      families tripped on from the other side, calling `inspect_schema` for it and citing the empty
      result. No run on any surface is handed SQL; every one drafts its own from the inventory it
      was given. Saying so is what turns a reasonable question into a next step.
    */
    "No statement was given to you and none is coming: write the one you need from the schema inventory in this conversation, then inspect its plan.",
    "Read it yourself. Call inspect_schema for the tables and their columns, and inspect_plan for how a statement will run, then call compose_report with what you found.",
    CITATION_RULE,
  ].join(" "),
  toolCallAsText: [
    "Your last turn was a tool CALL written into the message text, so no tool ran: this server executes calls that arrive through the tool channel and reads the message text as words.",
    "Make the same call again as a tool call, through the tool interface your client offers, rather than writing the call out as a message.",
  ].join(" "),
  unreadableToolCall: [
    "Your last tool call could not be read: this server's model endpoint refused to parse its arguments, so no tool ran and nothing about it reached this run.",
    "The arguments of a tool call must be a JSON object and nothing else. Do not write your reasoning, a sentence, or a code fence in the argument field — send only the object, starting at its opening brace.",
    "Make the call again, arguments only.",
  ].join(" "),
});
