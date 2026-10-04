/**
 * What an Oxia command is to the confirmation gate (SB2-4.1): the vocabulary row's `read`, `refuse` and its empty set
 * of destructive operations.
 *
 * Pure, and shipped to the browser: `src/lib/db/destructive-commands.ts` reads it for the gate, with the parser the
 * provider runs, so what asks and what runs are one parse of one text. v1 only reads (O1), so nothing asks; what the
 * parser refuses, the editor refuses before anything is sent. The browser knows no connection, so it reads with an
 * empty context: a -a or -n that names another connection is accepted here and refused by the provider (SB2-12 D7).
 */
import { parseOxiaCommand } from "./commands";

/** The operations the confirmation gate asks about: none, because v1 only reads (O1). */
export const OXIA_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/** The vocabulary row's `refuse`: the parser with the browser's context; undefined to send. */
export function oxiaRefusal(text: string): string | undefined {
  const parsed = parseOxiaCommand(text, {});
  return parsed.ok ? undefined : parsed.refusal.message;
}

/** The vocabulary row's `read`: [verb] for a text oxiaRefusal accepts ("get", "list" or "range-scan"); undefined otherwise. */
export function readOxiaOperations(text: string): readonly string[] | undefined {
  const parsed = parseOxiaCommand(text, {});
  return parsed.ok ? [parsed.parsed.command.kind] : undefined;
}
