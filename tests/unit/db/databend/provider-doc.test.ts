/**
 * `docs/providers/databend.md` quotes sentences and numbers the code owns (design section 10), the shape of
 * `tests/unit/db/influxdb/provider-doc-influxdb3.test.ts`: one test file per type-id, because the tri-sync invariant
 * is per type-id.
 *
 * A value copied into prose is true only until the code moves, so every exported sentence of the provider, every
 * field hint, bound, setting, grammar field, capability and label the doc quotes is read back here from the module
 * that owns it, and the pinned build from the capture manifest. A sentence record is quoted whole: each record's keys
 * are listed here, so a sentence added to the code fails this file until the doc quotes it. A template is written in
 * the doc with the bracketed placeholders this file fills.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYAML } from "yaml";
import { createErrorResponse } from "@/lib/api/errors";
import {
  DATABEND_DSN_CAUTIONS,
  DATABEND_DSN_REFUSALS,
  DATABEND_SSLMODE_NOTICES,
  databendNotAppliedNotice,
  parseConnectionString,
} from "@/lib/connection-string-parser";
import { IMPORT_NO_TARGET, importRefusal } from "@/components/DataImportModal";
import { BILLED_COMPUTE_HOLD } from "@/components/object-tree/ObjectTree";
import { DB_UI_CONFIG, DATABEND_FIELD_HINTS } from "@/lib/db-ui-config";
import {
  CONNECTION_STRING_ACCEPTED,
  MCP_EXPOSABLE,
  READ_ONLY_ENFORCED,
  READS_FILE_ACCESS_POSTURE,
} from "@/lib/db/compatibility";
import { CREDENTIAL_WARNINGS } from "@/lib/db/credential-warnings";
import { TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { DATABEND_ANSWER_SENTENCES, RESULT_MODE_FLOOR, readAnswer } from "@/lib/db/providers/sql/databend/answer";
import { AUTH_LATCH_MAX_ENTRIES, AUTH_LATCH_TTL_MS } from "@/lib/db/providers/sql/databend/auth-latch";
import { databendCloudHostWarehouse } from "@/lib/db/providers/sql/databend/cloud-host";
import {
  DATABEND_CELL_BUDGET,
  DATABEND_CLOSE_TIMEOUT_MS,
  DATABEND_CONNECTION_SENTENCES,
  DATABEND_DEFAULT_PORT,
  DATABEND_LIMITER_OPTIONS,
  DATABEND_MAX_SOCKETS,
  DATABEND_REQUEST_HEADER_NAMES,
  DATABEND_RESPONSE_CAP_BYTES,
  DATABEND_STATEMENT_BYTES,
  DATABEND_SURFACE_TIMEOUT_MS,
} from "@/lib/db/providers/sql/databend/connection-options";
import { decodeOutcome } from "@/lib/db/providers/sql/databend/decode";
import {
  answerError,
  DATABEND_ERROR_SENTENCES,
  DATABEND_PROTOCOL_FAULTS,
  type DatabendFailureContext,
  refusalError,
  stopError,
  toDatabaseError,
  transportFailure,
} from "@/lib/db/providers/sql/databend/errors";
import { DATABEND_PAGE_UNANSWERED, DATABEND_WARNING_LIMIT } from "@/lib/db/providers/sql/databend/http-transport";
import { DATABEND_PROVIDER_SENTENCES, DatabendProvider } from "@/lib/db/providers/sql/databend/index";
import {
  DATABEND_DEFAULT_SESSION_LIMIT,
  DATABEND_DEFAULT_SLOW_QUERY_LIMIT,
  DATABEND_DEGRADE_CODES,
  DATABEND_MAX_MONITORING_LIMIT,
  DATABEND_MONITORING_SENTENCES,
  DATABEND_UNAVAILABLE_TEXT,
  DATABEND_UNKNOWN_TEXT,
  databendSessionsSql,
  databendSlowQueriesSql,
  getActiveSessions,
  getHealth,
  getOverview,
} from "@/lib/db/providers/sql/databend/introspect";
import { DATABEND_KILL_SPEC, DATABEND_LABEL_SENTENCES, DATABEND_LABELS } from "@/lib/db/providers/sql/databend/labels";
import { DATABEND_OBJECT_SENTENCES, type DatabendStatementRunner } from "@/lib/db/providers/sql/databend/objects";
import { retryDecision } from "@/lib/db/providers/sql/databend/retry";
import { LOGOUT_PATH, NEXT_URI_REFUSED, QUERY_PATH } from "@/lib/db/providers/sql/databend/routes";
import {
  globalSettingsChangedWarning,
  ROLE_NOT_CARRIED,
  SETTINGS_NOT_CARRIED,
  TEMP_TABLES_DROPPED,
  TRANSACTION_ENDED,
  TRANSACTION_MAY_STAY_OPEN,
  USE_NOT_CARRIED,
} from "@/lib/db/providers/sql/databend/session";
import {
  DATABEND_FORM_FEED,
  DATABEND_HINT_SEMICOLON,
  DATABEND_HINT_TOKEN,
  DATABEND_IDENTIFIER_DOLLAR,
  DATABEND_MULTIPLE_STATEMENTS,
  DATABEND_NO_STATEMENT,
  DATABEND_STAGE_RUN_ON,
  DATABEND_TAGGED_DOLLAR,
  DATABEND_UNTERMINATED_SPAN,
  databendStatementRefusal,
} from "@/lib/db/providers/sql/databend/sql-text";
import { DatabendError, type DatabendTruncation } from "@/lib/db/providers/sql/databend/transport";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { DATABEND_EXPLAIN_DECLINES, databendTextStrategy } from "@/lib/explain/databend-text";
import { buildResultExport } from "@/lib/export/result-export";
import { SeedConnectionSchema } from "@/lib/seed/types";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import type { DatabaseConnection } from "@/lib/types";
import { loadDatabendManifest } from "../../../helpers/databend-fixtures";
import {
  idsOf,
  ok,
  pathsOf,
  runSignal,
  scriptedNodeTransport,
  statement,
  transportDeps,
  transportHarness,
} from "../../../helpers/databend-node-transport";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const DOC = read("docs/providers/databend.md");
const BACKLOG = read("docs/BACKLOG.md");
const FIXTURE_README = read("docker/databend/README.md");

const CONNECTION: DatabaseConnection = {
  id: "databend-doc",
  name: "Databend",
  type: "databend",
  host: "localhost",
  port: DATABEND_DEFAULT_PORT,
  user: "root",
  createdAt: new Date(0),
};
const provider = new DatabendProvider(CONNECTION);
const capabilities = provider.getCapabilities();
const UI = DB_UI_CONFIG.databend;

/** Thousands grouped by commas, the doc's spelling, the same in every locale. */
const n = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces. */
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");
const FLAT_DOC = flat(DOC);
const MIB = 1024 * 1024;

/** The section under the heading line `heading`, up to the next heading of its level or above. */
/** The Cloud acceptance's capture run (plan section 7), which the replay does not read. */
const CLOUD_CAPTURE_RUN = "cloud-2026-10-08-v1.2.951-nightly";

interface CloudManifest {
  readonly target: string;
  readonly uncommitted: readonly string[];
  readonly serverVersion: string;
  readonly capturedAt: string;
  readonly scenarios: readonly { readonly name: string; readonly result: string }[];
}

function loadCloudManifest(): CloudManifest {
  return JSON.parse(
    readFileSync(path.join(ROOT, "tests/fixtures/databend", CLOUD_CAPTURE_RUN, "manifest.json"), "utf8"),
  ) as CloudManifest;
}

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

/** The table row of `text` whose first cell is exactly `cell`. */
const rowOf = (text: string, cell: string): string | undefined =>
  text.split("\n").find((line) => line.startsWith(`| ${cell} |`));

/** A placeholder standing where a template takes a number. */
const slot = (name: string): number => name as unknown as number;

/** The statement budget's own cut, as a cut result reports it. */
const BYTES_CUT: DatabendTruncation = { bound: "bytes", limit: DATABEND_STATEMENT_BYTES };
const CELLS_CUT: DatabendTruncation = { bound: "cells", limit: DATABEND_CELL_BUDGET };
const ROWS_CUT: DatabendTruncation = { bound: "rows", limit: MAX_UNLIMITED_ROWS };

/**
 * Every sentence of each exported record, keyed as the record is, each template filled with the doc's placeholders.
 * A key the code adds and this map lacks fails the key check below.
 */
