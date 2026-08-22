/**
 * The shape a per-model file may declare, and the rule every one of them obeys.
 *
 * Separate from `index.ts` so a model file imports the contract without importing the
 * registry that lists it — otherwise every profile would depend on every other profile
 * through the barrel, and adding one would be a change to all of them.
 */

import type { AgentRunWorkflowType } from "../types";

/** How a turn is sampled. Structural output, so the default explores nothing. */
export interface AgentSampling {
  readonly temperature: number;
  readonly topP: number;
}

export interface AgentModelProfile {
  /**
   * What was measured to justify this profile, in numbers.
   *
   * Required, and a test refuses a profile whose measurement is too short to be one. An
   * override with no measurement behind it cannot be told apart from a guess, and a
   * directory of per-model settings is exactly where guesses would accumulate unnoticed:
   * each one looks local and harmless, and together they become a configuration nobody can
   * justify or delete.
   */
  readonly measured: string;
  /** Sampling for this model on every surface, where it differs from the default. */
  readonly sampling?: Partial<AgentSampling>;
  /** Sampling for named surfaces only, which is the narrowest an override can be. */
  readonly perWorkflow?: Partial<Record<AgentRunWorkflowType, Partial<AgentSampling>>>;
  /**
   * How many calls this model may make without reporting before the run is narrowed to the
   * tools that would finish it.
   *
   * A model that reads more thoroughly than the run has room for needs this lower than the
   * default. `gemma4:26b` is the measured case: its passing assessments profile four tables,
   * and the one that lost profiled eleven and had nothing left to report with — one call
   * under the general ceiling of 12, so the guard never fired.
   */
  readonly unreportedCallCeiling?: number;
  /**
   * How many times a drive may answer a no-call turn with the report reminder.
   *
   * One is enough for a model that stopped because it forgot; it is not enough for a model
   * that stops as its habit. `gemma4:26b` is the measured case: across ten assessments every
   * losing run gathered its evidence, produced a turn with neither a call nor a report, took
   * the single reminder, and stopped again — with most of the run's time still unspent.
   */
  readonly reportReminderLimit?: number;
  /**
   * How many extra turns a PLAN run gets when its prose named no statement and no refusal.
   *
   * Zero by default, because a run that answered its objective is not obviously owed another
   * turn, and 24 models clear this bar unaided. `qwen3:14b` is the measured case: its losing
   * plan describes all eight tables and every relation and then stops without the fenced
   * statement or the explicit refusal that plan mode scores.
   */
  readonly planStatementRetries?: number;
  /**
   * How much of the run's clock is reserved for the report, in milliseconds.
   *
   * The general reserve is sized for a turn on this workload, and a reasoning model's turn is
   * not that turn. `deepseek-r1:8b` is the measured case: its query-optimization runs spend
   * 50 to 160 seconds inside a single model call, so a notice delivered with 20 seconds left
   * arrives at a run that cannot complete a turn to act on it. Both of its losing runs had
   * already drafted the statement and recorded two index recommendations, and died on the
   * deadline with the analysis done and nothing filed.
   */
  readonly reportReserveMs?: number;
  /**
   * Whether a report may be held for the verdict it would earn when no turn is left to act on
   * the holding.
   *
   * True everywhere, because the hold is what teaches a run what its report is missing. False
   * where the teaching cannot land: `deepseek-r1:8b` called `compose_report` at 383 seconds of
   * a 450-second run, was held and told to inspect a plan first, and had no 100-second turn
   * left to do it in. The hold turned a report that would have scored one shortfall into no
   * report at all.
   */
  readonly holdReportWithoutTime?: boolean;
  /**
   * Whether a run that answered without calling anything is still told to report.
   *
   * The drive withholds the report reminder from a run that called no tool, and the reasoning
   * holds for most models: a run that established nothing is stopping, not hesitating, and a
   * second telling spends a turn to learn that. `nemotron-3.5-lightning:30b` is the case it
   * gets wrong. Asked what tables exist, it answered correctly in 29 seconds — all eight,
   * named — from the inventory the run was handed, called nothing, and was scored `no-report`
   * for using the wrong channel rather than for having nothing to say.
   */
  readonly remindWithoutTools?: boolean;
  /**
   * Whether the report reminder waits until the run holds something it could cite.
   *
   * The reminder above, arriving at a moment nothing could satisfy it. `deepseek-r1:14b` on
   * database-assessment heard it as the first thing in the run, obeyed, and was declined
   * `UNVERIFIABLE_EVIDENCE` five times in a row before it had read anything at all; its first
   * `profile_table` came after the last refusal, and the run ended having spent 503 seconds
   * proving it could follow an instruction that could not be followed.
   *
   * A run with no artifact and no snapshot cannot cite one, and the refusal it earns cannot
   * even name what it might have cited. Off by default: the reminder's whole value for
   * `nemotron-3.5-lightning:30b` is that it fires for a run holding an inventory rather than
   * a reading, and that case must keep working exactly as measured.
   */
  readonly requireEvidenceBeforeReminder?: boolean;
  /**
   * Whether a turn that came back EMPTY is asked again before the run is ended.
   *
   * What `gemma4:26b` had been losing database-assessment to across fifteen measured runs, and
   * what it took the stopping-turn record to see. The loss was read as a model declining to
   * file, and two fixes aimed at that reading were measured and deleted: a second reminder took
   * the cell from 4/5 to 2/5, a lower call ceiling to 3/5.
   *
   * Neither was the illness. The losing runs carry no stopping text at all — no
   * `model-stopped-saying`, no `closing-statement`, both of which are written whenever there is
   * any — and end within seconds of the reminder. The model returns an empty completion, twice:
   * once before the reminder, which the loop already survives, and once after, which ends it.
   *
   * An empty turn is not a model that chose to stop, and a run holding readings it has not
   * filed has everything done but the last call. Off by default: a model that answers nothing
   * twice over may well be stopping, and spending a turn to find that out is a turn taken from
   * every other model's reading.
   */
  readonly retryEmptyTurn?: boolean;
  /**
   * How many times a report may be held to ask for the answer that belongs beside it.
   *
   * One is enough for a model that forgot. `mistral-small3.2:24b` does not forget: held once
   * on data-analysis and told to present its answer first, it composes the report anyway, and
   * the report lands with an empty answer pane and a `no-answer` verdict.
   */
  readonly presentReminderLimit?: number;
  /**
   * How many times a report may be held to ask for the plan comparison the verdict wants.
   *
   * One is enough for a model that forgot to compare. It is not enough for one that inspects a
   * single plan and reports regardless: `lfm2:24b` did that on three separate optimization
   * runs, each with one plan, one hold and no comparison.
   */
  readonly compareReminderLimit?: number;
  /**
   * Every sentence this model is told, when it is told anything.
   *
   * Here for the reason the numbers above are here, and the reason is not symmetry. A message
   * is read by a model and acted on by that model, so a wording that recovers one run can be
   * the wording another model gives up on — which makes it a measured value, not a constant.
   *
   * The alternative was measured too, twice, and it is why this field exists: a shared wording
   * changed for everyone wins some cells and loses others, and the only move left is to revert
   * the whole change and give back the wins. With the sentence per model, the models it helped
   * keep it and the models it hurt keep what they had.
   */
  readonly notices?: Partial<AgentNotices>;
  /**
   * Whether a refused call is handed a worked example built from this run's ledger.
   *
   * OFF by default for the same reason. Measured on `lfm2:24b`, where it collapsed a loop of
   * twenty-eight identical `INVALID_TOOL_INPUT` refusals into one — the model took the example
   * and got the shape right on its next turn. That is a real effect on a real ledger and it did
   * not win the cell, so it is on for that model and off everywhere else until another
   * measurement says otherwise.
   */
  readonly refusalExamples?: boolean;
}

