/**
 * The Kubernetes provider's labels: the words the shared panels use for this engine.
 *
 * Pure, and shipped to the browser: `getLabels()` answers before connect, through `POST /api/db/provider-meta`.
 * `statementLanguage` is what plan mode states verbatim after "Write it in" (`src/lib/agent/investigation.ts`), the one
 * fact about how a statement is written that its prompt carries per engine, so it is built from the console's own
 * command table and cannot drift from what the parser takes.
 */
import type { ProviderLabels } from "@/lib/db/types";
import { KUBECTL_COMMAND_TABLE } from "./console/commands";

/** Two statements the sentence gives as examples: a list, and one object's description. */
export const KUBECTL_STATEMENT_EXAMPLES: readonly [string, string] = Object.freeze([
  "kubectl get pods -n shop",
  "kubectl describe deployment/web -n shop",
]) as readonly [string, string];

/** A command as a usage line writes it: its words, its arguments, then each flag of its column, in brackets. */
function usage(command: (typeof KUBECTL_COMMAND_TABLE)[number]): string {
  return [command.command, command.arguments, ...command.flags.map((flag) => `[${flag}]`)]
    .filter((part) => part !== "")
    .join(" ");
}

/** The sentence plan mode states, built from the command table, so every command and flag the parser takes is named. */
export function kubectlStatementLanguage(): string {
  const usages = KUBECTL_COMMAND_TABLE.map(usage).join(", ");
  return `the kubectl command this editor runs: exactly one read-only command per run, written as kubectl writes it, optionally after kubectl, with no pipe, no redirect, no second command and no connection flag such as --context, --kubeconfig or --token, because the connection decides the cluster and the identity; the commands are ${usages}; get reads one resource type per statement, never get all or TYPE,TYPE; -o takes wide, name, json or yaml, never jsonpath or custom-columns; logs reads the latest lines and never follows; every command that writes or runs code (apply, delete, edit, patch, scale, exec, port-forward and the rest) is refused; for example ${KUBECTL_STATEMENT_EXAMPLES[0]} or ${KUBECTL_STATEMENT_EXAMPLES[1]}`;
}

export const KUBERNETES_LABELS: ProviderLabels = Object.freeze({
  // The noun plan mode's inventory and the object search use for a kind's objects.
  entityName: "Resource",
  entityNamePlural: "Resources",
  rowName: "Object",
  rowNamePlural: "Objects",
  selectAction: "Get",
  generateAction: "Generate Command",
  // Never rendered (`supportsMaintenance: false`); worded true anyway, as etcd's and Oxia's are.
  analyzeAction: "Statistics",
  vacuumAction: "Maintenance",
  searchPlaceholder: "Search namespaces and objects...",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc: "Kubernetes keeps no statistics for Studio to update.",
  vacuumGlobalLabel: "Maintenance",
  vacuumGlobalTitle: "Not available",
  vacuumGlobalDesc: "Studio sends a Kubernetes cluster no maintenance and no write.",
  statementLanguage: kubectlStatementLanguage(),
  slowQueriesEmptyState: "Kubernetes keeps no query log",
  sessionsEmptyState: "Kubernetes does not list client sessions",
  tableStatsCaption:
    "Kubernetes has no tables: the tree lists objects per kind and namespace, and the console reads them with get.",
});
