/**
 * The measurement plan of the Snowflake evidence harness: every item tests/live/snowflake-evidence.ts asks the trial
 * account, in the session's order, and the scenarios of the full capture the integration test replays
 * (tests/fixtures/snowflake/trial-2026-10-12-v10.37.100/). Pure: no I/O and no import, so a reader sees the whole
 * list here.
 *
 * Step 1 holds the cold items: each starts only once `SHOW WAREHOUSES` reads the warehouse `SUSPENDED`, and after an
 * item that resumed it the harness waits for the suspension (`AUTO_SUSPEND` 60 s and Snowflake's 30 s suspend poll)
 * before the next, so each item's before and after states say what that item alone resumed. Step 2 holds the sign-in
 * and identity items, M12's timed token reuse among them; step 3 the result and grammar items; step 4 the cheap
 * confirming items; step 5 the items of the full capture, which runs after the provider is implemented.
 *
 * Every statement is sent as the provider sends one: an asynchronous submit with the four context fields and the fixed
 * parameters, polled until it ends. A `<...>` placeholder in a statement is filled by the harness at run time from the
 * environment or the key (`<svc-user>`, `<reader-user>`, `<fp8>`, `<public-key-body>`), so no value of the account
 * is written here. An item whose answer the harness cannot read on its own (`operator`) prints what the operator does
 * and records the operator's note.
 */

/** Who sends: `svc` is `studio_svc` (key pair, `studio_rw`), `reader` `studio_reader` (key pair, `studio_ro`), `pat` `studio_pat`. */
export type EvidencePrincipal = "svc" | "reader" | "pat";

/** What the harness does besides sending the statements in order. */
export type EvidenceSpecial =
  /** Signs token A once and sends the statement under it at each of `SNOWFLAKE_TOKEN_REUSE_OFFSETS_S` after its iat. */
  | "token-reuse"
  /** Submits under token A and polls, reads every partition and cancels under token B, signed later for the same key. */
  | "cross-token"
  /** Submits under token A and cancels twice under token B. */
  | "cancel-twice"
  /** Signs the JWT with each account claim spelling: as typed, `_` as `-`, and `-` as `_`. */
  | "claim-forms"
  /** Fetches every partition, recording each one's encoding, size and row count. */
  | "partitions"
  /** Records each status GET's time and answer and every Retry-After until the statement ends. */
  | "poll-timing"
  /** Sends the status GET of a handle again after the warehouse has suspended. */
  | "status-after-suspend"
  /** Records the certificate the host serves for the name the harness dials. */
  | "certificate"
  /** The operator does what `asks` says by hand and gives the harness a note for the record. */
  | "operator";

export interface EvidenceItem {
  readonly id: string;
  readonly step: 1 | 2 | 3 | 4 | 5;
  /** The question the item answers, and the default it confirms or changes. */
  readonly asks: string;
  readonly principal: EvidencePrincipal;
  /** The role sent in place of the principal's own. */
  readonly role?: string;
  /** False sends no `warehouse` field. */
  readonly warehouse?: false;
  /** Sent in order, each a statement of its own. */
  readonly statements: readonly string[];
  /** Whether `SHOW WAREHOUSES` state is recorded before and after the item. */
  readonly warehouseSensitive: boolean;
  /** Step 1: started only on a suspended warehouse, and the suspension awaited afterwards. */
  readonly cold?: true;
  readonly special?: EvidenceSpecial;
  /** A `timeout` other than the default 60 s. */
  readonly timeout?: number;
}

export const SNOWFLAKE_EVIDENCE_WAREHOUSE = "STUDIO_PROBE_WH";
export const SNOWFLAKE_EVIDENCE_DATABASE = "STUDIO_DEMO";
export const SNOWFLAKE_EVIDENCE_SCHEMA = "PROBE";

/** M12: seconds after token A's iat at which it is sent again; 960 is past `exp`, to record the expiry code. */
export const SNOWFLAKE_TOKEN_REUSE_OFFSETS_S = [10, 300, 540, 840, 960] as const;
/**
 * How long a cold item or a suspended scenario waits for the warehouse to suspend: `AUTO_SUSPEND` 60 s, the 30 s
 * poll, and a margin.
 */
