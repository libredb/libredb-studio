/**
 * The billed-read allowance of one agent run, or of one MCP call.
 *
 * Some engines bill every read: a read of N documents costs N, whatever the statement, the row cap or the time it
 * took. The per-statement budget (`ReadOnlyStatementBudget`) bounds what one result may carry, not what a run may
 * spend across all its reads, and a provider cannot keep that count itself: providers are cached and shared by every
 * run on the same connection (`provider-cache-key.ts`), so a counter on the provider would be one ledger for every
 * run at once. So the count lives here, created once per run (once per call on MCP, which has no run), and travels to
 * the provider inside every budget that run hands it, as `ReadOnlyStatementBudget.readAllowance`.
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

export class RunReadAllowance {
  #spent = 0;

  /** `limit` is the most billed reads the run may spend: a positive whole number, refused otherwise. */
  constructor(readonly limit: number) {
    if (!isPositiveWholeNumber(limit)) {
      throw new RangeError(`read allowance: the limit must be a positive whole number of reads, got ${String(limit)}`);
    }
  }

  /** The billed reads still unspent. */
  remaining(): number {
    return this.limit - this.#spent;
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
        `${READ_ALLOWANCE_PREFIX}: ${label} needs ${units} billed reads, and ${left} of the ${this.limit} this run may spend is left`,
      );
    }
    this.#spent += units;
  }
}
