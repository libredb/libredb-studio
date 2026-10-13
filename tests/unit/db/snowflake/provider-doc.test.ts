/**
 * `docs/providers/snowflake.md` quotes sentences, numbers and declarations the code owns, the shape of
 * `tests/unit/db/databend/provider-doc.test.ts`: one test file per type-id, because the tri-sync invariant is per
 * type-id.
 *
 * A value copied into prose is true only until the code moves, so every sentence the doc quotes is read back here from
 * the module that owns it, a template filled with the bracketed placeholders the doc writes, and every list the doc
 * draws from a declaration (what is off, the tags, the confirmation forms) is compared with that declaration whole.
 * The sentences only the doc carries (the disconnect, Test connection and secondary-roles sentences) are pinned here
 * word for word.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SOURCE_BILLED_COMPUTE_HOLD } from "@/components/object-source/ObjectSourceView";
import { DB_UI_CONFIG, SNOWFLAKE_FIELD_HINTS } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE } from "@/lib/db/compatibility";
import { SNOWFLAKE_FIELD_SENTENCES, SNOWFLAKE_MAX_HOST_LABELS } from "@/lib/db/providers/sql/snowflake/account-host";
import {
  SNOWFLAKE_JWT_LIFETIME_S,
  SNOWFLAKE_JWT_RENEW_AFTER_S,
  SNOWFLAKE_KEY_MAX_BYTES,
  SNOWFLAKE_KEY_SENTENCES,
  SNOWFLAKE_MAX_PBKDF2_ITERATIONS,
  SNOWFLAKE_MAX_SCRYPT_N,
  SNOWFLAKE_MAX_SCRYPT_P,
  SNOWFLAKE_MAX_SCRYPT_R,
  SNOWFLAKE_RSA_MAX_BITS,
  SNOWFLAKE_RSA_MIN_BITS,
} from "@/lib/db/providers/sql/snowflake/auth";
import { decodeCell, SNOWFLAKE_DECODE_SENTENCES } from "@/lib/db/providers/sql/snowflake/decode";
import {
  keyPairName,
  SNOWFLAKE_ERROR_SENTENCES,
  SNOWFLAKE_SERVER_TEXT_MAX_CHARS,
} from "@/lib/db/providers/sql/snowflake/errors";
import { SNOWFLAKE_OBJECT_KINDS, SnowflakeProvider } from "@/lib/db/providers/sql/snowflake/index";
import {
  SNOWFLAKE_INTROSPECT_SENTENCES,
  SNOWFLAKE_KIND_IDS,
  SNOWFLAKE_SHOW_PAGE_ROWS,
  SNOWFLAKE_TREE_PAGE_LIMIT,
} from "@/lib/db/providers/sql/snowflake/introspect";
import {
  SNOWFLAKE_MONITORING_LABELS,
  SNOWFLAKE_MONITORING_SENTENCES,
  SNOWFLAKE_MONITORING_TTL_MS,
} from "@/lib/db/providers/sql/snowflake/monitoring";
import {
  SNOWFLAKE_FIRST_ANSWER_MAX_BYTES,
  SNOWFLAKE_RESULT_BYTE_BUDGET,
  SNOWFLAKE_ROWS_SENTENCES,
} from "@/lib/db/providers/sql/snowflake/rows";
import {
  clampedTimeoutS,
  deadlineMsFor,
  SNOWFLAKE_CANCEL_TIMEOUT_MS,
  SNOWFLAKE_CHUNK_SIZE_MB,
  SNOWFLAKE_DEADLINE_GRACE_MS,
  SNOWFLAKE_LIMITER_OPTIONS,
  SNOWFLAKE_MAX_TIMEOUT_S,
  SNOWFLAKE_POLL_FIRST_MS,
  SNOWFLAKE_POLL_MAX_MS,
  SNOWFLAKE_QUERY_TAGS,
  SNOWFLAKE_ROLE_CHECK_SQL,
  SNOWFLAKE_ROWS_PER_RESULTSET,
  SNOWFLAKE_STATEMENT_SENTENCES,
  SNOWFLAKE_SURFACE_TIMEOUT_S,
  surfaceTimeoutS,
} from "@/lib/db/providers/sql/snowflake/statements";
import {
  SNOWFLAKE_RETRY_ATTEMPTS,
  SNOWFLAKE_RETRY_BASE_MS,
  SNOWFLAKE_RETRY_MAX_MS,
  SNOWFLAKE_USER_AGENT,
  snowflakeBackoffMs,
} from "@/lib/db/providers/sql/snowflake/transport";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const DOC = readFileSync(path.join(ROOT, "docs/providers/snowflake.md"), "utf8");
/** Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces. */
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");
const FLAT_DOC = flat(DOC);
const MIB = 1024 * 1024;
/** Thousands grouped by commas, the doc's spelling. */
const n = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const CONNECTION: DatabaseConnection = {
  id: "snowflake-doc",
  name: "Snowflake",
  type: "snowflake",
  host: "myorg-myaccount",
  user: "STUDIO_SVC",
  role: "STUDIO_RO",
  createdAt: new Date(0),
};
const provider = new SnowflakeProvider(CONNECTION);
const capabilities = provider.getCapabilities();
/** The contract's view, where the optional surfaces a provider leaves out read as undefined. */
const contract: DatabaseProvider = provider;