export const SNOWFLAKE_SUSPEND_WAIT_MS = 300_000;
/** How often the harness reads the warehouse's state while it waits. */
export const SNOWFLAKE_SUSPEND_POLL_MS = 15_000;

const T = '"STUDIO_DEMO"."PROBE"';
const EVERY_TYPE = "STUDIO_DEMO.PROBE.EVERY_TYPE";
const BIG = "STUDIO_DEMO.PROBE.BIG";

export const SNOWFLAKE_EVIDENCE_PLAN: readonly EvidenceItem[] = [
  // Step 1: the cold items.
  {
    id: "M25",
    step: 1,
    asks: "Do the SHOW forms the tree and connect() send, and USE SCHEMA, resume a suspended warehouse? Default: SHOW resumes nothing.",
    principal: "reader",
    statements: [
      "SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'",
      "SHOW DATABASES LIMIT 1",
      'SHOW SCHEMAS IN DATABASE "STUDIO_DEMO" LIMIT 10000',
      `SHOW TABLES IN SCHEMA ${T} LIMIT 10000`,
      `SHOW COLUMNS IN SCHEMA ${T}`,
      "USE SCHEMA STUDIO_DEMO.PROBE",
    ],
    warehouseSensitive: true,
    cold: true,
  },
  {
    id: "M26",
    step: 1,
    asks: "Does EXPLAIN USING JSON resume a suspended warehouse? Default: the background estimate stays off.",
    principal: "reader",
    statements: [`EXPLAIN USING JSON SELECT * FROM ${EVERY_TYPE}`],
    warehouseSensitive: true,
    cold: true,
  },
  {
    id: "M29-show-columns",
    step: 1,
    asks: "Does SHOW COLUMNS IN TABLE resume a suspended warehouse? Default: describe reads it.",
    principal: "reader",
    statements: [`SHOW COLUMNS IN TABLE ${T}."EVERY_TYPE"`],
    warehouseSensitive: true,
    cold: true,
  },
  {
    id: "M29-describe",
    step: 1,
    asks: "Does DESCRIBE TABLE resume a suspended warehouse? If not, describe may use it.",
    principal: "reader",
    statements: [`DESCRIBE TABLE ${T}."EVERY_TYPE"`],
    warehouseSensitive: true,
    cold: true,
  },
  {
    id: "M29-get-ddl",
    step: 1,
    asks: "Does GET_DDL resume a suspended warehouse? If it does, the owner decides how the Source pane reads a non-view.",
    principal: "reader",
    statements: [`SELECT GET_DDL('TABLE', '${EVERY_TYPE}')`],
    warehouseSensitive: true,
    cold: true,
  },
  {
    id: "M31",
    step: 1,
    asks: "Does a status GET of a finished statement resume or bill a suspended warehouse?",
    principal: "reader",
    statements: ["SHOW DATABASES LIMIT 1"],
    warehouseSensitive: true,
    cold: true,
    special: "status-after-suspend",
  },
  {
    id: "M100",
    step: 1,
    asks: "Does the role check need a running warehouse, and does it resume one? If neither, the check moves into connect().",
    principal: "reader",
    statements: ["SELECT CURRENT_ROLE() AS r, CURRENT_SECONDARY_ROLES() AS s"],
    warehouseSensitive: true,
    cold: true,
  },
  {
    id: "M101",
    step: 1,
    asks: "Does DESC USER on oneself answer with no warehouse, so a later revision can read the default warehouse?",
    principal: "reader",
    warehouse: false,
    statements: ["DESC USER <reader-user>"],
    warehouseSensitive: true,
    cold: true,
  },
  {
    id: "M110",
    step: 1,
    asks: "Do the reads of MCP inspect_schema leave a suspended warehouse suspended?",
    principal: "reader",
    statements: [
      "SHOW DATABASES LIMIT 10000",
      'SHOW SCHEMAS IN DATABASE "STUDIO_DEMO" LIMIT 10000',
      `SHOW TABLES IN SCHEMA ${T} LIMIT 10000`,
      `SHOW VIEWS IN SCHEMA ${T} LIMIT 10000`,
      `SHOW COLUMNS IN TABLE ${T}."EVERY_TYPE"`,
      `SHOW PRIMARY KEYS IN TABLE ${T}."EVERY_TYPE"`,
    ],
    warehouseSensitive: true,
    cold: true,
  },

  // Step 2: sign-in and identity.
  {
    id: "M7",
    step: 2,
    asks: "Is a key-pair JWT accepted on /api/v2/statements with the token-type header? If not, the work stops.",
    principal: "svc",
    statements: ["SHOW DATABASES LIMIT 1"],
    warehouseSensitive: false,
  },
  {
    id: "M12",
    step: 2,
    asks: "Is one key-pair JWT accepted again at about 10 s, 5 min, 9 min and 14 min after its iat, and what answers after exp?",
    principal: "svc",
    statements: ["SHOW DATABASES LIMIT 1"],
    warehouseSensitive: false,
    special: "token-reuse",
  },
  {
    id: "M8",
    step: 2,
    asks: "Is a PAT accepted as a bearer with the token-type header? If not, PAT sign-in is dropped.",
    principal: "pat",
    statements: ["SHOW DATABASES LIMIT 1"],
    warehouseSensitive: false,
  },
  {
    id: "M97",
    step: 2,
    asks: "Which registration statement works for a user on itself, and what answers a second ADD KEY PAIR of the same key under the same name? Records both self-service forms: ADD KEY PAIR, twice, and SET RSA_PUBLIC_KEY_2.",
    principal: "svc",
    statements: [
      "SHOW USER KEY PAIRS",
      "ALTER USER ADD KEY PAIR libredb_studio_<fp8> PUBLIC_KEY = '<public-key-body>'",
      "ALTER USER ADD KEY PAIR libredb_studio_<fp8> PUBLIC_KEY = '<public-key-body>'",
      "ALTER USER SET RSA_PUBLIC_KEY_2 = '<public-key-body>'",
      "SHOW USER KEY PAIRS",
    ],
    warehouseSensitive: false,
  },
  {
    id: "M10",
    step: 2,
    asks: "Which account claim spelling does Snowflake accept for an account name with an underscore? Default: the first label as typed, upper-cased.",
    principal: "svc",
    statements: ["SHOW DATABASES LIMIT 1"],
    warehouseSensitive: false,
    special: "claim-forms",
  },
  {
    id: "M23",
    step: 2,
    asks: "Does a SHOW answer with no warehouse field? Default: Warehouse is optional.",
    principal: "reader",
    warehouse: false,
    statements: ["SHOW DATABASES LIMIT 1"],
    warehouseSensitive: false,
  },
  {
    id: "M82",
    step: 2,
    asks: "What does SHOW WAREHOUSES LIKE answer for a warehouse the role cannot see, behind the absent-row caution?",
    principal: "reader",
    statements: ["SHOW WAREHOUSES LIKE 'STUDIO_NO_SUCH_WH'"],
    warehouseSensitive: false,
  },
  {
    id: "M25b",
    step: 2,
    asks: "Does a backslash escape _ in SHOW WAREHOUSES LIKE? The operator creates A_B and AXB INITIALLY_SUSPENDED = TRUE first and drops them after.",
    principal: "svc",
    statements: ["SHOW WAREHOUSES LIKE 'A\\\\_B'", "SHOW WAREHOUSES LIKE 'A_B'"],
    warehouseSensitive: false,
  },
  {
    id: "M105",
    step: 2,
    asks: "Is a statement submitted under token A cancelled under token B, and what answers the second cancel?",
    principal: "svc",
    statements: ["SELECT SYSTEM$WAIT(120)"],
    warehouseSensitive: true,
    special: "cancel-twice",
  },

  // Step 3: results and the grammar.
  {
    id: "M52",
    step: 3,
    asks: "How large is partition 0 at client_result_chunk_size 16, in which unit, and are the status and partition GETs of a handle accepted under a later token?",
    principal: "svc",
    statements: [`SELECT * FROM ${BIG}`],
    warehouseSensitive: true,
    special: "cross-token",
  },
  {
    id: "M53",
    step: 3,
    asks: "How is a result cut at rows_per_resultset reported? Default: rows received equal to rows_per_resultset.",
    principal: "svc",
    statements: [`SELECT * FROM ${BIG} LIMIT 200000`],
    warehouseSensitive: true,
    special: "partitions",
  },
  {
    id: "M58",
    step: 3,
    asks: "Is a bare Scripting block taken through the SQL API? Default: no, blocks run inside EXECUTE IMMEDIATE.",
    principal: "svc",
    statements: ["BEGIN RETURN 1; END;", "EXECUTE IMMEDIATE $$BEGIN RETURN 1; END;$$"],
    warehouseSensitive: true,
  },
  {
    id: "M60",
    step: 3,
    asks: "Do block comments nest? Default: flat.",
    principal: "svc",
    statements: ["SELECT /* a /* b */ 1 AS c", "SELECT /* a /* b */ c */ 1 AS c"],
    warehouseSensitive: true,
  },
  {
    id: "M61",
    step: 3,
    asks: "Is a backslash inside a quoted identifier an escape? Default: no.",
    principal: "svc",
    statements: ['SELECT 1 AS "a\\b"'],
    warehouseSensitive: true,
  },
  {
    id: "M62",
    step: 3,
    asks: "Is # code, and is an empty X'' a binary literal? Default: # is code, X'' is standard hex.",
    principal: "svc",
    statements: ["SELECT X'' AS e", "SELECT 3 # 2"],
    warehouseSensitive: true,
  },
  {
    id: "M63",
    step: 3,
    asks: "Is // a comment to the end of the line, and does a backslash before a line break continue a string? Default: both.",
    principal: "svc",
    statements: ["SELECT 1 AS c // a comment", "SELECT 'a\\\nb' AS s"],
    warehouseSensitive: true,
  },
  {
    id: "M64",
    step: 3,
    asks: "Is a$b$c an identifier? Default: the shared reader's fail-safe refusal is kept.",
    principal: "svc",
    statements: ["SELECT 1 AS a$b$c"],
    warehouseSensitive: true,
  },

  // Step 4: the cheap confirming items.
  {
    id: "M15",
    step: 4,
    asks: "Confirms the default the spec records under M15; the operator follows the spec's item and notes the answer.",
    principal: "svc",
    statements: [],
    warehouseSensitive: false,
    special: "operator",
  },
  {
    id: "M18",
    step: 4,
    asks: "Which code refuses a role the user does not hold, 390189 or 3013?",
    principal: "svc",
    role: "STUDIO_NOWH",
    statements: ["SHOW DATABASES LIMIT 1"],
    warehouseSensitive: false,
  },
  {
    id: "M24'",
    step: 4,
    asks: "Which certificate does the host serve for the name Studio dials (SNI selection)?",
    principal: "reader",
    statements: [],
    warehouseSensitive: false,
    special: "certificate",
  },
  {
    id: "M33",
    step: 4,
    asks: "Do two requests share a server session?",
    principal: "svc",
    statements: ["SELECT CURRENT_SESSION() AS s", "SELECT CURRENT_SESSION() AS s"],
    warehouseSensitive: true,
  },
  {
    id: "M34",
    step: 4,
    asks: "Does a session variable carry to the next request?",
    principal: "svc",
    statements: ["SET probe_variable = 1", "SELECT $probe_variable AS v"],
    warehouseSensitive: true,
  },
  {
    id: "M35",
    step: 4,
    asks: "Does USE carry to the next request?",
    principal: "svc",
    statements: ["USE SCHEMA STUDIO_DEMO.INFORMATION_SCHEMA", "SELECT CURRENT_SCHEMA() AS s"],
    warehouseSensitive: true,
  },
  {
    id: "M36",
    step: 4,
    asks: "Does ALTER SESSION carry to the next request?",
    principal: "svc",
    statements: ["ALTER SESSION SET QUERY_TAG = 'probe-carry'", "SELECT CURRENT_QUERY_TAG() AS t"],
    warehouseSensitive: true,
  },
  {
    id: "M37",
    step: 4,
    asks: "Does a BEGIN carry to the next request?",
    principal: "svc",
    statements: ["BEGIN", "SELECT CURRENT_TRANSACTION() AS t", "ROLLBACK"],
    warehouseSensitive: true,
  },
  {
    id: "M38",
    step: 4,
    asks: "What does CURRENT_SECONDARY_ROLES() answer, with and without secondary roles, for the caution's parse?",
    principal: "svc",
    statements: ["SELECT CURRENT_SECONDARY_ROLES() AS s", "SELECT CURRENT_AVAILABLE_ROLES() AS r"],
    warehouseSensitive: true,
  },
  {
    id: "M41",
    step: 4,
    asks: "How soon does a short statement's status GET answer 200, against the first poll interval?",
    principal: "svc",
    statements: ["SELECT SYSTEM$WAIT(2)"],
    warehouseSensitive: true,
    special: "poll-timing",
  },
  {
    id: "M42",
    step: 4,
    asks: "What does a status GET answer while a statement runs, and with what Retry-After?",
    principal: "svc",
    statements: ["SELECT SYSTEM$WAIT(20)"],
    warehouseSensitive: true,
    special: "poll-timing",
  },
  {
    id: "M48",
    step: 4,
    asks: "Which statuses and headers does a submit answer under load, for the retry ladder?",
    principal: "svc",
    statements: ["SELECT 1 AS n"],
    warehouseSensitive: true,
    special: "poll-timing",
  },
  {
    id: "M44",
    step: 4,
    asks: "What error ends a statement at the warehouse's STATEMENT_TIMEOUT_IN_SECONDS of 600 under a longer timeout?",
    principal: "svc",
    statements: ["SELECT SYSTEM$WAIT(610)"],
    warehouseSensitive: true,
    timeout: 700,
  },
  {
    id: "M104",
    step: 4,
    asks: "Is a submit with timeout 604800, the clamp's ceiling, accepted? If not, the ceiling sends 0.",
    principal: "svc",
    statements: ["SELECT 1 AS n"],
    warehouseSensitive: true,
    timeout: 604_800,
  },
  {
    id: "M51",
    step: 4,
    asks: "In which encoding are partitions 1 to n sent, and is the chunk size enforced?",
    principal: "svc",
    statements: [`SELECT * FROM ${BIG} LIMIT 300000`],
    warehouseSensitive: true,
    special: "partitions",
  },
  {
    id: "M57",
    step: 4,
    asks: "Which wire shape do time and timestamp cells take, a pre-1970 fraction included?",
    principal: "svc",
    statements: [
      "SELECT TO_TIME('23:01:59.123') AS t, TO_TIMESTAMP_NTZ('2021-03-19 17:06:59.5') AS ntz, TO_TIMESTAMP_LTZ('2021-03-19 17:06:59') AS ltz, TO_TIMESTAMP_TZ('2021-03-19 18:06:59 +01:00') AS tz, TO_TIMESTAMP_NTZ('1969-12-31 23:59:58.5') AS before_epoch",
    ],
    warehouseSensitive: true,
  },
  {
    id: "M83",
    step: 4,
    asks: "Does QUERY_HISTORY show Studio's query tags?",
    principal: "svc",
    statements: [
      "SELECT query_tag, COUNT(*) AS n FROM TABLE(STUDIO_DEMO.INFORMATION_SCHEMA.QUERY_HISTORY_BY_USER(RESULT_LIMIT => 1000)) WHERE query_tag LIKE 'libredb-studio:%' GROUP BY query_tag",
    ],
    warehouseSensitive: true,
  },

  // Step 5: beside every scenario of the full capture.
  {
    id: "M17",
    step: 5,
    asks: "Confirms the default the spec records under M17; the operator follows the spec's item and notes the answer.",
    principal: "svc",
    statements: [],
    warehouseSensitive: false,
    special: "operator",
  },
  {
    id: "M22",
    step: 5,
    asks: "What does a request from an address the network policy does not allow answer? The operator sends one from another network.",
    principal: "pat",
    statements: [],
    warehouseSensitive: false,
    special: "operator",
  },
  {
    id: "M50",
    step: 5,
    asks: "What code ends a statement the resource monitor suspends mid-run? The operator lowers the quota for one run.",
    principal: "svc",
    statements: [],
    warehouseSensitive: true,
    special: "operator",
  },
  {
    id: "M55",
    step: 5,
    asks: "What does the status GET of a handle whose result has expired answer? The operator reruns the GET of an old handle.",
    principal: "svc",
    statements: [],
    warehouseSensitive: false,
    special: "operator",
  },
  {
    id: "M70",
    step: 5,
    asks: "Does the export of every_type replay through INSERT ... SELECT with PARSE_JSON and the explicit date masks? The live check's replay answers it.",
    principal: "svc",
    statements: [],
    warehouseSensitive: true,
    special: "operator",
  },
  {
    id: "M78",
    step: 5,
    asks: "Does the provider doc's read-only setup recipe run as written, MATERIALIZED VIEWS as a grant type included? The operator runs it under its own placeholder names.",
    principal: "svc",
    statements: [],
    warehouseSensitive: false,
    special: "operator",
  },
  {
    id: "M80",
    step: 5,
    asks: "What does SHOW IMPORTED KEYS answer, for a later foreign-key reading?",
    principal: "reader",
    statements: [`SHOW IMPORTED KEYS IN SCHEMA ${T}`],
    warehouseSensitive: false,
  },
  {
    id: "M81",
    step: 5,
    asks: "Where does the 10,000-row ceiling of SHOW apply, with and without LIMIT? The operator creates the objects past it in a scratch schema.",
    principal: "svc",
    statements: [],
    warehouseSensitive: false,
    special: "operator",
  },
  {
    id: "M84",
    step: 5,
    asks: "What code does a data movement policy refusal answer? The operator sets one for one run.",
    principal: "svc",
    statements: [],
    warehouseSensitive: false,
    special: "operator",
  },
  {
    id: "M98",
    step: 5,
    asks: "What does a key never registered on the user answer, and so how specific can the key-pair refusal be? The operator signs with a fresh key and notes the answer.",
    principal: "svc",
    statements: [],
    warehouseSensitive: false,
    special: "operator",
  },
];