const QUOTED: Readonly<Record<string, { readonly keys: readonly string[]; readonly quotes: readonly string[] }>> = {
  DATABEND_CONNECTION_SENTENCES: {
    keys: Object.keys(DATABEND_CONNECTION_SENTENCES),
    quotes: [
      DATABEND_CONNECTION_SENTENCES.userRequired,
      DATABEND_CONNECTION_SENTENCES.userColon,
      DATABEND_CONNECTION_SENTENCES.control("User"),
      DATABEND_CONNECTION_SENTENCES.control("Password"),
      DATABEND_CONNECTION_SENTENCES.malformed("User"),
      DATABEND_CONNECTION_SENTENCES.malformed("Password"),
      DATABEND_CONNECTION_SENTENCES.warehouse,
      DATABEND_CONNECTION_SENTENCES.plaintext,
      DATABEND_CONNECTION_SENTENCES.tunnelNotOpened,
      DATABEND_CONNECTION_SENTENCES.queryTimeout,
      DATABEND_CONNECTION_SENTENCES.wrongType("[field]", "[type]"),
    ],
  },
  DATABEND_ANSWER_SENTENCES: {
    keys: Object.keys(DATABEND_ANSWER_SENTENCES),
    quotes: [DATABEND_ANSWER_SENTENCES.resultMode(""), DATABEND_ANSWER_SENTENCES.resultMode("[mode]")],
  },
  DATABEND_ERROR_SENTENCES: {
    keys: Object.keys(DATABEND_ERROR_SENTENCES),
    quotes: [
      DATABEND_ERROR_SENTENCES.latched("[time]", "[until]"),
      DATABEND_ERROR_SENTENCES.signInRefused,
      DATABEND_ERROR_SENTENCES.possibleLockout,
      DATABEND_ERROR_SENTENCES.cloudSqlUser,
      DATABEND_ERROR_SENTENCES.statementForbidden("[server text]"),
      DATABEND_ERROR_SENTENCES.signInMissing,
      DATABEND_ERROR_SENTENCES.followUpRefused,
      DATABEND_ERROR_SENTENCES.warehouseRefused("[warehouse]"),
      DATABEND_ERROR_SENTENCES.warehouseRequired,
      DATABEND_ERROR_SENTENCES.hostRefused,
      DATABEND_ERROR_SENTENCES.middlewareRefused("[server text]"),
      DATABEND_ERROR_SENTENCES.middlewareRefused(""),
      DATABEND_ERROR_SENTENCES.nothingRan,
      DATABEND_ERROR_SENTENCES.resuming("[warehouse]", "[seconds]"),
      DATABEND_ERROR_SENTENCES.unavailable("[cause]", "[seconds]"),
      DATABEND_ERROR_SENTENCES.noAnswer("[cause]"),
      DATABEND_ERROR_SENTENCES.warehouseStarting,
      DATABEND_ERROR_SENTENCES.cancelledBeforeAnswer,
      DATABEND_ERROR_SENTENCES.deadlineBeforeAnswer("[seconds]"),
      DATABEND_ERROR_SENTENCES.cancelUnanswered,
      DATABEND_ERROR_SENTENCES.deadline("[seconds]"),
      DATABEND_ERROR_SENTENCES.deadlineUnacknowledged("[seconds]"),
      DATABEND_ERROR_SENTENCES.cancelled,
      DATABEND_ERROR_SENTENCES.protocol("[fault]"),
      DATABEND_ERROR_SENTENCES.server(slot("[status]"), "[server text]"),
      DATABEND_ERROR_SENTENCES.tls("[transport error]"),
      DATABEND_ERROR_SENTENCES.network("[host]", slot("[port]"), "[cause]"),
      DATABEND_ERROR_SENTENCES.currentDatabase,
    ],
  },
  DATABEND_PROTOCOL_FAULTS: {
    keys: Object.keys(DATABEND_PROTOCOL_FAULTS),
    quotes: [
      DATABEND_PROTOCOL_FAULTS.notAnswer,
      DATABEND_PROTOCOL_FAULTS.notJson,
      DATABEND_PROTOCOL_FAULTS.prototypeKey,
      DATABEND_PROTOCOL_FAULTS.field("[field]"),
      DATABEND_PROTOCOL_FAULTS.cell,
      DATABEND_PROTOCOL_FAULTS.width(slot("[cells]"), slot("[columns]")),
      DATABEND_PROTOCOL_FAULTS.link,
      DATABEND_PROTOCOL_FAULTS.queryId,
      DATABEND_PROTOCOL_FAULTS.sessionId,
      DATABEND_PROTOCOL_FAULTS.proxySession,
      DATABEND_PROTOCOL_FAULTS.pageSchema,
      DATABEND_PROTOCOL_FAULTS.pollBound,
      DATABEND_PROTOCOL_FAULTS.rows,
      DATABEND_PROTOCOL_FAULTS.schema,
      DATABEND_PROTOCOL_FAULTS.values,
      DATABEND_PROTOCOL_FAULTS.depth,
    ],
  },
  DATABEND_LABEL_SENTENCES: {
    keys: Object.keys(DATABEND_LABEL_SENTENCES),
    quotes: Object.values(DATABEND_LABEL_SENTENCES),
  },
  DATABEND_PROVIDER_SENTENCES: {
    keys: Object.keys(DATABEND_PROVIDER_SENTENCES),
    quotes: [
      DATABEND_PROVIDER_SENTENCES.params,
      DATABEND_PROVIDER_SENTENCES.resultCut(BYTES_CUT),
      DATABEND_PROVIDER_SENTENCES.resultCut(CELLS_CUT),
      DATABEND_PROVIDER_SENTENCES.resultCut(ROWS_CUT),
      DATABEND_PROVIDER_SENTENCES.closeFailed("final"),
      DATABEND_PROVIDER_SENTENCES.closeFailed("rollback"),
      DATABEND_PROVIDER_SENTENCES.closeFailed("logout"),
      DATABEND_PROVIDER_SENTENCES.closeRefused("final"),
      DATABEND_PROVIDER_SENTENCES.closeRefused("rollback"),
      DATABEND_PROVIDER_SENTENCES.closeRefused("logout"),
      DATABEND_PROVIDER_SENTENCES.closeSkipped("logout"),
      DATABEND_PROVIDER_SENTENCES.warningsLeftOut(slot("[count]")),
      DATABEND_PROVIDER_SENTENCES.databaseMissing("[database]"),
      DATABEND_PROVIDER_SENTENCES.unverifiedTls,
      DATABEND_PROVIDER_SENTENCES.slotsBusy("[seconds]"),
      DATABEND_PROVIDER_SENTENCES.maintenanceRefused("[operation]"),
    ],
  },
  DATABEND_MONITORING_SENTENCES: {
    keys: Object.keys(DATABEND_MONITORING_SENTENCES),
    quotes: [
      DATABEND_MONITORING_SENTENCES.killNeedsId,
      DATABEND_MONITORING_SENTENCES.killIdRefused,
      DATABEND_MONITORING_SENTENCES.killAsked("[session id]"),
    ],
  },
  DATABEND_DSN_REFUSALS: {
    keys: Object.keys(DATABEND_DSN_REFUSALS),
    quotes: Object.values(DATABEND_DSN_REFUSALS),
  },
  DATABEND_SSLMODE_NOTICES: {
    keys: Object.keys(DATABEND_SSLMODE_NOTICES),
    quotes: Object.values(DATABEND_SSLMODE_NOTICES),
  },
  DATABEND_DSN_CAUTIONS: {
    keys: Object.keys(DATABEND_DSN_CAUTIONS),
    quotes: [DATABEND_DSN_CAUTIONS.caFile, DATABEND_DSN_CAUTIONS.sslmode("verify-full")],
  },
  DATABEND_EXPLAIN_DECLINES: {
    keys: Object.keys(DATABEND_EXPLAIN_DECLINES),
    quotes: [
      DATABEND_EXPLAIN_DECLINES.binding("[word]", "[construct]"),
      DATABEND_EXPLAIN_DECLINES.writer("[name]"),
      DATABEND_EXPLAIN_DECLINES.hint,
      DATABEND_EXPLAIN_DECLINES.stage,
      DATABEND_EXPLAIN_DECLINES.formFeed,
      DATABEND_EXPLAIN_DECLINES.taggedDollar,
      DATABEND_EXPLAIN_DECLINES.unterminated,
      DATABEND_EXPLAIN_DECLINES.hintAdvice,
      DATABEND_EXPLAIN_DECLINES.formFeedAdvice,
      DATABEND_EXPLAIN_DECLINES.taggedDollarAdvice,
    ],
  },
  DATABEND_OBJECT_SENTENCES: {
    keys: Object.keys(DATABEND_OBJECT_SENTENCES),
    quotes: [
      DATABEND_OBJECT_SENTENCES.bound(BYTES_CUT),
      DATABEND_OBJECT_SENTENCES.incomplete("[surface]", BYTES_CUT),
      DATABEND_OBJECT_SENTENCES.bulkCut(BYTES_CUT),
      DATABEND_OBJECT_SENTENCES.incomplete("definition", BYTES_CUT),
      DATABEND_OBJECT_SENTENCES.unknownTableType("[type]"),
      DATABEND_OBJECT_SENTENCES.unknownKind("[kind]"),
      DATABEND_OBJECT_SENTENCES.badLimit(slot("[limit]")),
      DATABEND_OBJECT_SENTENCES.noColumns("[object]"),
      DATABEND_OBJECT_SENTENCES.noColumnsLeftOut(["[object]"]),
      DATABEND_OBJECT_SENTENCES.noDefinition("[object]"),
      DATABEND_OBJECT_SENTENCES.noPassword("[user]"),
      DATABEND_OBJECT_SENTENCES.sourceLabel,
    ],
  },
};

/** The sentence constants of sql-text.ts, every export of it but the guard function. */
const GUARD_SENTENCES: readonly string[] = [
  DATABEND_FORM_FEED,
  DATABEND_HINT_SEMICOLON,
  DATABEND_HINT_TOKEN,
  DATABEND_IDENTIFIER_DOLLAR,
  DATABEND_MULTIPLE_STATEMENTS,
  DATABEND_NO_STATEMENT,
  DATABEND_STAGE_RUN_ON,
  DATABEND_TAGGED_DOLLAR,
  DATABEND_UNTERMINATED_SPAN,
];

