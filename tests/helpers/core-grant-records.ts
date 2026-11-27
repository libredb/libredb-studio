/**
 * The closed list of the exit of milestone M3 of the provider plugins program: every grant record and grant projection
 * keyed by engine id that a module of Studio's `src/` still exports, and every function answering a legacy engine's
 * grants by its id, each with the changes that remove it, an item of M3 or, for a projection or a function a browser
 * module reads, milestone M7 and those readers, and, for a function the legacy adapter reads, milestone M18, which
 * deletes the legacy adapter, and that reader.
 * tests/unit/db/no-core-grant-records.test.ts holds core to it, and tests/unit/db/claim-grants.test.ts holds the grant
 * reader's engine-keyed exports to its M7 entries; a module of its own so both read it without importing a test file.
 */

/**
 * What removes a record or one set of its readers: an item of M3, milestone M7 with the browser modules that read the
 * projection, or milestone M18, the legacy adapter's deletion, with the legacy adapter's modules that read it.
 */
export type RemovedBy =
  | { readonly item: 4 }
  | { readonly milestone: "M7"; readonly readers: readonly string[] }
  | { readonly milestone: "M18"; readonly readers: readonly string[] };

export interface GrantRecordEntry {
  readonly module: string;
  readonly name: string;
  /** Every removal of the record, one per milestone its readers leave at, so each reader keeps its own milestone. */
  readonly removedBy: readonly [RemovedBy, ...RemovedBy[]];
}

export const CLAIM_GRANTS = "src/lib/db/claim-grants.ts";

/** Every grant record and projection keyed by engine id that core still exports, with what removes it. */
export const CORE_GRANT_RECORDS: readonly GrantRecordEntry[] = [
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_WRITE_REACH",
    removedBy: [
      {
        milestone: "M7",
        readers: ["src/components/read-only-marker.tsx", "src/hooks/use-connection-form.ts"],
      },
    ],
  },
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_SSH_TUNNEL_REFUSAL",
    removedBy: [{ milestone: "M7", readers: ["src/lib/db-ui-config.ts"] }],
  },
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_AGENT_STATEMENT_LANGUAGE",
    removedBy: [
      {
        milestone: "M7",
        readers: ["src/components/agent/AgentRail.tsx", "src/lib/agent/agent-manifest.ts", "src/lib/agent/posture.ts"],
      },
    ],
  },
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_AGENT_READINGS",
    removedBy: [{ milestone: "M7", readers: ["src/lib/agent/agent-manifest.ts"] }],
  },
  {
    module: CLAIM_GRANTS,
    name: "GRANTED_AGENT_EXECUTION_ENGINES",
    removedBy: [
      {
        milestone: "M7",
        readers: ["src/components/login/hero-proof.tsx", "src/lib/agent/agent-manifest.ts", "src/lib/agent/posture.ts"],
      },
    ],
  },
  {
    module: CLAIM_GRANTS,
    name: "legacyEngineGrants",
    removedBy: [
      { milestone: "M7", readers: ["src/lib/sql/dangerous-query.ts"] },
      { milestone: "M18", readers: ["src/lib/provider-host/legacy-adapter/records.ts"] },
    ],
  },
];