/** The section under the heading line `heading`, up to the next heading of its level or above. */
function sectionOf(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = heading.indexOf(" ");
  const inFence = (at: number) => lines.slice(0, at).filter((line) => line.startsWith("```")).length % 2 === 1;
  const end = lines.findIndex(
    (line, at) => at > start && /^#{1,6} /.test(line) && line.indexOf(" ") <= level && !inFence(at),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

/** The first cell of every body row of the first table in `text`. */
function firstCells(text: string): string[] {
  const rows = text.split("\n").filter((line) => line.startsWith("| "));
  return rows.slice(2).map((line) => line.split(" | ")[0].slice(2).trim());
}

const HEADINGS = [
  "## 1. What it is",
  "## 2. Connecting",
  "## 3. The recommended Snowflake setup",
  "## 4. Sessions, transactions and blocks",
  "## 5. What runs on a warehouse",
  "## 6. Results",
  "## 7. The tree",
  "## 8. Features",
  "## 9. The confirmation gate",
  "## 10. Security",
  "## 11. Errors",
  "## 12. Embedded package",
  "## 13. Evidence",
];

const DISCONNECT_SENTENCE =
  "Deleting a connection, changing its query timeout or restarting the Studio server cancels every statement still running on it, for every user of that connection; leaving it idle does not, because Studio keeps a connection open while one of its statements runs. Any signed-in user who sends that connection's id to Studio's disconnect route has the same effect.";
const TEST_CONNECTION_SENTENCE =
  "Test connection checks the key, the account, the role Snowflake runs as and the warehouse's state, without starting the warehouse. Your first query starts the warehouse if it is suspended, and Snowflake bills at least one minute for that.";
const SECONDARY_ROLES_SENTENCE =
  "When secondary roles are active for the user, Test connection shows this caution, because the tree, every SHOW and every statement can reach what those roles can, not only Role:";

/** The key-pair refusal with the doc's placeholders, so the registration statements are the builder's own. */
const KEY_PAIR_REFUSED = SNOWFLAKE_ERROR_SENTENCES.keyPairRefused({
  uuid: "<uuid>",
  account: "<ACCOUNT>",
  user: "<USER>",
  fingerprint: "SHA256:<fp>",
  fp8: "<fp8>",
  body: "<body>",
});

/** Every sentence of each exported record, each template filled with the doc's placeholders. */
const QUOTED: Readonly<Record<string, { readonly keys: readonly string[]; readonly quotes: readonly string[] }>> = {
  SNOWFLAKE_STATEMENT_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_STATEMENT_SENTENCES),
    quotes: [
      SNOWFLAKE_STATEMENT_SENTENCES.useRefused,
      SNOWFLAKE_STATEMENT_SENTENCES.settingNotCarried,
      SNOWFLAKE_STATEMENT_SENTENCES.noTransactions,
      SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles("<roles>", "<role>"),
      SNOWFLAKE_STATEMENT_SENTENCES.badHandle,
      SNOWFLAKE_STATEMENT_SENTENCES.foreignLink,
    ],
  },
  SNOWFLAKE_ROWS_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_ROWS_SENTENCES),
    quotes: [
      SNOWFLAKE_ROWS_SENTENCES.firstTooLarge,
      SNOWFLAKE_ROWS_SENTENCES.unreadable,
      SNOWFLAKE_ROWS_SENTENCES.encoding("<encoding>"),
      SNOWFLAKE_ROWS_SENTENCES.nonString("<column>"),
      SNOWFLAKE_ROWS_SENTENCES.byteCut(1234).replace("1,234", "<numRows>"),
      SNOWFLAKE_ROWS_SENTENCES.rowCut,
      SNOWFLAKE_ROWS_SENTENCES.snowflakeCut,
    ],
  },
  SNOWFLAKE_ERROR_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_ERROR_SENTENCES),
    quotes: [
      KEY_PAIR_REFUSED,
      SNOWFLAKE_ERROR_SENTENCES.keyPairMidRun("<code>"),
      SNOWFLAKE_ERROR_SENTENCES.keyMissing,
      SNOWFLAKE_ERROR_SENTENCES.patRefused,
      SNOWFLAKE_ERROR_SENTENCES.networkPolicyRefused,
      SNOWFLAKE_ERROR_SENTENCES.networkPolicyRequired,
      SNOWFLAKE_ERROR_SENTENCES.roleRefused("<role>", "<user>", "<role>", "<user>"),
      SNOWFLAKE_ERROR_SENTENCES.roleMismatch("<r>", "<role>"),
      SNOWFLAKE_ERROR_SENTENCES.noWarehouse,
      SNOWFLAKE_ERROR_SENTENCES.objectMissing("<role>", "'<role>'", ""),
      SNOWFLAKE_ERROR_SENTENCES.privileges("<role>", ""),
      SNOWFLAKE_ERROR_SENTENCES.forbidden,
      SNOWFLAKE_ERROR_SENTENCES.statementFailed("<message>", "<code>", "<sqlstate>"),
      SNOWFLAKE_ERROR_SENTENCES.deadline("<n>" as unknown as number),
      SNOWFLAKE_ERROR_SENTENCES.surfaceDeadline(30),
      SNOWFLAKE_ERROR_SENTENCES.statementTimeout("<n>" as unknown as number),
      SNOWFLAKE_ERROR_SENTENCES.surfaceStatementTimeout(30),
      SNOWFLAKE_ERROR_SENTENCES.unsupportedCommand(""),
      SNOWFLAKE_ERROR_SENTENCES.rateLimited,
      SNOWFLAKE_ERROR_SENTENCES.unavailable("<n>" as unknown as number, "<attempts>" as unknown as number),
      SNOWFLAKE_ERROR_SENTENCES.tlsRefused,
      SNOWFLAKE_ERROR_SENTENCES.resultGone,
      SNOWFLAKE_ERROR_SENTENCES.invalidPayload,
      SNOWFLAKE_ERROR_SENTENCES.unreachable("<host>"),
      SNOWFLAKE_ERROR_SENTENCES.certMismatch("<host>"),
      SNOWFLAKE_ERROR_SENTENCES.slotsBusy("<n>" as unknown as number),
      SNOWFLAKE_ERROR_SENTENCES.scriptingHint,
      SNOWFLAKE_ERROR_SENTENCES.cancelled,
    ],
  },
  SNOWFLAKE_KEY_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_KEY_SENTENCES),
    quotes: [
      SNOWFLAKE_KEY_SENTENCES.keyEmpty,
      SNOWFLAKE_KEY_SENTENCES.tooLarge,
      SNOWFLAKE_KEY_SENTENCES.publicKey,
      SNOWFLAKE_KEY_SENTENCES.notPem,
      SNOWFLAKE_KEY_SENTENCES.kdfCost,
      SNOWFLAKE_KEY_SENTENCES.needsPassphrase,
      SNOWFLAKE_KEY_SENTENCES.wrongPassphrase,
      SNOWFLAKE_KEY_SENTENCES.unreadable,
      SNOWFLAKE_KEY_SENTENCES.notRsa("ec"),
      SNOWFLAKE_KEY_SENTENCES.short,
      SNOWFLAKE_KEY_SENTENCES.long("<bits>" as unknown as number),
    ],
  },
  SNOWFLAKE_FIELD_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_FIELD_SENTENCES),
    quotes: Object.values(SNOWFLAKE_FIELD_SENTENCES),
  },
};

