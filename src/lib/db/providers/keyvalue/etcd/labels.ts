/**
 * The etcd provider's labels (#1089, spec 6.3).
 *
 * `statementLanguage` is what plan mode states verbatim after "Write it in" (`src/lib/agent/investigation.ts`),
 * the one fact about how a statement is written that its prompt carries per engine. So it carries the subset:
 * one command per run, the reads plan mode may draft with the flags the parser takes, read from the parser's
 * own table so the two cannot drift, how a prefix row is read, two examples, and that every write is the
 * user's to type. `tests/unit/db/etcd/labels.test.ts` parses each example with `commands.ts` and classifies it
 * with `guard.ts`.
 */
import type { ProviderLabels } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { ETCD_COMMAND_TABLE, type EtcdCommandKind } from "./commands";

/**
 * The read commands of spec 5.1.3 that plan mode drafts, in the order of the parser's table. `txn` is left
 * out: it reads only while neither branch writes, so it is named with the writes as the user's to type, and
 * every draft stays one line.
 */
export const ETCD_DRAFTED_READS: readonly EtcdCommandKind[] = [
  "get",
  "watch",
  "lease-timetolive",
  "lease-list",
  "member-list",
  "endpoint-status",
  "endpoint-health",
  "alarm-list",
  "auth-status",
  "user-list",
  "user-get",
  "role-list",
  "role-get",
];

/** The two reads the sentence gives as examples: a prefix group's keys, and the members read without the leader. */
export const ETCD_STATEMENT_EXAMPLES: readonly [string, string] = [
  "get /app/config/ --prefix --limit=50",
  "member list --consistency=s",
];

/** A command as etcdctl's help writes it: its words, its arguments, then each flag the parser takes, in brackets. */
function usage(command: (typeof ETCD_COMMAND_TABLE)[number]): string {
  const parts = [...command.words];
  if (command.arguments !== "") parts.push(command.arguments);
  for (const flag of command.flags) parts.push(`[${flag}]`);
  return parts.join(" ");
}

const DRAFTED_USAGES = ETCD_COMMAND_TABLE.filter((command) => ETCD_DRAFTED_READS.includes(command.kind))
  .map(usage)
  .join(", ");

export const ETCD_LABELS: ProviderLabels = {
  entityName: "Key Prefix",
  entityNamePlural: "Key Prefixes",
  rowName: "Key",
  rowNamePlural: "Keys",
  selectAction: "Get Keys",
  generateAction: "Generate Command",
  searchPlaceholder: "Search key prefixes...",
  statementLanguage: `the etcdctl command this editor runs: exactly one command per run, written as etcdctl writes it, with no pipe, no redirect, no second command and no connection flag such as --endpoints or --cacert, because the connection decides where a command runs and as whom; plan mode drafts only a read, one of ${DRAFTED_USAGES}, with --limit at most ${DEFAULT_QUERY_LIMIT}; a key-prefix row such as /app/config/* is read with get /app/config/ --prefix, never with a * in the key; for example ${ETCD_STATEMENT_EXAMPLES[0]} or ${ETCD_STATEMENT_EXAMPLES[1]}; a txn and every write (put, del, lease grant, lease revoke, lease keep-alive) is typed by the user in the editor and never drafted`,
  slowQueriesEmptyState: "etcd keeps no query log",
  sessionsEmptyState: "etcd does not report client sessions",
  // What the rows of getTableStats are (spec 6.3, 7.1): some keys belong to no group (spec 4.1) and a capped
  // walk lists fewer groups than exist (spec 4.3), so the Tables tab lists the groups rather than summing them.
  tableStatsCaption: "The key-prefix groups; a key in no group is counted in the Overview and not here",
  // Never rendered (spec 6.3): etcd offers none of the operations the legacy analyze and vacuum cards send,
  // and its own three operations are declared cards worded by their specs (maintenance.ts). Worded true anyway.
  analyzeAction: "Key Prefix Statistics",
  vacuumAction: "Compact History",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc: "etcd keeps no statistics to update; the Tables tab counts each key-prefix group when it opens.",
  vacuumGlobalLabel: "Compact",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Compaction is the Compact history card of Global Operations, which asks for a typed confirmation.",
};