/** One statement of a capture scenario, sent as the provider sends it. */
export interface ScenarioStatement {
  readonly sql: string;
  readonly tag: string;
  /** 30 for a statement Studio sends on its own, 60 for an editor statement. */
  readonly timeout: number;
  /** Read partitions 1 to n after the result. */
  readonly partitions?: true;
  /** Cancel by handle once the statement has polled this long. */
  readonly cancelAfterMs?: number;
}

/** One scenario of the full capture: the file it replaces, who sends, and its statements in order. */
export interface EvidenceScenario {
  readonly name: string;
  readonly principal: EvidencePrincipal;
  readonly role?: string;
  readonly warehouse?: false;
  readonly statements: readonly ScenarioStatement[];
  /** Signs with a key generated for the run, which no user has registered. */
  readonly freshKey?: true;
  /** Captured by hand: the harness prints this and skips the scenario. */
  readonly operator?: string;
  /**
   * Starts only once `SHOW WAREHOUSES` reports the warehouse `SUSPENDED`, polled every `SNOWFLAKE_SUSPEND_POLL_MS`
   * for at most `SNOWFLAKE_SUSPEND_WAIT_MS`; the harness fails the scenario by name if it never does.
   */
  readonly suspended?: true;
}

const tag = (kind: string): string => `libredb-studio:${kind}`;
const CONNECT: ScenarioStatement = { sql: "SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'", tag: tag("connect"), timeout: 30 };
const CONNECT_NO_WAREHOUSE: ScenarioStatement = { sql: "SHOW DATABASES LIMIT 1", tag: tag("connect"), timeout: 30 };
const ROLE_CHECK: ScenarioStatement = {
  sql: "SELECT CURRENT_ROLE() AS r, CURRENT_SECONDARY_ROLES() AS s",
  tag: tag("role-check"),
  timeout: 30,
};
const editor = (sql: string, extra: Partial<ScenarioStatement> = {}): ScenarioStatement => ({
  sql,
  tag: tag("editor"),
  timeout: 60,
  ...extra,
});
const tree = (sql: string): ScenarioStatement => ({ sql, tag: tag("tree"), timeout: 30 });
const describe = (sql: string): ScenarioStatement => ({ sql, tag: tag("describe"), timeout: 30 });
const monitoring = (sql: string): ScenarioStatement => ({ sql, tag: tag("monitoring"), timeout: 30 });