describe("docs/providers/databend.md quotes what the code says", () => {
  test("the title and the overview name the dialog's label", () => {
    expect(UI.label).toBe("Databend");
    expect(DOC.split("\n")[0]).toBe(`# ${UI.label} Provider`);
    expect(sectionOf(DOC, "## 1. Overview")).toContain(`"${UI.label}"`);
  });

  test("the header names the egress switch, the pinned build, the floor build and what ran on Databend Cloud", () => {
    const head = DOC.slice(0, DOC.indexOf("## 1. Overview"));
    expect(head).toContain(
      "`DB_HTTP_BLOCK_PRIVATE_HOSTS=true` blocks loopback, private, link-local and other non-public HTTP destinations; it is off by default so local connections work.",
    );
    const verified = rowOf(head, "**Verified against**") ?? "";
    const pin = loadDatabendManifest().image;
    expect(pin).toMatch(/^datafuselabs\/databend:v1\.2\.951-nightly@sha256:[0-9a-f]{64}$/);
    expect(verified).toContain(`\`${pin}\``);
    const floor = /datafuselabs\/databend:(v1\.2\.881@sha256:[0-9a-f]{64})/.exec(FIXTURE_README)?.[1];
    expect(floor).toBeDefined();
    expect(verified).toContain(`\`datafuselabs/databend:${floor}\``);
    // The Cloud acceptance of plan section 7 ran through the provider on a test tenant of the pinned build; its
    // evidence is the committed capture run, so the date, the build and the scenario count are read from its manifest.
    const cloud = loadCloudManifest();
    expect(cloud.target).toBe("cloud");
    expect(cloud.uncommitted).toEqual([]);
    expect(cloud.scenarios.every((scenario) => scenario.result === "pass")).toBe(true);
    const build = /^Databend Query v(\d+\.\d+\.\d+-nightly-[0-9a-f]+)\(/.exec(cloud.serverVersion)?.[1];
    expect(build).toBe("1.2.951-nightly-9b7eeff9a8");
    expect(verified).toContain(
      `Databend Cloud: on ${cloud.capturedAt} a throwaway test tenant running \`${build}\`, the pinned build, passed the live check through its gateway, 22 of 22 checks with the cold start skipped, and all ${cloud.scenarios.length} evidence scenarios`,
    );
    expect(verified).toContain("not run yet");
    expect(RESULT_MODE_FLOOR).toBe("v1.2.881");
  });

  test("the Cloud results the doc states are the ones measured", () => {
    const cloudSection = flat(sectionOf(DOC, "### 4.4 Databend Cloud: warehouse, cold start and billing"));
    // C2 (I19): the one resume timed, with a plain HTTP client, after the warehouse was suspended in the console.
    expect(cloudSection).toContain("answered in 4.33 s");
    expect(cloudSection).toContain("(1063)");
    const live = flat(sectionOf(DOC, "### 11.3 The live check"));
    expect(live).toContain(`On Databend Cloud, on ${loadCloudManifest().capturedAt}, it passed 22 of 22 checks`);
    expect(live).not.toContain("budgets through the gateway are not run yet");
    // D14c: an object created while the current role is `public` is owned by `public`, which every user holds.
    expect(flat(sectionOf(DOC, "### 12.2 Running Databend for Studio"))).toContain(
      "whose current role is not `public`",
    );
    const limits = flat(sectionOf(DOC, "## 13. Known limitations"));
    expect(limits).not.toContain("only paging was measured");
    // A cold start through Studio's UI was measured after the live check, against the suspended warehouse.
    expect(limits).not.toContain("a cold start through Studio");
    expect(limits).toContain("and multi-node paging is not run yet");
    // DATABEND_LIMITER_OPTIONS: one engine key for the process, which the tree, monitoring and probe reads share.
    expect(DATABEND_LIMITER_OPTIONS.perEngine).toBe(2);
    expect(limits).toContain(
      "One Studio process runs at most two Databend statements at a time, across every Databend connection and user, the tree, monitoring and connect reads included; a third waits for a slot up to its deadline, and a tree read that waited 10 seconds says the slots stayed busy (section 3.10).",
    );
    expect(limits).toContain(
      "A first statement or Test Connection on a suspended Databend Cloud warehouse fails with the resuming sentence while the resume outlasts the 10-second connect budget, and passes once the warehouse runs (section 4.4).",
    );
    expect(cloudSection).toContain(
      "Measured through Studio's UI on 2026-10-08, against the test tenant's warehouse while it was suspended: two runs of `SELECT 1` about 13 seconds apart, and the tree read the first one released, met this sentence, every request of them answered HTTP 503 with it 10 or 20 seconds after it was sent, and a `SELECT 1` sent 3 minutes later answered in 979 ms.",
    );
    // The live check's S3 and S3b are the two bounds it runs through the gateway; the bounds of one answer, the cell
    // budget and the warning bound ran locally only, so neither section may say every budget ran there or none did.
    const bounds = flat(sectionOf(DOC, "### 3.10 Bounds, and what they were measured against"));
    expect(bounds).not.toContain("only paging was measured");
    expect(bounds).toContain(
      "Through the Databend Cloud gateway the live check read 100,000 rows whole over the page chain and cut a statement at the 16 MiB budget of answer text; the bounds of one answer, the cell budget and the warning bound were not run there.",
    );
    expect(limits).not.toContain("Every budget was verified locally and through Databend Cloud's gateway");
    expect(limits).toContain(
      "through Databend Cloud's gateway, on one warehouse, only the 100,000-row read and the 16 MiB budget of answer text ran",
    );
  });

  test("section 3.1 says where the editor sends several statements, and no control the UI lacks", () => {
    const guard = flat(sectionOf(DOC, "### 3.1 One statement per request, and the guard before it"));
    expect(guard).toContain(
      "In the editor, a selection of several statements goes to Studio's multi-statement route, which splits it under the same grammar row and sends each statement on its own.",
    );
    expect(DOC).not.toContain("Run All");
  });

  test("the header sends a DSN to Paste URL, and the overview names no other type's route (owner decision Q6)", () => {
    const head = DOC.slice(0, DOC.indexOf("## 1. Overview"));
    expect(rowOf(head, "**Connection string**")).toBe(
      "| **Connection string** | Not offered: a pasted `https://` address goes into Host, which splits it, and a `databend://` DSN into Paste URL of a new connection, which fills the fields ([4.1](#41-configuration-fields)) |",
    );
    const overview = flat(sectionOf(DOC, "## 1. Overview"));
    expect(overview).not.toContain("`mysql`");
    // The one fact the unreachable sentence relies on.
    expect(overview).toContain(
      "Studio does not use Databend's MySQL handler (port 3307) or its Flight SQL handler (port 8900).",
    );
    expect(DATABEND_ERROR_SENTENCES.network("[host]", slot("[port]"), "[cause]")).toContain(
      "3307 (MySQL) and 8900 (Flight SQL) are not used",
    );
  });

  test("a Databend Cloud host, the older one that names its warehouse included, is stated where the billing is", () => {
    const cloud = flat(sectionOf(DOC, "### 4.4 Databend Cloud: warehouse, cold start and billing"));
    expect(cloud).toContain("`<tenant>--<warehouse>.gw.<region>.default.databend.com`");
    // RI-4: the clients' test is for their presign mode, and it counts tidbcloud.com too.
    expect(cloud).toContain("A host under `databend.com`, `databend.cn` or `tidbcloud.com` is Databend Cloud's");
    expect(cloud).toContain("when they choose their presign mode for uploads, not for billing");
    expect(cloud).not.toContain("as BendSQL and databend-jdbc tell it apart");
    expect(cloud).toContain(
      "Databend's docs show that form under `databend.com` and `databend.cn` only, so Studio reads no warehouse from a host under `tidbcloud.com`.",
    );
    const older = "tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com";
    expect(new DatabendProvider({ ...CONNECTION, host: older }).getCapabilities().resumesBilledCompute).toBe(true);
    expect(parseConnectionString(`databend://cloudapp@${older}:443/default`)?.warehouse).toBe("eric");
    const lake = "tn3ftqihs--eric.gw.aws-us-east-2.default.tidbcloud.com";
    expect(new DatabendProvider({ ...CONNECTION, host: lake }).getCapabilities().resumesBilledCompute).toBe(true);
    expect(parseConnectionString(`databend://cloudapp@${lake}:443/default`)?.warehouse).toBeUndefined();
    expect(flat(sectionOf(DOC, "### 4.1 Configuration fields"))).toContain(
      "or, with no `warehouse=`, the warehouse an older Databend Cloud host names (section 4.4)",
    );
    expect(flat(sectionOf(DOC, "## 9. Capabilities & labels"))).toContain(
      "`resumesBilledCompute` is declared when Warehouse is set or the host is Databend Cloud's (section 4.4).",
    );
  });

  test("4.4 says a connection Studio opens by itself reads nothing until it is used, and quotes the tree (CL-CORE-2)", () => {
    const cloud = flat(sectionOf(DOC, "### 4.4 Databend Cloud: warehouse, cold start and billing"));
    expect(cloud).toContain(
      "Nor does Studio open it by itself: the connection Studio makes active at sign-in or on a reload, from a link, when the server changes the connection list or when the person deletes the open connection reads nothing past its declaration, which opens no connection, until the person picks it, loads its objects, opens the Schema tab of the phone layout or runs a statement;",
    );
    expect(cloud).toContain(`> ${BILLED_COMPUTE_HOLD}`);
    expect(cloud).toContain("only what a person asks for");
  });

  test("section 10 names an older Cloud host's warehouse as it names a Warehouse, and 4.4 says so (RI-3)", () => {
    const errors = sectionOf(DOC, "## 10. Error handling");
    expect(rowOf(errors, "A 503 or 429 on a GET past its retries, with no warehouse named")).toBe(
      `| A 503 or 429 on a GET past its retries, with no warehouse named | ${DATABEND_ERROR_SENTENCES.unavailable("[cause]", "[seconds]")} |`,
    );
    expect(flat(errors)).toContain(
      `With Warehouse set, or on an older Databend Cloud host that names its warehouse (section 4.4), the no-answer sentence of the POST, of a dropped connection and of a stop before the first answer adds "${DATABEND_ERROR_SENTENCES.warehouseStarting}", and a 503 or 429 on a GET past its retries reads as the resuming sentence of section 4.4.`,
    );
    expect(flat(sectionOf(DOC, "### 4.4 Databend Cloud: warehouse, cold start and billing"))).toContain(
      "For such a host the sentences of this section and of section 10 name the warehouse the host carries, as they name a Warehouse,",
    );
    // The sentences once connect() has put the host's warehouse into the options they read, which
    // cloud-host.test.ts drives through the provider.
    const ctx: DatabendFailureContext = {
      request: "post",
      origin: "user",
      sql: "SELECT 1",
      warehouse: databendCloudHostWarehouse("tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com"),
      endpoint: { host: "tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com", port: 443 },
      timeoutMs: 60_000,
      secretForms: [],
    };
    const refusal = (status: number) => ({
      status,
      contentType: "text/plain",
      code: null,
      gatewayKind: null,
      text: "",
    });
    expect(refusalError(refusal(502), ctx).message).toBe(
      `${DATABEND_ERROR_SENTENCES.noAnswer("HTTP 502")} ${DATABEND_ERROR_SENTENCES.warehouseStarting}`,
    );
    expect(refusalError(refusal(503), { ...ctx, request: "get" }).message).toBe(
      DATABEND_ERROR_SENTENCES.resuming("eric", "60"),
    );
    // Only the no-answer sentence adds it: a dropped connection and a stop before the first answer do, and the
    // outcome-unknown sentences of a stop after it do not (Z1).
    const unanswered = { answered: false, killAcknowledged: false };
    const answered = { answered: true, killAcknowledged: false };
    expect(transportFailure(new TransportError("network", "reset"), unanswered, ctx).message).toBe(
      `${DATABEND_ERROR_SENTENCES.noAnswer("reset")} ${DATABEND_ERROR_SENTENCES.warehouseStarting}`,
    );
    expect(stopError("cancel", unanswered, ctx).message).toBe(
      `${DATABEND_ERROR_SENTENCES.noAnswer(DATABEND_ERROR_SENTENCES.cancelledBeforeAnswer)} ${DATABEND_ERROR_SENTENCES.warehouseStarting}`,
    );
    expect(stopError("cancel", answered, ctx).message).toBe(DATABEND_ERROR_SENTENCES.cancelUnanswered);
    expect(stopError("deadline", answered, ctx).message).toBe(DATABEND_ERROR_SENTENCES.deadlineUnacknowledged("60"));
  });

  test("the sign-in latch is promised for one Studio process, wherever it is promised", () => {
    const latch = flat(sectionOf(DOC, "### 3.7 The sign-in latch"));
    expect(latch).toContain(
      "its kill, ROLLBACK and logout included, that Studio process sends that password to that server again only after 15 minutes",
    );
    expect(latch).toContain("[D252](../BACKLOG.md)");
    // The sentence a latched run reads makes the same promise, for the one server that latched (RI-6).
    const latched = DATABEND_ERROR_SENTENCES.latched("[time]", "[until]");
    expect(latched).toContain("so this Studio server will not send this password again");
    expect(latch).toContain(`> ${latched}`);
    expect(read("docs/DATABASE_PROVIDERS.md")).toContain(
      "auth-latch.ts   #   A refused sign-in is not sent again by this process for 15 minutes",
    );
    expect(flat(sectionOf(DOC, "## 13. Known limitations"))).toContain(
      "The sign-in latch is one Studio process's: several replicas each send a refused password once per 15 minutes",
    );
    const features = read("docs/FEATURES.md")
      .split("\n")
      .find((line) => line.includes("**Databend:**"));
    expect(features).toContain("Each Studio process sends a sign-in Databend refused at most once per 15 minutes");
    const d248 = /^### D248\. [\s\S]*?(?=^### )/m.exec(BACKLOG)?.[0] ?? "";
    expect(d248).toContain("within one Studio process");
    expect(d248).toContain("D252");
  });

  test("section 8 names the privilege the kill needs and what a user without it sees (cl-ops F2)", () => {
    const maintenance = flat(sectionOf(DOC, "## 8. Maintenance"));
    expect(maintenance).toContain("needs the global SUPER privilege");
    // Databend's refusal as the pinned image answered `studio_reader`'s kill of another session (measured 2026-10-08).
    const refusal =
      "Permission denied: privilege [Super] is required on *.* for user 'studio_reader'@'%' with roles [public,studio_ro]. Note: Please ensure that your current role have the appropriate permissions to create a new Object";
    expect(maintenance).toContain(`\`${refusal}\``);
    // The refusal answers with the statement's id, so Studio shows it as Databend wrote it, nothing appended.
    const ctx: DatabendFailureContext = {
      request: "post",
      origin: "provider",
      sql: "KILL QUERY 's1'",
      endpoint: { host: "localhost", port: DATABEND_DEFAULT_PORT },
      timeoutMs: 10_000,
      secretForms: [],
    };
    const refused = answerError({ id: "q", error: { code: 1063, message: refusal, detail: null } }, ctx, null);
    expect(refused.message).toBe(refusal);
    expect(maintenance).toContain("`GRANT SUPER ON *.* TO ROLE <role>`");
    // The re-verification on the CI image of #1593, with SUPER granted for the run and revoked after it.
    expect(maintenance).toContain(
      "With SUPER granted to its role, the panel's kill stopped a running statement on the test tenant, and that statement's editor read \"Aborted query, because the server is shutting down or the query was killed.\" (measured on 2026-10-08).",
    );
  });

  // "That message" is the provider's own kill message, so it follows that quote, and the privilege paragraph comes after
  // what the panel says of a kill; a refusal shows where the shared hook shows every failed kill, in an error toast.
  test("section 8 keeps 'that message' on the provider's kill message and says a refused kill is an error toast (cl-ops F2)", () => {
    const maintenance = sectionOf(DOC, "## 8. Maintenance");
    expect(maintenance).toContain(
      `> ${DATABEND_MONITORING_SENTENCES.killAsked("[session id]")}\n\nThe Sessions panel does not show that message`,
    );
    expect(maintenance.indexOf("Without SUPER")).toBeGreaterThan(
      maintenance.indexOf("On Databend the session is not ended"),
    );
    expect(flat(maintenance)).toContain(
      "Without SUPER, Databend refuses the kill with 1063 before it looks for the session, the statement keeps running, and an error toast shows Databend's refusal as Databend wrote it.",
    );
    const hook = read("src/hooks/use-monitoring-data.ts");
    expect(hook).toContain('throw new Error(result.error || "Failed to kill session");');
    expect(hook).toContain("toast.error(errorMessage);");
  });

  test("the kill is stated as the Sessions panel shows it, which is not the provider's own wording (U98)", () => {
    const maintenance = flat(sectionOf(DOC, "## 8. Maintenance"));
    expect(maintenance).toContain('a "Terminate Session?" dialog');
    expect(maintenance).toContain('"Session [session id] terminated successfully"');
    expect(maintenance).toContain("[U98](../BACKLOG.md)");
    // The panel's copy as the shared UI holds it today; U98 changes both, and then this section.
    expect(read("src/components/monitoring/tabs/SessionsTab.tsx")).toContain("Terminate Session?");
    const dialog =
      "will forcefully end the connection and may cause data loss if the session has uncommitted transactions";
    expect(maintenance).toContain(`says the action "${dialog}"`);
    expect(flat(read("src/components/monitoring/tabs/SessionsTab.tsx"))).toContain(dialog);
    expect(read("src/hooks/use-monitoring-data.ts")).toContain("`Session ${pid} terminated successfully`");
  });

  test("the live check's writes and the readOnly refusal are stated as they happen", () => {
    const live = flat(sectionOf(DOC, "### 11.3 The live check"));
    expect(live).toContain("writes only to `studio_demo` and `libredb_demo`");
    expect(live).toContain("the user `studio_scratch` under the password policy `studio_scratch_policy`");
    expect(flat(sectionOf(DOC, "### 4.1 Configuration fields"))).toContain(
      "a seed file that sets it is refused when the file loads",
    );
    const recipe = /```yaml\n([\s\S]*?)```/.exec(sectionOf(DOC, "### 12.3 A seed connection"))?.[1] ?? "";
    const [seed] = parseYAML(recipe.replace(/\$\{\w+\}/g, "filled")) as Record<string, unknown>[];
    const refused = SeedConnectionSchema.safeParse({ ...seed, readOnly: true });
    expect(refused.error?.issues.map((issue) => issue.path.join("."))).toEqual(["readOnly"]);
    expect(flat(sectionOf(DOC, "### 12.3 A seed connection"))).toContain(
      "`readOnly: true` is refused for this type when the seed file loads (section 4.1)",
    );
  });

  test("the programmatic example names the factory's entry point and no line of it", () => {
    expect(DOC).toMatch(/`createDatabaseProvider\(\)` \(\[`factory\.ts`\]\(\.\.\/\.\.\/src\/lib\/db\/factory\.ts\)\)/);
    expect(DOC).not.toMatch(/factory\.ts:\d/);
  });

  test("the field rows are the dialog's hints, and the port is the provider's default", () => {
    const fields = sectionOf(DOC, "### 4.1 Configuration fields");
    expect(UI.connectionFields).toEqual([
      "host",
      "port",
      "user",
      "password",
      "database",
      "warehouse",
      "allowInsecureAuth",
    ]);
    expect(rowOf(fields, "Host")).toBe(`| Host | ${DATABEND_FIELD_HINTS.host} |`);
    expect(rowOf(fields, "Port")).toBe(
      `| Port | \`${DATABEND_DEFAULT_PORT}\` by default, the query node's HTTP handler; 443 comes from a DSN or an https:// paste, and choosing an SSL mode keeps the port, so set 443 by hand for Databend Cloud |`,
    );
    expect(UI.defaultPort).toBe(String(DATABEND_DEFAULT_PORT));
    expect(capabilities.defaultPort).toBe(DATABEND_DEFAULT_PORT);
    expect(rowOf(fields, "User")).toBe(`| User | ${DATABEND_FIELD_HINTS.user} |`);
    expect(rowOf(fields, "Database")).toBe(`| Database | ${DATABEND_FIELD_HINTS.database} |`);
    expect(rowOf(fields, UI.fieldLabels?.warehouse ?? "")).toBe(`| Warehouse | ${DATABEND_FIELD_HINTS.warehouse} |`);
    expect(rowOf(fields, "Send the password without TLS")).toBe(
      `| Send the password without TLS | ${DATABEND_FIELD_HINTS.allowInsecureAuth} |`,
    );
  });

  test("each row of the paste table is what the parser answers, and every refusal and sslmode notice has a row", () => {
    const paste = sectionOf(DOC, "### 4.1 Configuration fields");
    const rows = paste.split("\n").filter((line) => /^\| `[^`]*` \| /.test(line));
    const named = new Set<string>();
    for (const row of rows) {
      const [text, message] = row.slice(2, -2).split(" | ");
      const parsed = parseConnectionString(text.slice(1, -1));
      expect(parsed?.type, text).toBe("databend");
      expect(parsed?.refusal ?? parsed?.cautions?.join(" ") ?? parsed?.notice, text).toBe(message);
      named.add(message);
    }
    expect([...named].sort()).toEqual(
      [
        ...Object.values(DATABEND_DSN_REFUSALS),
        ...Object.values(DATABEND_SSLMODE_NOTICES),
        DATABEND_DSN_CAUTIONS.caFile,
        DATABEND_DSN_CAUTIONS.sslmode("verify-full"),
      ].sort(),
    );
    const prose = flat(paste);
    for (const scheme of ["`databend://`", "`databend+http://`", "`databend+https://`"]) {
      expect(prose).toContain(scheme);
      expect(parseConnectionString(`${scheme.slice(1, -1)}root@localhost:8000/`)?.type).toBe("databend");
    }
    const ignored = parseConnectionString("databend://root@localhost:8000/?login=disable");
    expect(ignored?.ignoredParameters).toEqual(["login"]);
    expect(prose).toContain(`> ${databendNotAppliedNotice(["[names]"])}`);
  });

  test("tls_ca_file is listed with the parameters that are not applied, as its caution says (RI-2)", () => {
    const prose = flat(sectionOf(DOC, "### 4.1 Configuration fields"));
    expect(prose).toContain(
      "`tls_ca_file` is not applied, nor is an `sslmode` other than `disable`, `require` and `enable`: each gets its caution above.",
    );
    expect(prose).toContain(
      "Any other parameter, `warehouse` and the sign-in ones refused above aside, is not applied either: it is named in a warning, never valued, and the other fields are filled in:",
    );
    expect(prose).not.toContain("A parameter other than `warehouse`, `sslmode` and `tls_ca_file` is not applied");
    const read = (query: string) => parseConnectionString(`databend://root@localhost:8000/db?${query}`);
    expect(read("tls_ca_file=/ca.pem")?.cautions).toEqual([DATABEND_DSN_CAUTIONS.caFile]);
    expect(read("sslmode=verify-full")?.cautions).toEqual([DATABEND_DSN_CAUTIONS.sslmode("verify-full")]);
    for (const mode of ["disable", "require", "enable"]) expect(read(`sslmode=${mode}`)?.cautions).toBeUndefined();
    expect(read("tls_ca_file=/ca.pem&role=r&warehouse=w")?.ignoredParameters).toEqual(["role"]);
    expect(read("access_token=t&role=r")?.refusal).toBe(DATABEND_DSN_REFUSALS.signIn);
  });

  test("a paste past an unread sslmode gets the scheme's port and unticks the cleartext consent, as 4.1 and 4.3 say", () => {
    const fields = flat(sectionOf(DOC, "### 4.1 Configuration fields"));
    expect(fields).toContain(
      "Such an `sslmode` leaves SSL mode as it was, so a DSN without a port gets the scheme's: 80 for `databend+http://` and 443 for `databend://` and `databend+https://`.",
    );
    const port = (scheme: string) => parseConnectionString(`${scheme}root@host/db?sslmode=verify-full`)?.port;
    expect([port("databend+http://"), port("databend://"), port("databend+https://")]).toEqual(["80", "443", "443"]);
    expect(fields).toContain("and clears Send the password without TLS, which no DSN carries,");
    expect(flat(sectionOf(DOC, "### 4.3 TLS and the password rule"))).toContain(
      "A DSN pasted into Paste URL unticks it (section 4.1), so it is ticked again only for the pasted host.",
    );
    for (const scheme of ["databend://", "databend+http://", "databend+https://"])
      expect(parseConnectionString(`${scheme}root@host/db`)?.allowInsecureAuth, scheme).toBe(false);
  });

  test("a count from 2^53 up is the nearest number, as 5.4 says, while the row keeps it exact", () => {
    expect(flat(sectionOf(DOC, "### 5.4 Result shape"))).toContain(
      "The result's row count is a number, so a count from 2^53 up is the nearest one, which can be off in its last digits, while the kept row holds the exact count as text.",
    );
    const column = "number of rows updated";
    const decoded = decodeOutcome({ schema: [{ name: column, type: "UInt64" }], rows: [["9007199254740993"]] }, "U");
    expect(decoded.rowCount).toBe(2 ** 53);
    expect(decoded.rows).toEqual([{ [column]: "9007199254740993" }]);
  });

  test("an @ past the address part is refused whatever the address part holds, and reads one way encoded", () => {
    const prose = flat(sectionOf(DOC, "### 4.1 Configuration fields"));
    const encoded = "databend://root:pw@host:443/db?role=analyst%40corp";
    expect(prose).toContain(
      `An \`@\` past the address part is refused even after the sign-in's own \`@\`, since a password can hold an unencoded \`@\` before its \`/\`; percent-encoded, as in \`${encoded}\`, the text reads one way.`,
    );
    expect(parseConnectionString(encoded)?.refusal).toBeUndefined();
    for (const text of ["databend://root:pw@host:443/db?role=analyst@corp", "databend://root:p@ss/x@host:443/db"])
      expect(parseConnectionString(text)?.refusal).toBe(DATABEND_DSN_REFUSALS.userinfo);
  });

  test("every exported sentence record is quoted whole, key for key", () => {
    const expectedKeys: Readonly<Record<string, readonly string[]>> = {
      DATABEND_CONNECTION_SENTENCES: [
        "userRequired",
        "userColon",
        "control",
        "malformed",
        "warehouse",
        "plaintext",
        "tunnelNotOpened",
        "queryTimeout",
        "wrongType",
      ],
      DATABEND_ANSWER_SENTENCES: ["resultMode"],
      DATABEND_ERROR_SENTENCES: [
        "latched",
        "signInRefused",
        "possibleLockout",
        "cloudSqlUser",
        "statementForbidden",
        "signInMissing",
        "followUpRefused",
        "warehouseRefused",
        "warehouseRequired",
        "hostRefused",
        "middlewareRefused",
        "nothingRan",
        "resuming",
        "unavailable",
        "noAnswer",
        "warehouseStarting",
        "cancelledBeforeAnswer",
        "deadlineBeforeAnswer",
        "cancelUnanswered",
        "deadline",
        "deadlineUnacknowledged",
        "cancelled",
        "protocol",
        "server",
        "tls",
        "network",
        "currentDatabase",
      ],
      DATABEND_PROTOCOL_FAULTS: [
        "notAnswer",
        "notJson",
        "prototypeKey",
        "field",
        "cell",
        "width",
        "link",
        "queryId",
        "sessionId",
        "proxySession",
        "pageSchema",
        "pollBound",
        "rows",
        "schema",
        "values",
        "depth",
      ],
      DATABEND_LABEL_SENTENCES: [
        "analyzeGlobalDesc",
        "vacuumGlobalDesc",
        "slowQueriesEmptyState",
        "sessionsEmptyState",
        "tableStatsCaption",
      ],
      DATABEND_PROVIDER_SENTENCES: [
        "params",
        "resultCut",
        "closeFailed",
        "closeRefused",
        "closeSkipped",
        "warningsLeftOut",
        "databaseMissing",
        "unverifiedTls",
        "slotsBusy",
        "maintenanceRefused",
      ],
      DATABEND_MONITORING_SENTENCES: ["killNeedsId", "killIdRefused", "killAsked"],
      DATABEND_DSN_REFUSALS: ["fragment", "userinfo", "signIn", "flight", "jdbc", "shellExport"],
      DATABEND_SSLMODE_NOTICES: ["require", "enable"],
      DATABEND_DSN_CAUTIONS: ["caFile", "sslmode"],
      DATABEND_EXPLAIN_DECLINES: [
        "binding",
        "writer",
        "hint",
        "stage",
        "formFeed",
        "taggedDollar",
        "unterminated",
        "hintAdvice",
        "formFeedAdvice",
        "taggedDollarAdvice",
      ],
      DATABEND_OBJECT_SENTENCES: [
        "bound",
        "incomplete",
        "bulkCut",
        "unknownTableType",
        "unknownKind",
        "badLimit",
        "noColumns",
        "noColumnsLeftOut",
        "noDefinition",
        "noPassword",
        "sourceLabel",
      ],
    };
    for (const [record, { keys, quotes }] of Object.entries(QUOTED)) {
      expect(keys, record).toEqual([...expectedKeys[record]]);
      for (const quote of quotes) expect(FLAT_DOC, `${record}: ${quote}`).toContain(quote);
    }
  });

  test("the session, routing and paging sentences outside a record are quoted", () => {
    for (const quote of [
      USE_NOT_CARRIED,
      SETTINGS_NOT_CARRIED,
      globalSettingsChangedWarning(["[setting]"]),
      ROLE_NOT_CARRIED,
      TRANSACTION_ENDED,
      TRANSACTION_MAY_STAY_OPEN,
      TEMP_TABLES_DROPPED,
      NEXT_URI_REFUSED,
      DATABEND_PAGE_UNANSWERED,
      DATABEND_UNKNOWN_TEXT,
      DATABEND_UNAVAILABLE_TEXT,
      databendNotAppliedNotice(["[names]"]),
    ]) {
      expect(FLAT_DOC).toContain(quote);
    }
    expect(GUARD_SENTENCES).toHaveLength(9);
    for (const quote of GUARD_SENTENCES) expect(FLAT_DOC).toContain(quote);
  });

  test("the credential warning for root with no password is quoted", () => {
    const [warning] = CREDENTIAL_WARNINGS.databend ?? [];
    expect(warning?.kind).toBe("pair");
    expect(flat(sectionOf(DOC, "### 4.2 Sign-in"))).toContain(`> Credential warning: ${warning?.message}`);
  });

  test("each row of the guard table is refused with the sentence it names, and every guard sentence has a row", () => {
    const guard = sectionOf(DOC, "### 5.2 The statement guard");
    const rows = guard.split("\n").filter((line) => /^\| `[^`]*` \| /.test(line));
    const named = new Set<string>();
    for (const row of rows) {
      const [text, message] = row.slice(2, -2).split(" | ");
      // A form feed cannot be written in a table cell, so the doc spells it \f.
      const sql = text.slice(1, -1).replaceAll("\\f", "\f");
      expect(databendStatementRefusal(sql), sql).toBe(message);
      named.add(message);
    }
    expect([...named].sort()).toEqual([...GUARD_SENTENCES].sort());
    expect(flat(guard)).toContain("`SELECT /*+ SET_VAR(timezone='UTC') */ now()` is sent");
    expect(databendStatementRefusal("SELECT /*+ SET_VAR(timezone='UTC') */ now()")).toBeNull();
  });

  test("the stage rule is stated as the guard applies it, the <@ operator and the names it still refuses included", () => {
    const guard = flat(sectionOf(DOC, "### 5.2 The statement guard"));
    const arrowAt = "SELECT parse_json('[1]')<@/*c*/parse_json('[1,2]') AS r";
    expect(guard).toContain(`\`${arrowAt}\` is sent`);
    expect(databendStatementRefusal(arrowAt)).toBeNull();
    expect(rowOf(sectionOf(DOC, "### 5.2 The statement guard"), "`SELECT 2<<@s--;SELECT 3 AS hidden`")).toBe(
      `| \`SELECT 2<<@s--;SELECT 3 AS hidden\` | ${DATABEND_STAGE_RUN_ON} |`,
    );
    expect(guard).toContain("a stage token, a `;` and a second statement to Databend");
    expect(flat(sectionOf(DOC, "### 5.6 EXPLAIN is the planning form only"))).toContain(
      "An `@` that ends a `<@` operator opens no stage name here either.",
    );
    // A name that itself holds a run hides nothing, yet is refused; the quoted location is the way through.
    const limits = flat(sectionOf(DOC, "## 13. Known limitations"));
    expect(limits).toContain(
      "as `@s[1]` and `@s/a--b.csv` do, is one stage name to Databend, which a space would cut short;",
    );
    expect(limits).toContain("`FROM '@s/a--b.csv'`, which Databend reads as the same stage location");
    expect(limits).toContain(
      "with `LIST` and `REMOVE`, which take only the bare name, name the stage alone and match the path with `PATTERN`.",
    );
    for (const name of ["@s[1]", "@s/a--b.csv"]) {
      expect(databendStatementRefusal(`SELECT $1 FROM ${name}`)).toBe(DATABEND_STAGE_RUN_ON);
      expect(databendStatementRefusal(`SELECT $1 FROM '${name}'`)).toBeNull();
    }
    expect(databendStatementRefusal("LIST @s PATTERN = '.*a--b[.]csv'")).toBeNull();
  });

  test("the skipped row's comment names a type by its outer name, as the writer builds it (R-SQL-2)", () => {
    const written = flat(sectionOf(DOC, "### 5.7 What the SQL INSERT export writes"));
    expect(written).toContain(
      "The comment names the type by its outer name, with `Nullable` unwrapped and its arguments dropped (`Map` for `Nullable(Map(String, Int32))`), cut at 64 characters,",
    );
    expect(written).not.toContain("as the server spelled it");
    const skipped = (type: string) =>
      buildResultExport("sql-insert", {
        rows: [{ c: "x" }],
        fields: ["c"],
        tabName: "users",
        dialect: "databend",
        columnTypes: { c: type },
      }).content;
    expect(skipped("Nullable(Map(String, Int32))")).toBe(
      '-- Row 1 skipped: column "c" holds a value of type Map, which databend has no literal for.',
    );
    expect(skipped("Array(Nullable(Int32))")).toContain("holds a value of type Array,");
    expect(skipped("X".repeat(100))).toContain(`holds a value of type ${"X".repeat(64)}...,`);
  });

  test("the bound-parameter refusal is the provider's", async () => {
    let message = "";
    try {
      await provider.query("SELECT 1", [1]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(DATABEND_PROVIDER_SENTENCES.params);
    expect(flat(sectionOf(DOC, "### 3.8 Literals, never bound parameters"))).toContain(`> ${message}`);
  });

  test("the grammar table is the Databend row, every field", () => {
    const grammar = sectionOf(DOC, "### 5.3 The Databend grammar");
    const row = resolveSqlGrammar("databend");
    const documented = grammar.split("\n").filter((line) => /^\| `\w+` \| `/.test(line));
    expect(documented.map((line) => line.split(" | ").slice(0, 2).join(" | "))).toEqual(
      Object.entries(row).map(
        ([key, value]) =>
          `| \`${key}\` | \`${JSON.stringify(value, (_key, inner: unknown) => (inner instanceof RegExp ? inner.source : inner))}\``,
      ),
    );
  });

  test("every bound the doc quotes is the number the code enforces", () => {
    const bounds = sectionOf(DOC, "### 3.10 Bounds, and what they were measured against");
    expect(DATABEND_RESPONSE_CAP_BYTES).toBe(16 * MIB);
    expect(rowOf(bounds, "One answer")).toContain(
      `${DATABEND_RESPONSE_CAP_BYTES / MIB} MiB (${n(DATABEND_RESPONSE_CAP_BYTES)} bytes)`,
    );
    expect(rowOf(bounds, "Answer text per statement")).toContain(
      `${DATABEND_STATEMENT_BYTES / MIB} MiB (${n(DATABEND_STATEMENT_BYTES)} bytes)`,
    );
    expect(rowOf(bounds, "Cells")).toContain(`${n(DATABEND_CELL_BUDGET)} cells`);
    expect(rowOf(bounds, "Rows")).toContain(`${n(MAX_UNLIMITED_ROWS)} rows`);
    expect(rowOf(bounds, "In flight")).toContain(
      `${DATABEND_LIMITER_OPTIONS.perProvider} statements per connection and ${DATABEND_LIMITER_OPTIONS.perEngine} per server type in this process, with a queue of ${DATABEND_LIMITER_OPTIONS.queueDepth}`,
    );
    expect(rowOf(bounds, "Sockets")).toContain(`${DATABEND_MAX_SOCKETS} per connection`);
    expect(rowOf(bounds, "Tree, connect and monitoring")).toContain(
      `${DATABEND_SURFACE_TIMEOUT_MS / 1000} seconds, or the query timeout when it is shorter`,
    );
    expect(rowOf(bounds, "Kill, final, ROLLBACK and logout")).toContain(
      `${DATABEND_CLOSE_TIMEOUT_MS / 1000} seconds each`,
    );
    expect(rowOf(bounds, "Monitoring lists")).toContain(
      `${DATABEND_DEFAULT_SESSION_LIMIT} sessions and ${DATABEND_DEFAULT_SLOW_QUERY_LIMIT} slow queries by default, at most ${DATABEND_MAX_MONITORING_LIMIT}`,
    );
    expect(rowOf(bounds, "Sign-in latch")).toContain(
      `${AUTH_LATCH_TTL_MS / 60_000} minutes per refused sign-in, at most ${AUTH_LATCH_MAX_ENTRIES} entries`,
    );
    expect(rowOf(bounds, "Server warnings")).toContain(
      `the first ${DATABEND_WARNING_LIMIT} different ones of a statement are shown`,
    );
  });

  test("the nesting bound the doc quotes is the depth past which an answer is refused before it is parsed", () => {
    const bounds = sectionOf(DOC, "### 3.10 Bounds, and what they were measured against");
    const depth = Number(/^\| Nesting of one answer \| (\d+) arrays and objects deep/m.exec(bounds)?.[1]);
    expect(depth).toBeGreaterThan(3);
    const nested = (arrays: number) =>
      readAnswer(
        {
          status: 200,
          contentType: "application/json",
          retryAfter: null,
          text: `{"id":"q","state":"Running","x":${"[".repeat(arrays)}${"]".repeat(arrays)}}`,
        },
        { rows: 1, columns: 1 },
      );
    // The answer's own object is the first level.
    expect(nested(depth - 1).kind).toBe("answer");
    expect(() => nested(depth)).toThrow(DATABEND_ERROR_SENTENCES.protocol(DATABEND_PROTOCOL_FAULTS.depth));
  });

  test("the statement request is what the transport sends: its headers, settings and paging", async () => {
    const request = sectionOf(DOC, "### 5.1 The request");
    const ids = idsOf(1);
    const harness = transportHarness([{ method: "POST", path: QUERY_PATH, reply: ok(ids) }]);
    await harness.transport.run(statement("SELECT 1", { origin: "provider", rowCut: MAX_UNLIMITED_ROWS }));
    const [sent] = harness.script.requests;
    const body = JSON.parse(sent.body ?? "{}") as {
      session: { settings: Record<string, string> };
      pagination: { wait_time_secs: number; max_rows_per_page: number; max_rows_in_buffer: number };
    };
    expect(rowOf(request, "`wait_time_secs`")).toBe(`| \`wait_time_secs\` | \`${body.pagination.wait_time_secs}\` |`);
    expect(rowOf(request, "`max_rows_per_page`")).toContain(`\`${n(body.pagination.max_rows_per_page)}\``);
    expect(body.pagination.max_rows_per_page).toBe(10_000);
    expect(body.pagination.max_rows_in_buffer).toBe(2 * body.pagination.max_rows_per_page);
    expect(rowOf(request, "`max_rows_in_buffer`")).toBe("| `max_rows_in_buffer` | twice `max_rows_per_page` |");
    expect(rowOf(request, "`max_rows_per_page`")).toContain("or the row cut plus one when that is smaller");
    const small = transportHarness([{ method: "POST", path: QUERY_PATH, reply: ok(ids) }]);
    await small.transport.run(statement("SELECT 1", { origin: "provider", rowCut: 99 }));
    const smallBody = JSON.parse(small.script.requests[0].body ?? "{}") as typeof body;
    expect(smallBody.pagination.max_rows_per_page).toBe(99 + 1);
    expect(smallBody.pagination.max_rows_in_buffer).toBe(2 * (99 + 1));
    const settings = Object.keys(body.session.settings);
    expect(settings).toHaveLength(7);
    for (const key of settings) expect(request).toContain(`\`${key}\``);
    expect(flat(request)).toContain("all seven of them");
    for (const name of DATABEND_REQUEST_HEADER_NAMES) expect(request).toContain(`\`${name}\``);
    for (const name of ["authorization", "user-agent", "x-databend-client-caps", "x-databend-warehouse"]) {
      expect(request).toContain(`\`${name}\``);
    }
    expect(request).toContain(`\`POST ${QUERY_PATH}\``);
    expect(request).toContain(`\`POST ${LOGOUT_PATH}\``);
  });

  test("the kill resends the doc quotes are the waits the transport takes", async () => {
    const ids = idsOf(1);
    const kill = { method: "GET" as const, path: pathsOf(ids.queryId).kill, reply: { status: 404 } };
    const { script, time, transport } = transportHarness([
      { method: "POST", path: QUERY_PATH, reply: { hang: true } },
      kill,
      kill,
      kill,
      kill,
      { method: "POST", path: LOGOUT_PATH, reply: { status: 200 } },
    ]);
    const run = runSignal();
    const running = transport.run(statement("SELECT 1", { signal: run.signal })).catch((error: unknown) => error);
    await script.received(1);
    run.cancel();
    expect(await running).toBeInstanceOf(DatabendError);
    script.expectDone();
    const waits = time.sleeps.map(n);
    expect(waits).toHaveLength(3);
    expect(flat(sectionOf(DOC, "### 5.8 Cancellation and deadlines"))).toContain(
      `a kill answered 404 is sent again at ${waits[0]}, ${waits[1]} and ${waits[2]} ms`,
    );
  });

  test("a kill a gateway refuses over HTTP 200 is no acknowledged cancel, as sections 3.5 and 5.8 say (REV-T-2)", async () => {
    expect(flat(sectionOf(DOC, "### 5.8 Cancellation and deadlines"))).toContain(
      "the run reads as cancelled only when the kill answered 200 with no gateway refusal in its body, or an answer reported code 1043",
    );
    expect(flat(sectionOf(DOC, "### 3.5 What a statement leaves open is closed"))).toContain(
      "A close's HTTP 200 acknowledges it unless its body is a gateway's refusal",
    );
    const ids = idsOf(1);
    const refused = { status: 200, body: { error: { kind: "AuthorizationFailed", message: "Authorization failed" } } };
    const { script, transport } = transportHarness([
      { method: "POST", path: QUERY_PATH, reply: { hang: true } },
      { method: "GET", path: pathsOf(ids.queryId).kill, reply: refused },
    ]);
    const run = runSignal();
    const running = transport.run(statement("SELECT 1", { signal: run.signal })).catch((error: unknown) => error);
    await script.received(1);
    run.cancel();
    expect(((await running) as DatabendError).category).toBe("outcome-unknown");
    script.expectDone();
  });

  test("Stop reports a cancel only for a run that ended cancelled, waiting at most what 5.8 names (GAP-SH-C8-1)", async () => {
    const cancellation = flat(sectionOf(DOC, "### 5.8 Cancellation and deadlines"));
    // The editor's titles for the cancel route's two answers.
    const editor = read("src/hooks/use-query-execution.ts");
    for (const title of ["Query Cancelled", "Cancel Not Confirmed"]) {
      expect(editor).toContain(`title: "${title}"`);
      expect(cancellation).toContain(`"${title}"`);
    }
    // A run stopped before its first answer whose kill never answers: the cancel asks for one deadline, its wait.
    const script = scriptedNodeTransport([
      {
        method: "POST",
        path: QUERY_PATH,
        reply: ok(idsOf(1), { schema: [{ name: "server_version", type: "String" }] }),
      },
      { method: "POST", path: QUERY_PATH, reply: ok(idsOf(2), { schema: [{ name: "auth_type", type: "String" }] }) },
      { method: "POST", path: QUERY_PATH, reply: { hang: true } },
      { method: "GET", path: pathsOf(idsOf(3).queryId).kill, reply: { hang: true } },
      { method: "POST", path: LOGOUT_PATH, reply: { status: 200 } },
    ]);
    const time = transportDeps(script);
    const subject = new DatabendProvider(CONNECTION, {}, time.deps);
    await subject.connect();
    const running = subject.query("SELECT 1", undefined, "doc-cancel").catch((error: unknown) => error);
    await script.received(3);
    const asked = time.deadlines.length;
    const cancelling = subject.cancelQuery("doc-cancel");
    const wait = time.deadlines[asked].ms;
    await script.received(4);
    expect(wait).toBe(3 * DATABEND_CLOSE_TIMEOUT_MS);
    expect(cancellation).toContain(
      `waits for the stopped run to end, at most ${wait / 1000} seconds, the ${DATABEND_CLOSE_TIMEOUT_MS / 1000} seconds each of the kill, ROLLBACK and logout it may still send`,
    );
    time.fire(wait);
    expect(await cancelling).toBe(false);
    time.fire(DATABEND_CLOSE_TIMEOUT_MS);
    expect(await running).toBeInstanceOf(Error);
    await subject.disconnect();
    script.expectDone();
  });

  test("the resuming sentence reaches a route as written and a timeout gets the route's own, as 4.4, 5.8 and 10 say (GAP-CL-1)", async () => {
    const ctx: DatabendFailureContext = {
      request: "get",
      origin: "provider",
      sql: "SELECT 1",
      warehouse: "[warehouse]",
      endpoint: { host: "localhost", port: DATABEND_DEFAULT_PORT },
      timeoutMs: 10_000,
      secretForms: [],
    };
    const resuming = createErrorResponse(
      toDatabaseError(stopError("deadline", { answered: true, killAcknowledged: true }, ctx), ctx),
    );
    expect(resuming.status).toBe(503);
    expect(((await resuming.json()) as { error: string }).error).toBe(
      DATABEND_ERROR_SENTENCES.resuming("[warehouse]", "10"),
    );
    const timeout = createErrorResponse(new TimeoutError(DATABEND_ERROR_SENTENCES.deadline("10"), "databend", 10_000));
    expect(timeout.status).toBe(408);
    const routeSentence = ((await timeout.json()) as { error: string }).error;
    const cloud = flat(sectionOf(DOC, "### 4.4 Databend Cloud: warehouse, cold start and billing"));
    expect(cloud).toContain(
      "It is a `ConnectionError`, which Studio's routes answer with HTTP 503 and the sentence itself, so the object tree, the monitoring page and Test Connection show it as written.",
    );
    const cancellation = flat(sectionOf(DOC, "### 5.8 Cancellation and deadlines"));
    expect(cancellation).toContain(`answer it with HTTP 408 and their own sentence, "${routeSentence}"`);
    expect(cancellation).toContain(
      "The resuming sentence of section 4.4 and the slot wait above are no statement's timeout: each is a `ConnectionError`, which Studio's routes answer with HTTP 503 and the sentence itself.",
    );
    expect(flat(sectionOf(DOC, "## 10. Error handling"))).toContain(
      "Studio's own read that outlasts its deadline on a named warehouse, and a statement that waited for a statement slot past its deadline, are `unavailable`",
    );
  });

  test("X27 keeps its measurement and says Databend's resuming warehouse is answered 503 now, which is not resent (GAP-CL-1)", () => {
    const x27 = flat(/^### X27\. [\s\S]*?(?=^---$)/m.exec(BACKLOG)?.[0] ?? "");
    expect(x27).toContain(
      "a first Databend Cloud connect that met a resuming warehouse was answered 408 twice before its third attempt passed.",
    );
    expect(x27).toContain(
      "Since #1593, Databend's resuming-warehouse case, Studio's own read that outlasts its deadline on a named warehouse, is answered with HTTP 503, which Chromium does not resend.",
    );
  });

  test("an in-body error's position is in Databend's own excerpt and on the error, never marked in the editor (SHC-2)", () => {
    const row = rowOf(sectionOf(DOC, "## 10. Error handling"), "An in-body error over HTTP 200") ?? "";
    expect(row).not.toContain("the editor marks the position");
    expect(row).toContain("the editor marks nothing");
    expect(row).toContain('the results panel shows it under "The query failed."');
    expect(read("src/components/studio/BottomPanel.tsx")).toContain("The query failed.");
    // The editor draws no marker for a query error: a marker added later changes this row.
    expect(read("src/components/QueryEditor.tsx")).not.toContain("setModelMarkers");
    const ctx: DatabendFailureContext = {
      request: "post",
      origin: "user",
      sql: "SELECT nope",
      endpoint: { host: "localhost", port: DATABEND_DEFAULT_PORT },
      timeoutMs: 60_000,
      secretForms: [],
    };
    const excerpt = "error: \n  --> SQL:1:8\n  |\n1 | SELECT nope\n  |        ^^^^ column nope doesn't exist";
    const failed = answerError({ id: "q", error: { code: 1065, message: excerpt, detail: null } }, ctx, null);
    expect(failed.position).toBe(8);
    expect(row).toContain(
      "the error carries it as `position`, the character it names counted from 1 (8 for `SELECT nope`), which the query route returns in its answer's `details`",
    );
  });

  test("the server-text cuts the doc quotes are the lengths errors.ts keeps", () => {
    const ctx: DatabendFailureContext = {
      request: "post",
      origin: "user",
      sql: "SELECT 1",
      endpoint: { host: "localhost", port: DATABEND_DEFAULT_PORT },
      timeoutMs: 60_000,
      secretForms: [],
    };
    const long = "x".repeat(5000);
    const refused = refusalError(
      { status: 400, contentType: "text/plain", code: 400, gatewayKind: null, text: long },
      ctx,
    );
    const refusalCut = /x+/.exec(refused.message)?.[0].length ?? 0;
    expect(refused.message).toBe(DATABEND_ERROR_SENTENCES.middlewareRefused(`${"x".repeat(refusalCut)}...`));
    const failed = answerError({ id: "q", error: { code: 1006, message: long, detail: null } }, ctx, null);
    const statementCut = /x+/.exec(failed.message)?.[0].length ?? 0;
    expect(failed.message).toBe(`${"x".repeat(statementCut)}...`);
    expect(flat(sectionOf(DOC, "## 10. Error handling"))).toContain(
      `${n(refusalCut)} characters of a refusal, ${n(statementCut)} of a statement error`,
    );
  });

  test("the health panel's counts are the limits getHealth reads with", async () => {
    const health = flat(sectionOf(DOC, "## 7. Monitoring & health"));
    const quoted = /Health: the overview, the (\d+) slowest queries and (\d+) sessions/.exec(health);
    expect(quoted).not.toBeNull();
    const sent: string[] = [];
    const runner: DatabendStatementRunner = async (sql) => {
      sent.push(sql);
      throw new DatabendError("statement", "unknown table", { code: 1025 });
    };
    await getHealth(runner);
    expect(sent).toContain(databendSlowQueriesSql(Number(quoted?.[1])));
    expect(sent).toContain(databendSessionsSql(Number(quoted?.[2])));
  });

  test("the retry schedule is what retryDecision answers", () => {
    const retries = flat(sectionOf(DOC, "### 3.6 Retries"));
    const steps = [1, 2, 3, 4, 5].map((attempt) =>
      retryDecision({
        request: "page",
        status: 503,
        gatewayKind: null,
        transportKind: null,
        attempt,
        msLeft: 600_000,
        retryAfter: null,
        random: 0.5,
        pageTimerRetried: false,
      }),
    );
    expect(steps.slice(0, 2)).toEqual([
      { retry: true, delayMs: 1000 },
      { retry: true, delayMs: 2000 },
    ]);
    expect(steps[2]).toEqual({ retry: false });
    const post = (attempt: number) =>
      retryDecision({
        request: "query",
        status: 200,
        gatewayKind: "ProvisionWarehouseTimeout",
        transportKind: null,
        attempt,
        msLeft: 600_000,
        retryAfter: null,
        random: 0.5,
        pageTimerRetried: false,
      });
    expect([1, 2, 3, 4, 5].map((attempt) => post(attempt))).toEqual(
      [1000, 2000, 4000, 8000, 8000].map((delayMs) => ({ retry: true, delayMs })),
    );
    expect(post(6)).toEqual({ retry: false });
    expect(
      retryDecision({
        request: "query",
        status: 503,
        gatewayKind: null,
        transportKind: null,
        attempt: 1,
        msLeft: 600_000,
        retryAfter: null,
        random: 0.5,
        pageTimerRetried: false,
      }),
    ).toEqual({ retry: false });
    expect(retries).toContain("1, 2, 4, 8 and 8 seconds, each 20 percent either way");
    expect(retries).toContain("at most six POST attempts and three GET attempts");
  });

  test("each EXPLAIN shape the doc says gets no plan gets none, and each it says plans does", () => {
    const explain = sectionOf(DOC, "### 5.6 EXPLAIN is the planning form only");
    const rows = explain.split("\n").filter((line) => /^\| `[^`]*` \| (Estimate|Explain|Both|Neither) \|/.test(line));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const [text, declined] = row.slice(2, -2).split(" | ");
      const sql = text.slice(1, -1);
      const plans = (mode: "estimate" | "analyze") => databendTextStrategy.buildSql(sql, mode) !== null;
      const expected = {
        Both: [false, false],
        Estimate: [false, true],
        Explain: [true, false],
        Neither: [true, true],
      }[declined] as [boolean, boolean];
      expect([plans("estimate"), plans("analyze")], sql).toEqual(expected);
    }
    const words = /The names that decline both modes, as a word or a quoted name, are ([^.]+)\./.exec(
      flat(explain),
    )?.[1];
    const listed = [...(words ?? "").matchAll(/`(\w+)`/g)].map((match) => match[1]);
    expect(listed).toHaveLength(13);
    for (const name of listed) {
      expect(databendTextStrategy.buildSql(`SELECT ${name.toLowerCase()}(1)`, "analyze"), name).toBeNull();
      expect(databendTextStrategy.buildSql(`SELECT 1 AS "${name.toLowerCase()}"`, "analyze"), name).toBeNull();
    }
    expect(capabilities.explainFormat).toBe("databend-text");
  });

  test("the Explain button says why it declines a SELECT, in the sentences 5.6 quotes, and clears the plan (CL-CORE-1)", () => {
    const explain = sectionOf(DOC, "### 5.6 EXPLAIN is the planning form only");
    const prose = flat(explain);
    expect(prose).toContain(
      "[word] being MATERIALIZED or PIVOT, [construct] a MATERIALIZED CTE or a PIVOT, and [name] the declined name in lower case; the automatic estimate declines without a word:",
    );
    expect(prose).toContain(
      "The first two name a word the statement holds anywhere in its code, a column or an alias included, not a construct Studio found.",
    );
    expect(prose).toContain(
      "The hint, form feed and tagged run sentences end with the advice below only when the statement with that one hint or form feed taken out, or that run quoted with `$$`, would get a plan; otherwise the sentence stands alone:",
    );
    expect(prose).toContain("after any decline the Explain tab shows no plan, never the plan of the statement before");
    // Every row the Explain button declines gets a reason, so none of them reads as "not a SELECT".
    const rows = explain.split("\n").filter((line) => /^\| `[^`]*` \| (Explain|Both) \|/.test(line));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const sql = row.slice(2, -2).split(" | ")[0].slice(1, -1);
      const reason = databendTextStrategy.declineReason?.(sql, "analyze") ?? null;
      if (sql.startsWith("INSERT")) expect(reason, sql).toBeNull();
      else expect(reason, sql).not.toBeNull();
    }
    expect(flat(sectionOf(DOC, "## 13. Known limitations"))).toContain(
      "EXPLAIN gives no plan for the shapes of section 5.6, and the Explain button says which reason declined it;",
    );
  });

  test("the capability and label tables are the provider's declarations and the records'", () => {
    const section = sectionOf(DOC, "## 9. Capabilities & labels");
    const declared: Readonly<Record<string, unknown>> = { ...capabilities };
    for (const key of [
      "queryLanguage",
      "defaultPort",
      "supportsExplain",
      "explainFormat",
      "supportsExternalQueryLimiting",
      "supportsResultPagination",
      "supportsCreateTable",
      "supportsInlineRowEdit",
      "supportsTestDataGeneration",
      "supportsTransactions",
      "declaresForeignKeys",
      "supportsMaintenance",
      "maintenanceOperations",
      "supportsConnectionString",
      "identifierQuoting",
      "containerPathShapes",
    ]) {
      expect(rowOf(section, `\`${key}\``), key).toBe(`| \`${key}\` | \`${JSON.stringify(declared[key])}\` |`);
    }
    expect(capabilities.resumesBilledCompute).toBeUndefined();
    expect(new DatabendProvider({ ...CONNECTION, warehouse: "wh" }).getCapabilities().resumesBilledCompute).toBe(true);
    expect(section).toContain("`resumesBilledCompute`");
    for (const [name, record] of [
      ["READ_ONLY_ENFORCED", READ_ONLY_ENFORCED],
      ["MCP_EXPOSABLE", MCP_EXPOSABLE],
      ["READS_FILE_ACCESS_POSTURE", READS_FILE_ACCESS_POSTURE],
      ["CONNECTION_STRING_ACCEPTED", CONNECTION_STRING_ACCEPTED],
    ] as const) {
      expect(rowOf(section, `\`${name}\``), name).toBe(`| \`${name}\` | \`${record.databend}\` |`);
    }
    const kinds = (capabilities.objectKinds ?? []).map((kind) => `\`${kind.id}\``);
    expect(kinds).toHaveLength(4);
    for (const kind of kinds) expect(section).toContain(kind);
    const labels: Readonly<Record<string, unknown>> = { ...DATABEND_LABELS };
    for (const key of [
      "entityName",
      "entityNamePlural",
      "rowName",
      "selectAction",
      "generateAction",
      "analyzeGlobalTitle",
      "vacuumGlobalTitle",
    ]) {
      expect(rowOf(section, `\`${key}\``), key).toBe(`| \`${key}\` | ${String(labels[key])} |`);
    }
    expect(DATABEND_KILL_SPEC.label).toBe("Kill Query");
    expect(sectionOf(DOC, "## 8. Maintenance")).toContain(`"${DATABEND_KILL_SPEC.label}"`);
  });

  test("section 9 says why Import Data has no target on Databend and quotes the dialog, and 13 lists it (D4)", () => {
    const section = flat(sectionOf(DOC, "## 9. Capabilities & labels"));
    // What the dialog reads from the declaration: no kind takes row writes, and no create-table.
    expect(capabilities.supportsCreateTable).toBe(false);
    expect((capabilities.objectKinds ?? []).some((kind) => kind.acceptsRowWrites === true)).toBe(false);
    expect(importRefusal(capabilities)).toBe(IMPORT_NO_TARGET);
    expect(section).toContain(
      "Import Data has no target on Databend: Studio draws the IMPORT control for every connection, and its dialog writes only into an existing object of a kind that declares `acceptsRowWrites`, which no Databend kind does (section 6.3), or into a table it creates, which `supportsCreateTable: false` withholds, so it offers only Close and says:",
    );
    expect(section).toContain(`> ${IMPORT_NO_TARGET}`);
    expect(section).toContain("Load rows with `INSERT` or `COPY INTO` in the editor instead.");
    expect(flat(sectionOf(DOC, "## 13. Known limitations"))).toContain(
      "Import Data has no target on Databend (section 9): load rows with `INSERT` or `COPY INTO` in the editor.",
    );
  });

  test("the session state the monitoring section names is the word the panels count (F8)", async () => {
    const monitoring = flat(sectionOf(DOC, "## 7. Monitoring & health"));
    expect(monitoring).toContain(
      'Its state is "active" while it runs a statement (`command` `Query`), the word the Active card and the Overview count, and "aborting" (`Aborting`) while a `KILL CONNECTION` or a server shutdown ends its session; the panel\'s own kill, a `KILL QUERY`, leaves it "active" until the statement stops.',
    );
    expect(monitoring).not.toContain("(query [query id])");
    const columns = ["session_id", "user_name", "host", "database_name", "command", "query_text"];
    const runner: DatabendStatementRunner = async (sql) => {
      expect(sql).toBe(databendSessionsSql(DATABEND_DEFAULT_SESSION_LIMIT));
      return {
        schema: columns.map((name) => ({ name, type: "String" })),
        rows: [
          ["s1", "u", "h", "d", "Query", "SELECT 1"],
          ["s2", "u", "h", "d", "Aborting", "SELECT 2"],
        ],
        truncated: null,
        notices: [],
        hasResultSet: true,
        affect: null,
      };
    };
    expect((await getActiveSessions(runner)).map((session) => session.state)).toEqual(["active", "aborting"]);
  });

  test("section 7 leaves Studio's own statements out by the query id Studio sent them under (CL-OPS-1)", async () => {
    const monitoring = flat(sectionOf(DOC, "## 7. Monitoring & health"));
    for (const sentence of [
      "Studio reads the panels at once, two statements at a time, so `system.processes` lists Studio's own statements beside the ones the panels are for: the reading one, a sibling panel's read, the object tree's.",
      "The Sessions panel and the active count leave out, by the query id it was sent under (`current_query_id`), every statement this Studio process wrote itself and had in flight while the read ran: a tree, describe, source, connect, monitoring or kill statement, from before its request until its last close ended.",
      "Studio generates each query id from a random UUID, so another client can neither predict one nor run a statement under one while Studio's runs: measured on the pinned image, a statement another user sent under a running statement's query id was refused with `query_id [query id] already exists`, and one the same user sent started nothing.",
      "Nothing is matched on statement text, so a user's statement is listed and counted whatever it says, the editor's statements included, and so is every statement of another Studio process, its monitoring reads included.",
      "The row's `id`, the kill target, is a session id Databend makes for each request, not the client session id Studio sends: measured on the pinned image and on v1.2.881, a running statement was listed under an `id` other than its client session id, and under its own query id as `current_query_id`.",
      `The Sessions panel asks Databend for ${DATABEND_LIMITER_OPTIONS.perEngine} rows past its limit, as many statements as Studio runs at once, so that leaving Studio's own out still fills it, and shows at most its limit.`,
      `The active count reads the query ids of the ${DATABEND_MAX_MONITORING_LIMIT} newest running statements beside Databend's count of them all, so the count is whole past ${DATABEND_MAX_MONITORING_LIMIT}, and leaves Studio's own out only among those ${DATABEND_MAX_MONITORING_LIMIT}.`,
    ]) {
      expect(monitoring).toContain(sentence);
    }
    const sessions = databendSessionsSql(DATABEND_DEFAULT_SESSION_LIMIT);
    expect(sessions).toContain("current_query_id AS query_id");
    expect(sessions.endsWith(` LIMIT ${DATABEND_DEFAULT_SESSION_LIMIT + DATABEND_LIMITER_OPTIONS.perEngine}`)).toBe(
      true,
    );
    const sent: string[] = [];
    await getOverview(async (sql) => {
      sent.push(sql);
      return { schema: [], rows: [], truncated: null, notices: [], hasResultSet: true, affect: null };
    });
    const count = sent.find((sql) => sql.includes("system.processes")) ?? "";
    expect(count).toContain("SELECT current_query_id AS query_id, count(*) OVER () AS running ");
    expect(count.endsWith(` ORDER BY created_time DESC LIMIT ${DATABEND_MAX_MONITORING_LIMIT}`)).toBe(true);
    // The reading row is left out by its query id, as every statement of Studio's own is, not by `connection_id()`.
    expect(monitoring).not.toContain("connection_id()");
    expect(flat(sectionOf(DOC, "## 13. Known limitations"))).toContain(
      `Studio's own monitoring reads are left out only by the Studio process that sent them, so another Studio process's reads show among the running statements; past ${DATABEND_MAX_MONITORING_LIMIT} running statements, the active count leaves Studio's own out only among the ${DATABEND_MAX_MONITORING_LIMIT} newest.`,
    );
  });

  test("the degrading codes the monitoring section names are the ones introspect.ts reads", () => {
    const monitoring = flat(sectionOf(DOC, "## 7. Monitoring & health"));
    const named = /Databend answers one of the codes (.+?) \(/.exec(monitoring)?.[1] ?? "";
    const codes = [...named.matchAll(/\d{4}/g)].map((match) => Number(match[0]));
    expect(codes.sort()).toEqual([...DATABEND_DEGRADE_CODES].sort());
  });

  test("the seed recipe is a seed the loader takes", () => {
    const usage = sectionOf(DOC, "### 12.3 A seed connection");
    const recipe = /```yaml\n([\s\S]*?)```/.exec(usage)?.[1] ?? "";
    const [seed] = parseYAML(recipe.replace(/\$\{\w+\}/g, "filled")) as unknown[];
    const parsed = SeedConnectionSchema.safeParse(seed);
    expect(parsed.error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) ?? []).toEqual([]);
    expect(recipe).toContain("warehouse:");
    expect(usage).toContain("[SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md)");
  });

  test("every curl example reads the password from DATABEND_PASSWORD and the doc carries no fixture password", () => {
    const curls = DOC.split("\n").filter((line) => /\bcurl\b/.test(line) && line.includes(" -u "));
    expect(curls.length).toBeGreaterThan(0);
    for (const line of curls) expect(line).toContain('"$DATABEND_USER:$DATABEND_PASSWORD"');
    expect(DOC).not.toContain("Probe123pass!");
    expect(DOC).not.toContain("Reader123pass!");
  });

  test("every backlog id the doc cites is an entry of docs/BACKLOG.md", () => {
    const cited = [...new Set([...DOC.matchAll(/\[([BDUS]\d{1,3})\]\(\.\.\/BACKLOG\.md\)/g)].map((match) => match[1]))];
    for (const id of ["D246", "D247", "D248", "D249", "D250", "D252", "U97", "U98", "B103", "S2"]) {
      expect(cited).toContain(id);
    }
    for (const id of cited) expect(BACKLOG).toMatch(new RegExp(`^### ${id}\\. `, "m"));
  });

  test("the known limitations keep each stated limit", () => {
    const limits = flat(sectionOf(DOC, "## 13. Known limitations"));
    for (const fragment of [
      "A dollar-quoted run tagged other than `$$`",
      "A form feed",
      "A stage name (`@...`) holding a backslash",
      "An optimizer hint",
      "a quote other than a plain single-quoted value",
      "A temporary table and a transaction end with their statement",
      "`SET VARIABLE`",
      "`SET ROLE`",
      "may have run",
      "no HTTP proxy",
      "AI and MCP",
      "stages and `COPY`",
      "`_mv_source_row_id`",
      "a view that no longer plans",
      "Studio's own monitoring reads",
      "16 MiB",
      "when its page is large",
      RESULT_MODE_FLOOR,
      "the Sessions panel",
      "`IDENTIFIED BY`",
      "`login_history`",
      "plain HTTP",
      "transformed",
      "server's global time zone",
      "`Timestamp_Tz`",
      "path prefix",
      "default catalog",
      "skipped by name",
      "the session's current statement",
      "verified locally",
      "several replicas",
      "its first 100 different server warnings",
      "no query id for a running statement",
      "from 2^53 up are the nearest number",
    ]) {
      expect(limits, fragment).toContain(fragment);
    }
  });

  test("the object edit section the edit census asks of an abstainer is there", () => {
    expect(DOC).toMatch(/^#{1,6} .*Object edit \(#789\)/m);
  });

  test("the doc carries no em dash and no en dash", () => {
    expect(DOC).not.toMatch(/[–—]/);
  });
});
