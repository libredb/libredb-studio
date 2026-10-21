/** The chip and the sentence the agent's consent card shows for an engine whose long read ends differently. */
export interface ConsentDeadline {
  /** The chip in the ticked bounds row, tone "warn" (the tone stays in the card). */
  readonly chip: string;
  /** The paragraph under the box, shown ticked or not. */
  readonly sentence: string;
}

export interface ExecutionUiSpec {
  /**
   * The keyword that keeps an open transaction, named in the rolled-back notice.
   *
   * THE KEYWORD IS THE ENGINE'S, not SQL's. The rolled-back notice in use-query-execution.ts
   * said "Add COMMIT" while the only caller of the ender was a SQL script route. Naming the
   * wrong one tells them to type a command their engine does not have.
   */
  readonly commitKeyword: string;
  /** The consent card's deadline chip and sentence, or null where the engine has none. */
  readonly consentDeadline: ConsentDeadline | null;
}