/** What connect() sends: the connect `SHOW`, then the role check, which M100 measured to need no warehouse. */
const CONNECTED: readonly ScenarioStatement[] = [CONNECT, ROLE_CHECK];

/**
 * The scenarios of the full capture, each the requests the provider sends for it in order: every one connects as
 * connect() does, the connect `SHOW` and then the role check, before anything else. `refusal-390186` is the code M18
 * measured, and `partitions` a two-partition result (three would need over 49,152 rows, too large to commit); the two
 * panels without MONITOR run under studio_ro. The harness stops a scenario at its first refused answer, as the
 * provider does, so a statement listed after it is the one the provider would send next and is never sent.
 * Two cases the integration test covers have no scenario, because the account answers otherwise: a role the
 * credentials may not use is refused at connect with 390186 (`role-restricted-pat-show` records it), so no role
 * check answers another role; and a role holding no warehouse still runs compute through the default warehouse while
 * its secondary roles are active, as they are by default, and meets 391920, not 000606, once they are not. Their
 * tests build the answer.
 */
export const SNOWFLAKE_EVIDENCE_SCENARIOS: readonly EvidenceScenario[] = [
  { name: "connect-keypair", principal: "svc", statements: CONNECTED },
  { name: "connect-pat", principal: "pat", statements: CONNECTED },
  {
    // A browse-only connection: no warehouse field, and the role check answers without one (M100).
    name: "connect-no-warehouse",
    principal: "reader",
    warehouse: false,
    statements: [CONNECT_NO_WAREHOUSE, ROLE_CHECK],
  },
  { name: "refusal-390144", principal: "reader", freshKey: true, statements: CONNECTED },
  { name: "refusal-390186", principal: "svc", role: "STUDIO_NOWH", statements: CONNECTED },
  {
    name: "refusal-403",
    principal: "reader",
    statements: CONNECTED,
    operator: "Send connect from an address the network policy does not allow, such as another network.",
  },
  {
    name: "refusal-002003",
    principal: "reader",
    statements: [...CONNECTED, editor("SELECT * FROM STUDIO_DEMO.PROBE.MISSING")],
  },
  {
    name: "refusal-003001",
    principal: "reader",
    statements: [...CONNECTED, editor("INSERT INTO STUDIO_DEMO.PROBE.WIDE (C01) VALUES (1)")],
  },
  {
    name: "refusal-422",
    principal: "reader",
    statements: [...CONNECTED, editor("SELECT * FORM STUDIO_DEMO.PROBE.WIDE")],
  },
  {
    name: "tree-show",
    principal: "reader",
    statements: [
      ...CONNECTED,
      tree("SHOW DATABASES LIMIT 10000"),
      tree('SHOW SCHEMAS IN DATABASE "STUDIO_DEMO" LIMIT 10000'),
      tree(`SHOW TABLES IN SCHEMA ${T} LIMIT 10000`),
      tree(`SHOW VIEWS IN SCHEMA ${T} LIMIT 10000`),
      tree(`SHOW STREAMS IN SCHEMA ${T} LIMIT 10000`),
      tree(`SHOW TASKS IN SCHEMA ${T} LIMIT 10000`),
      tree(`SHOW SEQUENCES IN SCHEMA ${T}`),
      tree(`SHOW STAGES IN SCHEMA ${T}`),
      tree(`SHOW FILE FORMATS IN SCHEMA ${T}`),
      tree(`SHOW PIPES IN SCHEMA ${T}`),
      tree(`SHOW USER FUNCTIONS IN SCHEMA ${T}`),
      tree(`SHOW PROCEDURES IN SCHEMA ${T}`),
    ],
  },
  {
    name: "describe-columns",
    principal: "reader",
    statements: [
      ...CONNECTED,
      describe(`SHOW COLUMNS IN TABLE ${T}."EVERY_TYPE"`),
      describe(`SHOW PRIMARY KEYS IN TABLE ${T}."EVERY_TYPE"`),
      describe(`SHOW TABLES LIKE 'EVERY_TYPE' IN SCHEMA ${T}`),
    ],
  },
  {
    // 8,192 rows inline and 8 in partition 1, fetched gzipped, as measured on the account.
    name: "partitions",
    principal: "svc",
    statements: [...CONNECTED, editor(`SELECT ID, PAD FROM ${BIG} ORDER BY ID LIMIT 8200`, { partitions: true })],
  },
  {
    name: "every-type",
    principal: "svc",
    statements: [...CONNECTED, editor(`SELECT * FROM ${EVERY_TYPE} ORDER BY 1 NULLS LAST`)],
  },
  {
    name: "cancel",
    principal: "svc",
    statements: [...CONNECTED, editor("SELECT SYSTEM$WAIT(120)", { cancelAfterMs: 3_000 })],
  },
  { name: "role-check-match", principal: "svc", statements: [...CONNECTED, editor("SELECT 1 AS N")] },
  {
    name: "role-check-secondary",
    principal: "svc",
    statements: [...CONNECTED, editor("SELECT 1 AS N")],
    operator:
      "Run with DEFAULT_SECONDARY_ROLES = ('ALL') on studio_svc, and role-check-match with DEFAULT_SECONDARY_ROLES = (), then set it back.",
  },
  {
    name: "refusal-404",
    principal: "reader",
    statements: [...CONNECTED, editor("SELECT C01 FROM STUDIO_DEMO.PROBE.WIDE")],
    operator: "M55: send the status GET of this statement's handle again once Snowflake no longer holds its result.",
  },
  ...(["svc", "reader"] as const).flatMap((principal): EvidenceScenario[] => {
    // studio_svc's studio_rw holds MONITOR on the warehouse, studio_reader's studio_ro does not.
    const suffix = principal === "svc" ? "" : "-without-monitor";
    const state = monitoring("SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'");
    return [
      {
        name: `monitoring-started${suffix}`,
        principal,
        statements: [
          ...CONNECTED,
          state,
          monitoring(
            `SELECT COUNT(*) AS n FROM TABLE("STUDIO_DEMO".INFORMATION_SCHEMA.QUERY_HISTORY_BY_WAREHOUSE(WAREHOUSE_NAME => '"STUDIO_PROBE_WH"', END_TIME_RANGE_START => DATEADD('hour', -1, CURRENT_TIMESTAMP()), RESULT_LIMIT => 10000))`,
          ),
        ],
      },
      { name: `monitoring-suspended${suffix}`, principal, suspended: true, statements: [...CONNECTED, state] },
    ];
  }),
  {
    // Refused at connect with 390186: the token may use only STUDIO_RO, so the SHOW after it is never sent.
    name: "role-restricted-pat-show",
    principal: "pat",
    role: "STUDIO_NOWH",
    statements: [...CONNECTED, editor(`SHOW TABLES IN SCHEMA ${T}`)],
  },
];

/** Why the provider stops a scenario after this answer: a refusal, a role check answering another role, or neither. */
export type ScenarioStop = "refused" | "role-mismatch" | null;

/**
 * Whether a scenario goes on after a statement's last answer, as the provider decides: any status but 200 (a 4xx or
 * 5xx, or a statement still running when the harness stopped waiting) ends it, and so does a role check whose first
 * cell is not the configured role. A partition read stops the same way at its first answer that is not 200.
 */
export function scenarioStop(
  step: ScenarioStatement,
  answer: { readonly status: number; readonly firstCell: unknown },
  role: string,
): ScenarioStop {
  if (answer.status !== 200) return "refused";
  if (step.tag === ROLE_CHECK.tag && answer.firstCell !== role) return "role-mismatch";
  return null;
}