describe("docs/providers/snowflake.md", () => {
  test("has the thirteen sections in order", () => {
    const headings = DOC.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(HEADINGS);
  });

  test("states the disconnect, Test connection and secondary-roles sentences word for word", () => {
    expect(FLAT_DOC).toContain(DISCONNECT_SENTENCE);
    expect(flat(sectionOf(DOC, "## 2. Connecting"))).toContain(TEST_CONNECTION_SENTENCE);
    expect(flat(sectionOf(DOC, "## 2. Connecting"))).toContain(SECONDARY_ROLES_SENTENCE);
  });

  test("the role check runs in connect(), needs no warehouse, and no sentence still times it at the first query", () => {
    const row = sectionOf(DOC, "### 5.1 Every billed surface")
      .split("\n")
      .find((line) => line.startsWith("| Role check |"));
    expect(row?.split(" | ")[2]).toBe("no");
    for (const stale of [
      "the role check run on the warehouse",
      "before the first query",
      "Studio warns at the first query",
      "for the check alone",
      "triggers nor waits for the role check",
      "another statement's role check",
    ]) {
      expect(FLAT_DOC).not.toContain(stale);
    }
    expect(flat(sectionOf(DOC, "## 5. What runs on a warehouse"))).toContain(
      "Every `SHOW`, every `DESCRIBE`, every `EXPLAIN`, `GET_DDL`, the role check, a status poll and a cancel need no running warehouse",
    );
  });

  for (const [record, { keys, quotes }] of Object.entries(QUOTED)) {
    test(`quotes every sentence of ${record}`, () => {
      expect(quotes.length).toBe(keys.length);
      for (const quote of quotes) expect(FLAT_DOC).toContain(quote);
    });
  }

  test("quotes the field hints, the cautions, the tree's sentences and the monitoring sentences", () => {
    for (const hint of Object.values(SNOWFLAKE_FIELD_HINTS)) expect(FLAT_DOC).toContain(hint);
    for (const sentence of [
      SNOWFLAKE_INTROSPECT_SENTENCES.noWarehouseRow("<wh>", "<role>"),
      SNOWFLAKE_INTROSPECT_SENTENCES.notResuming("<wh>"),
      SNOWFLAKE_INTROSPECT_SENTENCES.emptyWarehouse,
      SNOWFLAKE_INTROSPECT_SENTENCES.treeCap,
      SNOWFLAKE_INTROSPECT_SENTENCES.countFloor,
      SNOWFLAKE_INTROSPECT_SENTENCES.pairCap,
      SNOWFLAKE_INTROSPECT_SENTENCES.secureView,
      SNOWFLAKE_MONITORING_SENTENCES.suspended("<wh>"),
      SNOWFLAKE_MONITORING_SENTENCES.noWarehouse,
      SNOWFLAKE_MONITORING_SENTENCES.needsMonitor("<wh>"),
      SNOWFLAKE_MONITORING_SENTENCES.storage,
      SNOWFLAKE_MONITORING_SENTENCES.noIndexes,
      ...Object.values(SNOWFLAKE_MONITORING_LABELS),
    ]) {
      expect(FLAT_DOC).toContain(sentence);
    }
  });

  test("names the fields by the dialog's labels, in the dialog's order", () => {
    const ui = DB_UI_CONFIG.snowflake;
    const rows = firstCells(sectionOf(DOC, "### 2.1 Fields"));
    expect(rows).toEqual(ui.connectionFields.map((field) => ui.fieldLabels?.[field] ?? field));
  });

  test("lists exactly the features the provider declares off", () => {
    const off: string[] = [];
    if (capabilities.supportsResultPagination === false) off.push("Load More");
    if (capabilities.supportsInlineRowEdit === false) off.push("Inline row edit");
    if (capabilities.supportsColumnProfiling === false) off.push("Column profiler");
    if (contract.buildObjectEdit === undefined) off.push("Object edit");
    if (capabilities.supportsTestDataGeneration === false) off.push("Test data generation");
    if (capabilities.supportsTransactions === false) off.push("Transactions");
    if (capabilities.supportsMaintenance === false && capabilities.maintenanceOperations?.length === 0)
      off.push("Maintenance");
    if (contract.queryReadOnly === undefined) off.push("Agent execute mode, MCP `run_read_query`");
    expect(firstCells(sectionOf(DOC, "### 8.5 Off in v1"))).toEqual(off);
  });

  test("states the capabilities the features section describes", () => {
    const features = flat(sectionOf(DOC, "## 8. Features"));
    expect(capabilities.explainFormat).toBe("snowflake-json");
    expect(features).toContain("`EXPLAIN USING JSON <statement>`");
    expect(capabilities.resumesBilledCompute).toBe(true);
    expect(features).toContain("`resumesBilledCompute`");
    expect(MCP_EXPOSABLE.snowflake).toBe(true);
    expect(features).toContain("`mcp: true`");
    expect(capabilities.declaresForeignKeys).toBe(false);
    expect(flat(sectionOf(DOC, "## 7. The tree"))).toContain("Studio draws no foreign keys");
  });

  test("the cost table names every billed surface", () => {
    const surfaces = firstCells(sectionOf(DOC, "### 5.1 Every billed surface"));
    expect(surfaces).toEqual([
      "Editor run",
      "Multi-statement script",
      "Explain button",
      "Background explain estimate",
      "Monitoring dashboard",
      "Tree, object counts, describe, inventory, autocomplete",
      "View source of a non-view",
      "Plan mode walk",
      "Agent operations workflow",
      "MCP `inspect_schema`",
      "Test connection, Save, a connect on a cache miss",
      "Role check",
      "Health",
      "Connection pulse, fleet health",
      "Tree refresh after DDL",
      "Export",
      "Load More, inline edit, profiler, test data, maintenance",
      "AI panels, history, code generation",
      "Schema diff",
      "Object search",
    ]);
  });

  test("names every query_tag and no other", () => {
    const named = new Set(DOC.match(/libredb-studio:[a-z-]+/g) ?? []);
    expect([...named].sort()).toEqual(Object.values(SNOWFLAKE_QUERY_TAGS).sort());
    expect(FLAT_DOC).toContain(SNOWFLAKE_ROLE_CHECK_SQL);
  });

  test("names every confirmation form the grammar declares", () => {
    const grammar = resolveSqlGrammar("snowflake");
    const gate = flat(sectionOf(DOC, "## 9. The confirmation gate"));
    const forms = grammar.confirmForms ?? [];
    const codeForms = grammar.confirmCodeForms ?? [];
    expect(forms.length).toBeGreaterThan(0);
    expect(codeForms.length).toBeGreaterThan(0);
    for (const form of forms) expect(gate).toContain(`\`${form.join(" ")}\``);
    for (const form of codeForms) {
      expect(gate).toContain(
        Array.isArray(form) ? `\`${form.join(" ")}\`` : `\`${(form as { prefix: string }).prefix}\``,
      );
    }
    // The sentence on what still runs unconfirmed names no form the grammar asks for.
    const unconfirmed = /Still unconfirmed:.*?\.(?=\s|$)/.exec(gate)?.[0] ?? "";
    expect(unconfirmed).not.toBe("");
    for (const form of forms) expect(unconfirmed).not.toContain(`\`${form.join(" ")}\``);
    expect(gate).toContain("a browser confirmation, not a boundary");
    expect(gate).toContain("`IDENTIFIER()`");
  });

  test("says how the editor reads `$` and a backslash inside a quoted name, as the grammar does", () => {
    const grammar = resolveSqlGrammar("snowflake");
    const sessions = flat(sectionOf(DOC, "## 4. Sessions, transactions and blocks"));
    expect(grammar.dollarTags).toBe(false);
    expect(grammar.doubleQuoteBackslashEscapes).toBe(false);
    expect(sessions).toContain("`$` is a name character and only `$$` opens a string");
    expect(sessions).toContain('A backslash inside `"..."` is part of the name');
  });

  test("registers the key under the name and statements Studio's refusal prints, the administrator's first", () => {
    const admin = /registers it with (ALTER USER <name> ADD KEY PAIR \S+ PUBLIC_KEY = )'<body>'/.exec(KEY_PAIR_REFUSED);
    const self = /; (ALTER USER ADD KEY PAIR \S+ PUBLIC_KEY = )'<body>' is refused with 003001/.exec(KEY_PAIR_REFUSED);
    expect(admin).not.toBeNull();
    expect(self).not.toBeNull();
    expect(KEY_PAIR_REFUSED.indexOf(admin?.[1] ?? "")).toBeLessThan(KEY_PAIR_REFUSED.indexOf(self?.[1] ?? ""));
    expect(KEY_PAIR_REFUSED).toContain("MODIFY PROGRAMMATIC AUTHENTICATION METHODS on your own user");
    expect(KEY_PAIR_REFUSED).toContain("ALTER USER <name> SET RSA_PUBLIC_KEY = '<body>'");
    const connecting = flat(sectionOf(DOC, "## 2. Connecting"));
    expect(connecting).toContain(`${admin?.[1]}'<public key body>'`);
    expect(connecting).toContain(`${self?.[1]}'<public key body>'`);
    expect(connecting).toContain("ALTER USER <name> SET RSA_PUBLIC_KEY = '<public key body>'");
    expect(connecting).toContain("MODIFY PROGRAMMATIC AUTHENTICATION METHODS");
    // No capture shows SET RSA_PUBLIC_KEY replacing a key, or the self-service form working once granted (M97).
    for (const text of [KEY_PAIR_REFUSED, connecting]) {
      expect(text).not.toContain("replaces the key");
      expect(text).not.toContain("only once your role holds");
    }
    expect(connecting).toContain("openssl genrsa 2048 | openssl pkcs8 -topk8 -v2 aes-256-cbc -out rsa_key.p8");
    expect(connecting).toContain("openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub");
    const generate = connecting.indexOf("openssl genrsa 2048");
    const register = connecting.indexOf(admin?.[1] ?? "");
    const check = connecting.indexOf("SHOW USER KEY PAIRS FOR USER <name>", register);
    const selfService = connecting.indexOf(self?.[1] ?? "");
    expect(generate).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(generate);
    expect(check).toBeGreaterThan(register);
    expect(selfService).toBeGreaterThan(check);
    expect(flat(sectionOf(DOC, "## 3. The recommended Snowflake setup"))).toContain(
      `ADD KEY PAIR ${keyPairName("<fp8>")} PUBLIC_KEY = '<public key body>'`,
    );
  });

  test("states every security and cost topic the provider owes its reader", () => {
    for (const phrase of [
      "browser storage",
      "`GET /api/storage`",
      "Studio reads no key file",
      "query history",
      "AI safety check",
      "appears once in the grid",
      "on a laptop changes with the network",
      "OpenSSL-based validators",
      "must call `cancelQuery` itself",
      "A resource monitor caps warehouse credits only",
      "Gen2",
      "`STATEMENT_TIMEOUT_IN_SECONDS` caps",
      "`DB_HTTP_BLOCK_PRIVATE_HOSTS=true`",
      "no HTTP proxy",
      "The role is the boundary, not Studio",
      "read in the browser and never kept",
      "`DEFAULT_SECONDARY_ROLES = ()`",
    ]) {
      expect(FLAT_DOC).toContain(phrase);
    }
  });

  test("states what the operator measured by hand on the trial", () => {
    const pinned: Record<string, readonly string[]> = {
      "### 2.4 Programmatic access token": [
        "On the trial on 2026-10-13 that policy let a token sign in for a user with no network policy, and each policy change took up to about 45 s to show.",
      ],
      "## 3. The recommended Snowflake setup": [
        "On the trial on 2026-10-13 a key restricted to one role signed in under that role and under no role, and was refused under another with 390186.",
        "On 2026-10-12 a token restricted to one role signed in under that role and was refused under another with 390186.",
        "On the trial on 2026-10-13 a monitor at its quota suspended the warehouse mid-statement, and the statement ended with HTTP 422, code 000629 and SQLSTATE 57014, `Warehouse ... was suspended immediate by resource monitor ..., statement aborted.`, which Studio shows with Snowflake's text and code; a statement that needs no warehouse still answered.",
        "The recipe ran as written on the trial on 2026-10-13, and its user was refused an INSERT with 003001.",
      ],
      "## 11. Errors": [
        "A data movement policy refusal answers HTTP 422 with code 001003, the code a syntax error answers, and `Data movement policy triggered. Contact your administrator for details.`, so Studio shows Snowflake's text.",
      ],
    };
    for (const [section, sentences] of Object.entries(pinned)) {
      for (const sentence of sentences) expect(flat(sectionOf(DOC, section))).toContain(sentence);
    }
  });

  test("quotes the bounds the code holds", () => {
    expect(FLAT_DOC).toContain(`${SNOWFLAKE_RESULT_BYTE_BUDGET / MIB} MiB`);
    expect(FLAT_DOC).toContain(`${SNOWFLAKE_FIRST_ANSWER_MAX_BYTES / MIB} MiB`);
    expect(FLAT_DOC).toContain(`${n(SNOWFLAKE_ROWS_PER_RESULTSET - 1)} rows`);
    expect(FLAT_DOC).toContain(`${n(SNOWFLAKE_SHOW_PAGE_ROWS)} rows`);
    expect(FLAT_DOC).toContain(`${SNOWFLAKE_KEY_MAX_BYTES / 1024} KiB`);
    expect(FLAT_DOC).toContain(`${SNOWFLAKE_SURFACE_TIMEOUT_S} s`);
    expect(FLAT_DOC).toContain(`${SNOWFLAKE_JWT_LIFETIME_S / 60} minutes`);
    expect(FLAT_DOC).toContain(`${SNOWFLAKE_JWT_RENEW_AFTER_S / 60} minutes`);
    const { perProvider, perEngine, queueDepth } = SNOWFLAKE_LIMITER_OPTIONS;
    expect(FLAT_DOC).toContain(
      `${perProvider} statements per connection, ${perEngine} per Studio process, and a queue of ${queueDepth}`,
    );
  });

  test("puts no secret in an example and names no private record", () => {
    expect(DOC).not.toMatch(/-----BEGIN (ENCRYPTED |RSA )?PRIVATE KEY-----\s*\n\s*[A-Za-z0-9+/]{20}/);
    expect(DOC).not.toMatch(/\/home\/|design record|\/private\//);
    expect(DOC).not.toMatch(/\b(SR|SF|SD|OD)-?\d+/);
    expect(DOC).not.toMatch(/\bM\d{1,3}\b/);
    expect(DOC).not.toMatch(/[–—]/);
  });
});

describe("every other number and sentence the doc states is the code's", () => {
  const seconds = (ms: number): string => `${ms / 1000} s`;

  test("the statement timeout, its deadline, the poll and the cancel bound", () => {
    expect(FLAT_DOC).toContain(
      `from 1 to Snowflake's maximum of ${n(SNOWFLAKE_MAX_TIMEOUT_S)}; a statement Studio sends on its own takes the smaller of ${SNOWFLAKE_SURFACE_TIMEOUT_S} s and that value`,
    );
    expect([clampedTimeoutS(1), clampedTimeoutS(2_147_483_647)]).toEqual([1, SNOWFLAKE_MAX_TIMEOUT_S]);
    expect([surfaceTimeoutS(60_000), surfaceTimeoutS(10_000)]).toEqual([SNOWFLAKE_SURFACE_TIMEOUT_S, 10]);
    expect(FLAT_DOC).toContain(
      `polls the statement from ${SNOWFLAKE_POLL_FIRST_MS} ms, doubling to ${seconds(SNOWFLAKE_POLL_MAX_MS)}, and cancels it at its deadline, ${seconds(SNOWFLAKE_DEADLINE_GRACE_MS)} past its \`timeout\``,
    );
    expect(deadlineMsFor(60)).toBe(60_000 + SNOWFLAKE_DEADLINE_GRACE_MS);
    expect(FLAT_DOC).toContain(`under a ${seconds(SNOWFLAKE_CANCEL_TIMEOUT_MS)} bound`);
    expect(FLAT_DOC).toContain(
      `A disconnect waits at most ${seconds(SNOWFLAKE_CANCEL_TIMEOUT_MS)} for a statement whose submit has not answered yet, so a close never hangs on Snowflake; past that bound Studio stops waiting without a handle to cancel, and a statement Snowflake accepted in that submit runs on until its own \`timeout\` ends it.`,
    );
  });

  test("the resend ladder, the partition size and the User-Agent", () => {
    expect(FLAT_DOC).toContain(
      `after a backoff from ${SNOWFLAKE_RETRY_BASE_MS} ms doubling to ${seconds(SNOWFLAKE_RETRY_MAX_MS)}, at most ${SNOWFLAKE_RETRY_ATTEMPTS} sends`,
    );
    expect([snowflakeBackoffMs(1, 1), snowflakeBackoffMs(SNOWFLAKE_RETRY_ATTEMPTS, 1)]).toEqual([
      SNOWFLAKE_RETRY_BASE_MS,
      SNOWFLAKE_RETRY_MAX_MS,
    ]);
    expect(FLAT_DOC).toContain(`setting \`client_result_chunk_size\` to ${SNOWFLAKE_CHUNK_SIZE_MB}`);
    expect(SNOWFLAKE_USER_AGENT).toMatch(/^LibreDB-Studio(\/.+)?$/);
    expect(FLAT_DOC).toContain(
      "Every request sends the User-Agent `LibreDB-Studio/<version>`, or `LibreDB-Studio` in the embedded package, whose build injects no version.",
    );
  });

  test("the key bounds, the server text cut, the host labels, the tree pages and the panel cache", () => {
    expect(FLAT_DOC).toContain(`RSA, ${SNOWFLAKE_RSA_MIN_BITS} to ${SNOWFLAKE_RSA_MAX_BITS} bits`);
    expect(SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha512).toBe(SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha384);
    expect(FLAT_DOC).toContain(
      `${n(SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha256)} PBKDF2 iterations with hmacWithSHA256, ${n(SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha1)} with hmacWithSHA1 (the PRF when none is named), ${n(SNOWFLAKE_MAX_PBKDF2_ITERATIONS.sha384)} with hmacWithSHA384 or hmacWithSHA512, or scrypt N ${n(SNOWFLAKE_MAX_SCRYPT_N)}, r ${SNOWFLAKE_MAX_SCRYPT_R}, p ${SNOWFLAKE_MAX_SCRYPT_P}`,
    );
    expect(FLAT_DOC).toContain(`cut at ${n(SNOWFLAKE_SERVER_TEXT_MAX_CHARS)} characters`);
    expect(SNOWFLAKE_MAX_HOST_LABELS).toBe(5);
    expect(FLAT_DOC).toContain("with at most five labels before the suffix");
    expect(SNOWFLAKE_TREE_PAGE_LIMIT).toBe(5);
    expect(FLAT_DOC).toContain(
      `up to five pages: \`Snowflake has more than ${n(SNOWFLAKE_TREE_PAGE_LIMIT * SNOWFLAKE_SHOW_PAGE_ROWS)} objects`,
    );
    expect(FLAT_DOC).toContain(`Information Schema reads are cached for ${seconds(SNOWFLAKE_MONITORING_TTL_MS)}`);
  });

  test("the tree's kinds table lists every kind, in the code's order", () => {
    const tree = sectionOf(DOC, "## 7. The tree");
    expect(firstCells(tree)).toEqual(SNOWFLAKE_OBJECT_KINDS.map((kind) => kind.labelPlural));
    expect(SNOWFLAKE_OBJECT_KINDS.map((kind) => kind.id)).toEqual([...SNOWFLAKE_KIND_IDS]);
  });

  test("the tree's cut is stated as silent, since listObjects carries no truncation", () => {
    expect(FLAT_DOC).toContain(
      "The tree has no place for a listing's sentence, so it shows the first 50,000 objects of a pageable kind without one; the object inventory, which the agent and the inventory route read, carries that sentence.",
    );
  });

  test("the SHOW bounds are stated as measured, Studio's LIMIT as Studio's own", () => {
    const tree = flat(sectionOf(DOC, "## 7. The tree"));
    expect(tree).not.toContain("Snowflake answers at most 10,000 rows for one `SHOW`");
    expect(tree).not.toContain("whether or not Snowflake repeats the name");
    for (const pinned of [
      "On the trial on 2026-10-13, over 10,250 tables in one scratch schema and 10,250 sequences in another, `SHOW TABLES` and `SHOW TERSE OBJECTS` without a `LIMIT` answered all 10,250 rows, with no error and no 10,000-row ceiling.",
      "Studio still sends `LIMIT 10000` wherever Snowflake offers paging, so each answer stays bounded:",
      "each from the previous page's last name with `FROM`, which starts after the name it is given (a page with nothing past that name ends the listing), up to five pages",
      "Any other listing has no paging and is sent with no `LIMIT`: `SHOW SEQUENCES` answered all 10,250 rows with and without `LIMIT` and `FROM`, since it ignores both, and the 10,000 rows Snowflake's reference gives as the most the other listings answer is not measured.",
      "A count of exactly 10,000, Studio's own `LIMIT`: `Studio counts at most 10,000 objects here, so this is a floor.`",
    ]) {
      expect(tree).toContain(pinned);
    }
  });

  test("quotes the sentence a restored Source tab shows while the connection is held", () => {
    expect(FLAT_DOC).toContain(`\`${SOURCE_BILLED_COMPUTE_HOLD}\``);
  });

  test("the describe sentence claims no primary key mark, since the detail carries only isPrimary", () => {
    expect(FLAT_DOC).not.toContain("marked not enforced");
    expect(FLAT_DOC).toContain(
      "a primary key column is shown as a key with no further mark, although Snowflake does not enforce primary keys on standard tables",
    );
  });

  test("the type table's cells are what the decoder gives, and its refusals are quoted", () => {
    const column = (type: string, scale: number | null = null) => ({
      name: "C",
      type,
      precision: 38,
      scale,
      length: null,
    });
    expect(decodeCell(column("fixed", 0), "42")).toBe(42);
    expect(decodeCell(column("fixed", 0), "9007199254740993")).toBe("9007199254740993");
    expect(decodeCell(column("fixed", 2), "1.50")).toBe("1.50");
    expect(decodeCell(column("real"), "NaN")).toBe("NaN");
    expect(decodeCell(column("boolean"), "TRUE")).toBe(true);
    expect(decodeCell(column("date"), "0")).toBe("1970-01-01");
    expect(decodeCell(column("timestamp_ltz", 0), "0")).toBe("1970-01-01 00:00:00+00:00");
    expect(decodeCell(column("variant"), '{"a": 1}')).toBe('{"a": 1}');
    expect(FLAT_DOC).toContain(`\`${SNOWFLAKE_DECODE_SENTENCES.unreadable("<type>", "<column>")}\``);
    expect(FLAT_DOC).toContain(`\`${SNOWFLAKE_DECODE_SENTENCES.columns}\``);
  });
});
