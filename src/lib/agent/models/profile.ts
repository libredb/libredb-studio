/**
 * The shape one entry of `../model-tuning/measured-profiles.json` resolves to, and the compiled
 * defaults every entry is read against.
 *
 * Separate from `index.ts` so the document's schema can import the contract without importing the
 * resolvers that read it.
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
   * document of per-model settings is exactly where guesses would accumulate unnoticed: each one
   * looks local and harmless, and together they become a configuration nobody can justify or
   * delete.
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
   * Stated by every measured profile, and the number a profile states is what that model gets:
   * 0 where the model was watched declining the ask, 1 where the extra turn is what closed the
   * cell. `qwen3:14b` is the measured case for 1 — its losing plan describes all eight tables and
   * every relation and then stops without the fenced statement or the explicit refusal that plan
   * mode scores.
   *
   * A model with no profile is a different question, and it is answered in `planStatementAsksFor`
   * rather than here: absence is not a measurement, so an unmeasured model is asked once.
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
   * Whether a run that stopped WITHOUT CALLING ANYTHING is told to read the database itself.
   *
   * A different loss from the empty turn above, and from the report reminder: this model says
   * something, and what it says is a request. `nemotron3:33b` lost query-optimization to it
   * twice — once recorded in its own file as "asking for the SQL of the statement it was sent
   * to diagnose", then again ten seconds into a later run, asking the user to paste the
   * statement while holding `inspect_schema` and `inspect_plan`. There is nobody to answer: a
   * run has no correspondent, so the question is a stop dressed as a turn.
   *
   * `remindToReport` cannot reach it. That notice tells a run to file what it established and
   * is gated on `anyToolCalled` for good reason — a run that read nothing has nothing to file.
   * The sentence this one needs is the other half: not "report what you found" but "find it".
   *
   * Free, which is the whole safety argument. `compose_report` is one of the run's tools, so a
   * run that called nothing composed no report and has already earned `no-report`; the turn is
   * spent on a run that has lost. It cannot cost a pass, only recover a failure.
   *
   * Off by default even so. The ten models locked at 300/300 were measured without it, and a
   * drive-wide change is twice how this repository has handed back cells it had won.
   *
   * It SUBSUMES `retryEmptyTurn`, and that is a property of the gate rather than of the name.
   * The condition is "called nothing", with no test on what was said, so an empty completion
   * reaches it too and a model carrying both switches spends two extra turns rather than one.
   * Where this is true `retryEmptyTurn` decides nothing, whatever the entry records - measured
   * on `nemotron3:33b`, whose entry says `false` and whose empty turns are asked again anyway.
   * Written down rather than fixed: narrowing the gate to a non-empty turn would change the
   * behaviour the five passing runs were measured under, and this repository does not move a
   * measured cell without re-measuring it. See `docs/BACKLOG.md`.
   */
  readonly retryUnreadStop?: boolean;

  /**
   * Whether this model's PLAN turn asks the endpoint for no reasoning at all.
   *
   * Measured on `muse-glimmer:latest`, whose plan cell was 0/5 with every loss a `model-timeout`
   * at exactly 90 seconds — an empty ledger, no tool invoked, the turn spent thinking rather than
   * answering. With `reasoning_effort: "none"` the same five runs finish in 16 to 21 seconds.
   * `qwen3.6:27b` and `gemma4:12b` were measured on the same shape and carry it too.
   *
   * PLAN ONLY, and gated on the run's MODE rather than on whether it was handed tools: an
   * agent run on the prompted protocol is toolless too, and that is the path four of the
   * twenty-five measured models take. The five agent cells were measured WITH reasoning, and
   * a setting applied where nothing was measured is a guess wearing a measurement's clothes.
   *
   * It reaches the OPENAI-COMPATIBLE adapter only. `providerOptions` is keyed `openai`, which
   * is right for the three kinds `provider-registry.ts` builds through `@ai-sdk/openai`
   * (`openai`, `ollama`, `custom`) and reaches nothing on `gemini`, which is `@ai-sdk/google`
   * and reads its own key. So this is a no-op on the one hosted provider Studio ships an
   * adapter for, silently — stated here because every model measured with it is local, and
   * an operator who sets it on a Gemini model is owed the sentence rather than the silence.
   */
  readonly suppressPlanReasoning?: boolean;
  /**
   * Whether this model's AGENT turns ask the endpoint for no reasoning at all.
   *
   * The same remedy as the field above, on the surfaces it deliberately does not reach, and a
   * separate switch rather than a widening of it: a model measured needing quiet on plan was not
   * measured needing it while holding tools, and reading one field for both would move cells
   * nobody re-measured. `muse-glimmer:latest` carried the plan one for a whole branch before a
   * measurement earned it this one, and must not acquire either by association.
   *
   * Measured on `gemma4:12b`, whose investigate cell read 5/5 at 9 seconds and, on a later
   * serving engine, 1/5: four losses spending the whole turn without invoking a single tool
   * before the clock ended them, against passing runs that still finish in 9. Bimodal — it
   * either answers at once or thinks until the wall — which is the shape this addresses and
   * `turnTimeoutMs` does not: a turn spent thinking finds the new wall too.
   *
   * Reaches the OPENAI-COMPATIBLE adapter only, exactly as its sibling does, and is silently a
   * no-op on `gemini`.
   */
  readonly suppressAgentReasoning?: boolean;
  /**
   * How many times a report whose own verdict would REJECT it may be held and told why.
   *
   * The third of the reminder bounds and the last to become per-model. Its two siblings have
   * been per-model since they were written; this one was a module constant, so a model whose
   * ledgers showed a third ask landing had nowhere to record that.
   *
   * Two stays the default and the argument for it is untouched: measured in the eval scripts
   * rather than reasoned about, at three a run that will not comply pays three wasted turns
   * before the same verdict it was always going to get, and the gate evals had to be extended
   * twice to see it. That argument is about what EVERY model should get by default. It says
   * nothing about a model measured recovering on the third — and until this field there was no
   * way to tell those two apart, so the second case was answered as though it were the first.
   *
   * Safe in the way the bound itself is safe: this hold fires only where a report is being
   * submitted that its own verifier would reject, so a run about to pass cannot reach it. What
   * a raised limit can cost is turns on a run that has already lost; what it can buy is the
   * turn on which a model finally does the thing it was asked for.
   *
   * Nobody carries anything but the default yet. It is written so a measurement CAN be
   * recorded, not because one has been.
   */
  readonly verdictHoldLimit?: number;

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
   * How much of a CONVERSATION this model may be handed, in characters.
   *
   * Absent everywhere it ships, and deliberately so: this is the one setting here that
   * carries no measurement at all. It exists because the value that is right is a
   * function of the model's context window — what a hosted 200k-window model can carry
   * is not what a small local one can — and this document is how an operator who HAS
   * measured their own supplies it without a Studio release.
   *
   * Absent resolves to `AGENT_THREAD_CONTEXT_MAX_CHARS`, which is what drives every
   * model today.
   */
  readonly threadContextMaxChars?: number;

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
 * The three sentences the drive says to a run, each at the one moment it can still be acted on.
 *
 * Named by what the run is missing rather than by which tool was refused, because that is what a
 * reader deciding whether a wording fits needs to know.
 */
