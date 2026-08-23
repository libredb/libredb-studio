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
   * One is enough for a model that forgot. One evaluated model did not forget: held once
   * on data-analysis and told to present its answer first, it composes the report anyway, and
   * the report lands with an empty answer pane and a `no-answer` verdict.
   */
  readonly presentReminderLimit?: number;
  /**
   * How long ONE turn of this model may take, where the shipped limit does not fit it.
   *
   * The product allows 90 seconds a turn, which is a statement about how long a person waits
   * rather than about any model. `qwen3.5:9b` is the measured case where the two disagree: five
   * of its surfaces clear comfortably and its plan turn is bimodal — 26 seconds when it lands,
   * 92 to 94 when it does not — so the cell scores 1/5 by finishing just the wrong side of the
   * line. Measured the same on the build from before this branch merged `main`, so it is neither
   * a regression nor a hot laptop; the 5/5 that put this model on the list was taken when the
   * limit was 150.
   *
   * Per model rather than raising the default, because the default is the promise made to
   * everyone: nine models finish inside it, and moving it for the tenth spends every other
   * user's patience on a model they may not be running.
   */
  readonly turnTimeoutMs?: number;

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
   * OFF by default for the same reason. Measured on one model, where it collapsed a loop of
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

/** Off, for the same reason, and on where a ledger showed the loop it ends. */
export const DEFAULT_REFUSAL_EXAMPLES = false;

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
 * Deterministic, and the setting five locked cells were won on.
 *
 * Choosing a tool and filling in its arguments is a structural task; there is nothing a
 * sample is meant to explore, and a report wants the most likely sentence rather than a
 * surprising one. Where that reasoning fails for a particular model it fails measurably, and
 * that model's own file says so.
 */
export const DEFAULT_SAMPLING: AgentSampling = Object.freeze({ temperature: 0, topP: 1 });