/**
 * The four sentences the drive says to a run, each at the one moment it can still be acted on.
 *
 * Named by what the run is missing rather than by which tool was refused, because that is what
 * a reader of a model file needs to decide whether the wording fits their model.
 */
export interface AgentNotices {
  /** A run that used its tools and then narrated instead of calling `compose_report`. */
  readonly reportReminder: string;
  /** A PLAN run whose prose carried neither a runnable statement nor an explicit refusal. */
  readonly planStatement: string;
  /** An answer-presenting run about to report a result it read but never presented. */
  readonly presentBeforeReport: string;
}

/**
 * The general ceiling, which is what every locked cell was measured against.
 *
 * Twelve is deliberately generous: it is a backstop against a run that is looping rather than
 * a budget for a run that is working, and a model that needs it lower says so in its own file
 * rather than lowering it for everyone.
 */
export const DEFAULT_UNREPORTED_CALL_CEILING = 12;

/**
 * One reminder, which is what every locked cell was measured against.
 *
 * A reminder costs a turn out of a fixed run budget, so a second one is not free: it is time
 * taken from a run that might have used it to read. A model that needs two says so in its own
 * file, where the cost lands on that model's runs alone.
 */
export const DEFAULT_REPORT_REMINDER_LIMIT = 1;

/**
 * No extra turn, which is what every locked plan cell was measured against.
 *
 * A plan run that produced prose has answered or it has not, and the verifier reads that for
 * itself. Offering another turn to every model would change 24 models' runs to reach one.
 */