export interface AgentNotices {
  /** A run that used its tools and then narrated instead of calling `compose_report`. */
  readonly reportReminder: string;
  /** A PLAN run whose prose carried neither a runnable statement nor an explicit refusal. */
  readonly planStatement: string;
  /**
   * A turn the per-call ceiling cut off, on a run whose own deadline still has room.
   *
   * The one stop shape in the drive that had no recovery path. Measured on `qwen3.6:35b`: nine
   * losses, every one cut at the ceiling with 333 to 353 seconds of a 450-second deadline and 34
   * of 36 turns unspent, while the same cell's longest PASSING run took 183 seconds.
   */
  readonly turnCutOff: string;
  /** An answer-presenting run about to report a result it read but never presented. */
  readonly presentBeforeReport: string;
  /** A run that stopped without calling anything, having asked for what it could have read. */
  readonly unreadStop: string;
}

/**
 * The general ceiling, which is what every locked cell was measured against.
 *
 * Twelve is deliberately generous: it is a backstop against a run that is looping rather than
 * a budget for a run that is working, and a model that needs it lower says so in its own entry
 * rather than lowering it for everyone.
 */
export const DEFAULT_UNREPORTED_CALL_CEILING = 12;

/**
 * One reminder, which is what every locked cell was measured against.
 *
 * A reminder costs a turn out of a fixed run budget, so a second one is not free: it is time
 * taken from a run that might have used it to read. A model that needs two says so in its own
 * entry, where the cost lands on that model's runs alone.
 */
