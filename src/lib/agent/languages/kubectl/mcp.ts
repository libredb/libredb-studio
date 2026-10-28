/**
 * The kubectl language's MCP facet: `run_kubectl_read`, offered only machine-redacted.
 *
 * The MCP module reads it with the agent's own reader, admission and `queryReadOnly`, so every answer is the machine
 * projection `machine-redaction.ts` masks, Secret names in the fields defined to hold one included, and never the
 * editor's. Free-text messages are that projection's residue, and the description says so.
 *
 * No `database` key: a Kubernetes connection names its namespace in the statement (`-n`, `-A`) and declares no
 * `catalogSessions`, so `providerInDatabase` would refuse every call that named one, as the agent's own kubectl tool
 * leaves it out. The statement's length is the admission's to refuse, in the sentence an agent run reads.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const KUBECTL_MCP_FACET = Object.freeze({
  tool: "run_kubectl_read",
  title: "Run a read-only kubectl read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  // Every Kubernetes kind is `config`, none a relation, so inspect_schema has nothing to list and refuses it by name.
  holdsNoTables: true,
  describe: ({ engines, limits }) =>
    `Run one read-only kubectl read on a connection: one line, with or without the kubectl word, such as "get pods -n shop", "describe deployment/web -n shop", "logs pod/web -n shop --tail=50", "top pod -n shop", "events -n shop --types=Warning", "api-resources", "explain deployment.spec", "auth can-i list pods -n shop", "auth whoami" or "version". Writes, exec, port-forward, proxy, a watch (-w) and Studio's paging line are refused before the cluster is reached. The answer is masked as an agent read is: a Secret's name in every field defined to hold one, Secret and ConfigMap values, env and header values, a container's command and args, and annotation values read <redacted>. Free-text status, event and log messages are not masked, so a Secret's name or a value an application printed can reach you there. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so narrow the read with -n, -l or --field-selector.`,
  words: {
    fewerFields: "Read fewer fields, without -o wide, -o yaml or -o json,",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, split the read into narrower ones, since a kubectl read is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Read it in a shorter form, without -o yaml or -o json, and run it again.",
    reached: "the cluster",
  },
} as const satisfies AgentLanguageMcpFacet);
