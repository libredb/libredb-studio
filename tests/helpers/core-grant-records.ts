/**
 * The closed list of the exit of milestone M3 of the provider plugins program: every grant record and grant projection
 * keyed by engine id that a module of Studio's `src/` still exports, each with the change that removes it, an item of
 * M3 or, for a projection a browser module reads, milestone M7 and those readers.
 * tests/unit/db/no-core-grant-records.test.ts holds core to it, and tests/unit/db/claim-grants.test.ts holds the grant
 * reader's engine-keyed exports to its M7 entries; a module of its own so both read it without importing a test file.
 */

/** What removes a record: an item of M3, or milestone M7 with the browser modules that read the projection. */
export type RemovedBy = { readonly item: 4 } | { readonly milestone: "M7"; readonly readers: readonly string[] };

export interface GrantRecordEntry {
  readonly module: string;
  readonly name: string;
  readonly removedBy: RemovedBy;
}

export const CLAIM_GRANTS = "src/lib/db/claim-grants.ts";

/** Every grant record and projection keyed by engine id that core still exports, with what removes it. */
export const CORE_GRANT_RECORDS: readonly GrantRecordEntry[] = [
  { module: "src/lib/db/sql-grammar/redaction.ts", name: "SQL_TEXT_REDACTION", removedBy: { item: 4 } },
  { module: "src/lib/db/confirmation-claim-review.ts", name: "CONFIRMATION_CLAIM_REVIEW", removedBy: { item: 4 } },
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_WRITE_REACH",
    removedBy: {
      milestone: "M7",
      readers: ["src/components/read-only-marker.tsx", "src/hooks/use-connection-form.ts"],
    },
  },
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_SSH_TUNNEL_REFUSAL",
    removedBy: { milestone: "M7", readers: ["src/lib/db-ui-config.ts"] },
  },
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_AGENT_STATEMENT_LANGUAGE",
    removedBy: {
      milestone: "M7",
      readers: ["src/components/agent/AgentRail.tsx", "src/lib/agent/agent-manifest.ts", "src/lib/agent/posture.ts"],
    },
  },
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_AGENT_READINGS",
    removedBy: { milestone: "M7", readers: ["src/lib/agent/agent-manifest.ts"] },
  },
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_AGENT_EXECUTION_ENGINES",
    removedBy: {
      milestone: "M7",
      readers: ["src/components/login/hero-proof.tsx", "src/lib/agent/agent-manifest.ts", "src/lib/agent/posture.ts"],
    },
  },
];
