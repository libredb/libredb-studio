/**
 * The billed-read allowance of one agent run, or of one MCP call.
 *
 * Some engines bill every read: a read of N documents costs N, whatever the statement, the row cap or the time it
 * took. The per-statement budget (`ReadOnlyStatementBudget`) bounds what one result may carry, not what a run may
 * spend across all its reads, and a provider cannot keep that count itself: providers are cached and shared by every
 * run on the same connection (`provider-cache-key.ts`), so a counter on the provider would be one ledger for every
 * run at once. So the count lives here, created once per drive of a run and opened with what the run's earlier drives
 * spent (once per call on MCP, which has no run), and travels to the provider inside every budget that drive hands it,
 * as `ReadOnlyStatementBudget.readAllowance`. The run records its spend as it goes (`spent()`), so a resumed drive
 * starts from what is left rather than whole.
 *
 * The unit is engine-neutral, "billed reads": each engine that charges says in its provider doc what one unit is.
 * A provider charges BEFORE it sends the request, with what the request may cost at most, so a read that would pass
 * the limit is refused without being sent rather than billed and then refused. Every billed request charges,
 * statements, retries, grounding, sampling and catalog reads alike.
 *
 * `charge` is synchronous, so the check and the spend cannot be split by an `await`: two statements of one run that
 * reach their charge together cannot both take the last unit, because one of them runs to completion first.
 */

import { ReadAllowanceExceededError } from "./errors";

/** The opening of the refusal, the read allowance's twin of the row and byte budget openings. */
export const READ_ALLOWANCE_PREFIX = "Read-only execution exceeded the read allowance";

function isPositiveWholeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Who spends an allowance, as its refusal names it: an agent run, or one call that has no run. */
export type ReadAllowanceScope = "run" | "call";

export interface ReadAllowanceOptions {
  /**
   * What was already spent against `limit` before this allowance was opened: a resumed drive's earlier drives, read
   * back from the run's ledger. A whole number, zero or more; a figure past the limit leaves nothing.
   */
  readonly spent?: number;
  /** The word the refusal names the spender with; "run" unless said otherwise. */
  readonly scope?: ReadAllowanceScope;
}

export class RunReadAllowance {
  #spent: number;
  readonly #scope: ReadAllowanceScope;

  /** `limit` is the most billed reads the run may spend: a positive whole number, refused otherwise. */
  constructor(
    readonly limit: number,
    options: ReadAllowanceOptions = {},
  ) {
    if (!isPositiveWholeNumber(limit)) {
      throw new RangeError(`read allowance: the limit must be a positive whole number of reads, got ${String(limit)}`);
    }
    const spent = options.spent ?? 0;
    if (!Number.isSafeInteger(spent) || spent < 0) {
      throw new RangeError(`read allowance: what was spent must be a whole number of reads, got ${String(spent)}`);
    }
    this.#spent = spent;
    this.#scope = options.scope ?? "run";
  }

  /** The billed reads still unspent, never below zero. */
  remaining(): number {
    return Math.max(0, this.limit - this.#spent);
  }

  /** The billed reads spent so far, those it was opened with included: the figure a run records as it goes. */
  spent(): number {
    return this.#spent;
  }

  /**
   * Spends `units` billed reads for the request `label` names, or refuses the whole charge with
   * `ReadAllowanceExceededError` when it would pass the limit; a refused charge spends nothing. `units` that are not
   * a positive whole number are a miswired caller, refused with a RangeError.
   */
  charge(units: number, label: string): void {
    if (!isPositiveWholeNumber(units)) {
      throw new RangeError(`read allowance: a charge must be a positive whole number of reads, got ${String(units)}`);
    }
    const left = this.remaining();
    if (units > left) {
      throw new ReadAllowanceExceededError(
        `${READ_ALLOWANCE_PREFIX}: ${label} needs ${units} billed reads, and ${left} of the ${this.limit} this ${this.#scope} may spend is left`,
      );
    }
    this.#spent += units;
  }
}