export const DEFAULT_REPORT_REMINDER_LIMIT = 1;

/**
 * No extra turn, which is what every locked plan cell was measured against.
 *
 * A plan run that produced prose has answered or it has not, and the verifier reads that for
 * itself. This is the number a MEASURED profile falls back to when it states none, and every
 * profile that ships states one, so in practice it changes no measured model's run.
 *
 * It is not what an unmeasured model gets. That is `planStatementAsksFor`, which answers 1: a
 * model nobody has watched has not been watched declining the ask either, and refusing it a turn
 * on the strength of a missing measurement is the server deciding by silence.
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
 * A run that stops having called nothing keeps its ending, unless a model's ledger asked.
 *
 * Off despite being free to grant — the turn is spent on a run whose verdict is already
 * `no-report` — because "free" is an argument about cost, not about wording. The sentence sent
 * is read by the model and acted on by it, so it is a measured value like every other, and it
 * belongs to the models measured with it rather than to all of them at once.
 */
export const DEFAULT_RETRY_UNREAD_STOP = false;

/**
 * Off, because every model but one was measured thinking and passing.
 *
 * A drive-wide change here is how this repository has twice handed back cells it had already
 * won, so the switch stays per-model and per-mode.
 */
export const DEFAULT_SUPPRESS_PLAN_REASONING = false;

/**
 * Off, for the same reason and with the same blast radius as its sibling above.
 *
 * Separate from it rather than one field read twice: a model measured needing quiet on plan was
 * not measured needing it while holding tools, and the two populations are not the same one.
 */
export const DEFAULT_SUPPRESS_AGENT_REASONING = false;

/**
 * One, which is what every locked answer-presenting cell was measured against.
 *
 * A model told once what its report is missing usually supplies it. A second telling is a
 * turn spent arguing with a model that has already declined, so it stays per-model.
 */
export const DEFAULT_PRESENT_REMINDER_LIMIT = 1;

/**
 * Two, and the number is the eval scripts' rather than an argument's.
 *
 * At three, a run that will not comply pays three wasted turns before the same verdict it was
 * always going to get, and the gate evals had to be extended twice to see that. Two changes the
 * behaviour the ledgers complain about — a model that ignored one ask gets a second — at half
 * the cost to a model that will never comply.
 *
 * It moved out of `investigation.ts` and into a default so a model CAN be measured needing a
 * third; the value it moved with is the value it had.
 */
export const DEFAULT_VERDICT_HOLD_LIMIT = 2;

/**
 * Deterministic, and the setting five locked cells were won on.
 *
 * Choosing a tool and filling in its arguments is a structural task; there is nothing a
 * sample is meant to explore, and a report wants the most likely sentence rather than a
 * surprising one. Where that reasoning fails for a particular model it fails measurably, and
 * that model's own entry says so.
 */
export const DEFAULT_SAMPLING: AgentSampling = Object.freeze({ temperature: 0, topP: 1 });
