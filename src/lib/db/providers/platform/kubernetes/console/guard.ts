/**
 * What a kubectl statement is to the confirmation gate: the vocabulary row's `refuse`.
 *
 * Pure, and shipped to the browser: `src/lib/db/destructive-commands.ts` reads it through the reading the provider
 * runs (`readKubectlRun`), so what the editor refuses and what the provider refuses are one parse of one text. v1 only reads, so nothing asks
 * for a confirmation; a statement the parser refuses is never sent, never posted for analysis and never stored.
 */
import { readKubectlRun } from "./paging";

/** The sentence the provider would refuse the text with, paging line included; undefined to send it. */
export function kubectlRefusal(text: string): string | undefined {
  const run = readKubectlRun(text);
  return run.ok ? undefined : run.message;
}
