/**
 * The Oxia provider's labels (SB2-9.2) and the key order in words (SB2-9.3).
 *
 * Pure, and shipped to the browser: `getLabels()` answers before connect, through `POST /api/db/provider-meta`.
 * `statementLanguage` is what plan mode states verbatim after "Write it in" (`src/lib/agent/investigation.ts`), the
 * one fact about how a statement is written that its prompt carries per engine, so it is built from the parser's own
 * table and cannot drift from it; `tests/unit/db/oxia/labels.test.ts` parses each example with the parser and
 * classifies it with the confirmation gate's reader.
 */
import type { ProviderLabels } from "@/lib/db/types";
import { OXIA_COMMAND_TABLE, type OxiaCommandKind } from "./commands";
import { OXIA_MAX_LIMIT } from "./constants";
import type { OrderVerdict } from "./order";

/** The reads plan mode drafts, in the order of the parser's table: all three. */
export const OXIA_DRAFTED_READS: readonly OxiaCommandKind[] = Object.freeze(["get", "list", "range-scan"]);

/** The two reads the sentence gives as examples: a prefix's keys, and one key. */
export const OXIA_STATEMENT_EXAMPLES: readonly [string, string] = Object.freeze([
  "list --prefix /admin/policies/ --limit 50",
  "get /admin/policies/public",
]) as readonly [string, string];

/** A command as a usage line writes it: its verb, its arguments, then each flag the parser takes, in brackets. */
function usage(command: (typeof OXIA_COMMAND_TABLE)[number]): string {
  return [command.verb, command.arguments, ...command.flags.map((flag) => `[${flag}]`)].join(" ");
}

/** SB2-9.2's sentence, built from the parser's table, so a verb or a flag the parser takes is named here too. */
export function oxiaStatementLanguage(): string {
  const usages = OXIA_COMMAND_TABLE.filter((command) => OXIA_DRAFTED_READS.includes(command.verb))
    .map(usage)
    .join(", ");
  return `the oxia client read command this editor runs: exactly one command per run, written as oxia client writes it, optionally after oxia client, with no pipe, no redirect, no second command and no -a, -n or --auth-token, because the connection decides where a command runs, in which namespace and as whom; plan mode drafts only a read, one of ${usages}, with --limit at most ${OXIA_MAX_LIMIT}; the keys under a path P are read with list --prefix P/ or range-scan --prefix P/, never with -s P/ -e P//, which misses keys under natural key order; keys under __oxia/ are never read; for example ${OXIA_STATEMENT_EXAMPLES[0]} or ${OXIA_STATEMENT_EXAMPLES[1]}; every write (put, delete, delete-range) and every stream (notifications, sequence-updates) is the user's to run with the oxia CLI and is never drafted`;
}

export const OXIA_LABELS: ProviderLabels = Object.freeze({
  // The one kind the tree draws a folder for, and the noun plan mode's inventory uses (`inventoryNoun`).
  entityName: "Shard",
  entityNamePlural: "Shards",
  rowName: "Key",
  rowNamePlural: "Keys",
  selectAction: "List Keys",
  generateAction: "Generate Command",
  // Never rendered (`supportsMaintenance: false`); worded true anyway, etcd's rule.
  analyzeAction: "Shard Statistics",
  vacuumAction: "Compact",
  searchPlaceholder: "Search shards...",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc: "Oxia keeps no statistics to update.",
  vacuumGlobalLabel: "Compact",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Oxia compacts its own storage, and Studio sends it no maintenance.",
  statementLanguage: oxiaStatementLanguage(),
  slowQueriesEmptyState: "Oxia keeps no query log",
  sessionsEmptyState: "Oxia does not list client sessions",
  tableStatsCaption:
    "Oxia has no tables: its shards are listed under Shards, and its keys in the Keys panel and with list in the console.",
});

/**
 * The namespace's key order and how it was learned, as the shard Source tab's `key_order_learned` says it (SB2-9.3).
 * The three detection paths are worded alike, because how the probe decided is not a fact the reader acts on; an
 * `assumed` verdict is hierarchical by its definition (SB1-7.2), and an exhausted one never claims that no key
 * holds `/`.
 */
export function keyOrderWords(verdict: OrderVerdict): string {
  if (verdict.learnedBy === "empty") return "empty namespace";
  if (verdict.learnedBy === "assumed")
    return verdict.exhausted === true
      ? "hierarchical, assumed: Studio could not tell the orders apart from the keys read"
      : "hierarchical: no key holds /";
  return `${verdict.order}, detected from key order`;
}