export const DEFAULT_PLAN_STATEMENT_RETRIES = 0;

/**
 * Twenty seconds, which is what `AGENT_REPORT_RESERVE_MS` has always been and what every
 * locked cell was measured against.
 *
 * Held here as well so a profile overriding it is read next to the value it replaces. Raising
 * it for everyone would move the reserve on 24 models to rescue one, and the reserve is time
 * taken out of the reading half of every run.
 */
export const DEFAULT_REPORT_RESERVE_MS = 20_000;

/**
 * Held, which is what every locked cell was measured against.
 *
 * A run that is told what its report is missing usually fixes it, and that is where several
 * locked cells came from. The exception is a run with no turn left, and only a model whose
 * turns are long enough to hit that says so in its own file.
 */
export const DEFAULT_HOLD_REPORT_WITHOUT_TIME = true;

/** Off, for the same reason, and on where a ledger showed the loop it ends. */
export const DEFAULT_REFUSAL_EXAMPLES = false;

/**
 * Withheld, which is what every locked cell was measured against.
 *
 * A run that called nothing has usually stopped, and reminding it spends a turn to confirm
 * that. The exception is a model that answers the question straight out of the inventory it
 * was given, which looks identical from here and is not the same thing at all.
 */
export const DEFAULT_REMIND_WITHOUT_TOOLS = false;

/**
 * Unconditional, which is what every locked cell was measured against.
 *
 * The reminder fires on the run's state as the drive already reads it, and 107 cells locked
 * that way. Only a model whose ledger shows it obeying the reminder into a wall of refusals
 * earns the wait, and it earns it alone.
 */
export const DEFAULT_REQUIRE_EVIDENCE_BEFORE_REMINDER = false;

/**
 * Not asked again, which is what every locked cell was measured against.
 *
 * An empty turn ends the run, and for most models that reading is right: nothing came back
 * because nothing more was coming. Only a model whose ledger shows the empty turn arriving with
 * the work already done earns the retry.
 */
export const DEFAULT_RETRY_EMPTY_TURN = false;

/**
 * One, which is what every locked answer-presenting cell was measured against.
 *
 * A model told once what its report is missing usually supplies it. A second telling is a
 * turn spent arguing with a model that has already declined, so it stays per-model.
 */
export const DEFAULT_PRESENT_REMINDER_LIMIT = 1;

/**
 * One, which is what every locked optimization cell was measured against.
 *
 * The hold spends a turn out of a fixed budget and names two ways through — a second plan to
 * compare, or an index recommendation citing the plan already held — so a model that heard it
 * and did neither is usually declining rather than missing it.
 */
export const DEFAULT_COMPARE_REMINDER_LIMIT = 1;

/**
 * Deterministic, and the setting five locked cells were won on.
 *
 * Choosing a tool and filling in its arguments is a structural task; there is nothing a
 * sample is meant to explore, and a report wants the most likely sentence rather than a
 * surprising one. Where that reasoning fails for a particular model it fails measurably, and
 * that model's own file says so.
 */
export const DEFAULT_SAMPLING: AgentSampling = Object.freeze({ temperature: 0, topP: 1 });
