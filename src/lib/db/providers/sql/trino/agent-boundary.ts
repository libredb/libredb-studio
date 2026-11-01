/**
 * The agent read-only execution profile's boundary on Trino: the proof that the read-only access control is in force,
 * refusing every identity every catalog's table functions and catalog management, sent at the open of a connection
 * that will send statements and again before every agent statement, and the fence every agent statement passes before
 * it is sent.
 *
 * The boundary is the operator's access control, proved by the server's own answers. Measured on Trino 476
 * (`tests/fixtures/trino/476/agent-boundary/`), `START TRANSACTION READ ONLY` refuses Trino's own writes, but a
 * pass-through table function, `TABLE(<catalog>.system.query(query => ...))`, sends its text to the catalog's source,
 * where it runs under the catalog's own credential: through PostgreSQL's dblink it wrote a row inside the read-only
 * transaction, on both PostgreSQL catalogs, under the default access control and under file rules granting the
 * function (capture 02). Under `access-control.name=read-only` every such call is refused with PERMISSION_DENIED on
 * every catalog, as are `CALL system.execute` and catalog creation and removal, and the PostgreSQL table is unchanged
 * (capture 02). The read-only access control lets only the builtin functions run, for every identity and whether a
 * catalog lists the function or not, so it covers a catalog added later; no catalog or server switch disables table
 * functions.
 *
 * The proof (`proveTrinoAgentBoundary`) first asks for a table procedure no connector registers on
 * `system.runtime.nodes`. The read-only access control refuses every table procedure to every identity before the
 * lookup, with PERMISSION_DENIED; the default and file-based access control never refuse one, so the lookup answers
 * PROCEDURE_NOT_FOUND (capture 05). Only the read-only refusal, word for word, is admitted, alone or beside other access
 * controls. This is what proves a table function the server does not list refused too: a call is looked up before its
 * permission is checked, so a name that does not resolve answers FUNCTION_NOT_FOUND under every access control (capture
 * 04), and no call can prove the listing whole. Then it asks, as this connection's user, for its catalogs (`SHOW
 * CATALOGS`) and each catalog's functions (`SHOW FUNCTIONS FROM <catalog>.system`, whose table functions carry the
 * function type `table`), and calls every table function each catalog lists, and the known pass-through names
 * (`query`, `raw_query`) on every catalog, with an argument name no function declares. The permission check comes
 * before the argument check, so the call runs nothing either way: a function the user may not call answers
 * PERMISSION_DENIED, one it may call answers an argument error (capture 01). Each must answer PERMISSION_DENIED;
 * FUNCTION_NOT_FOUND is accepted only for a known pass-through name the catalog does not list. Then it removes a
 * catalog whose name carries a fresh random suffix, which no one holds, and catalog management must be refused:
 * PERMISSION_DENIED, where a server that lets the user manage catalogs looks the name up and answers CATALOG_NOT_FOUND
 * (capture 01). Catalog creation is not probed, since where it is allowed the probe would create one; the read-only
 * access control refuses it (capture 02). Any other answer refuses the profile, and a failure to reach the server
 * leaves as it came.
 *
 * Every statement of the proof runs inside a read-only transaction of its own, which the caller rolls back: a refused
 * statement aborts the transaction it ran in (capture 03), so the probes cannot share one.
 */
import { ExecutionProfileError } from "../../../errors";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { hasLoneCarriageReturnInLineComment, readSqlSpan } from "@/lib/sql/spans";
import { type TrinoQueryResult, TrinoTransportError } from "./transport";

/** Runs one statement inside a read-only transaction of its own and answers its result, or throws its refusal. */
export type TrinoProofRun = (sql: string) => Promise<TrinoQueryResult>;

/**
 * The probe of the access control in force: a table procedure no connector registers, on a table every server has.
 * The read-only access control refuses every identity every table procedure before the procedure is looked up; the
 * default and file-based access control never refuse one, so the lookup answers PROCEDURE_NOT_FOUND (capture 05).
 * Either way nothing runs.
 */
export const TRINO_ACCESS_CONTROL_PROBE = 'ALTER TABLE "system"."runtime"."nodes" EXECUTE libredb_no_such_procedure';

/** The read-only access control's answer to the probe, word for word (capture 05, read-only and read-only-file). */
const READ_ONLY_REFUSAL =
  "Access Denied: Cannot execute table procedure LIBREDB_NO_SUCH_PROCEDURE on system.runtime.nodes";

/** The catalogs this user can see. */
export const TRINO_CATALOG_LIST_STATEMENT = "SHOW CATALOGS";

/** The column `SHOW CATALOGS` answers the names in (capture 00). */
const CATALOG_COLUMN = "Catalog";

/** The columns of `SHOW FUNCTIONS` that name a function and its type (capture 00). */
const FUNCTION_COLUMN = "Function";
const FUNCTION_TYPE_COLUMN = "Function Type";

/** The function type a table function carries. */
const TABLE_FUNCTION_TYPE = "table";

/**
 * The names under which connectors register a pass-through table function, called on every catalog whether it lists
 * them or not: `query` (the JDBC connectors and others) and `raw_query` (Elasticsearch).
 */
const PASS_THROUGH_NAMES: readonly string[] = ["query", "raw_query"];

/** The argument name the probe calls with: no table function declares it, so analysis stops before anything runs. */
const NO_SUCH_ARGUMENT = "libredb_no_such_argument";

const PERMISSION_DENIED = "PERMISSION_DENIED";
const FUNCTION_NOT_FOUND = "FUNCTION_NOT_FOUND";
const PROCEDURE_NOT_FOUND = "PROCEDURE_NOT_FOUND";

/** The answers a table function the user may call gives the probe: its arguments, not its permission, were refused. */
const ARGUMENT_REFUSALS: ReadonlySet<string> = new Set(["INVALID_FUNCTION_ARGUMENT", "MISSING_ARGUMENT"]);

/** What every refusal of the check starts with, naming the operator settings that pass it. */
const NEEDS =
  "The agent read-only execution profile needs a Trino server whose access control refuses every identity the functions of every catalog and catalog management: set access-control.name=read-only, alone or beside other access controls";

/** What every refusal of the check ends with: the probes run nothing, whatever the server answered. */
const RAN_NOTHING = "The check ran nothing.";

/** A name as Trino quotes one: in double quotes, a double quote doubled. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** One catalog's function list. */
export function trinoFunctionListStatement(catalog: string): string {
  return `SHOW FUNCTIONS FROM ${quoted(catalog)}."system"`;
}

/** The probe of a table function: a call with an argument name no function declares. */
export function trinoTableFunctionProbe(catalog: string, name: string): string {
  return `SELECT * FROM TABLE(${quoted(catalog)}."system".${quoted(name)}(${NO_SUCH_ARGUMENT} => 1))`;
}

/** The probe of catalog management: the removal of a catalog whose name carries a fresh suffix, which no one holds. */
export function trinoCatalogManagementProbe(nonce: string): string {
  return `DROP CATALOG ${quoted(`libredb_agent_probe_${nonce}`)}`;
}

/** The catalog names of a `SHOW CATALOGS` answer, or null when it cannot be read as one. */
export function readTrinoCatalogs(result: TrinoQueryResult): string[] | null {
  if (result.fieldNames?.length !== 1 || result.fieldNames[0] !== CATALOG_COLUMN) return null;
  const names = result.rows.map((row) => row[CATALOG_COLUMN]);
  return names.every((name): name is string => typeof name === "string") ? names : null;
}

/** The names of the table functions a `SHOW FUNCTIONS` answer lists, once each, or null when it cannot be read. */
function readTableFunctions(result: TrinoQueryResult): string[] | null {
  const fields = result.fieldNames ?? [];
  if (!fields.includes(FUNCTION_COLUMN) || !fields.includes(FUNCTION_TYPE_COLUMN)) return null;
  const names = new Set<string>();
  for (const row of result.rows) {
    const name = row[FUNCTION_COLUMN];
    const type = row[FUNCTION_TYPE_COLUMN];
    if (typeof name !== "string" || typeof type !== "string") return null;
    if (type === TABLE_FUNCTION_TYPE) names.add(name);
  }
  return [...names];
}

/** A refusal the server answered to a statement, with its fault name, or null for any other failure. */
function serverAnswer(error: unknown): (TrinoTransportError & { code: string }) | null {
  return error instanceof TrinoTransportError && error.code !== null
    ? (error as TrinoTransportError & { code: string })
    : null;
}

function refuse(reason: string, code: "PROFILE_SERVER_UNENFORCED" | "PROFILE_UNSUPPORTED_TARGET"): never {
  throw new ExecutionProfileError(`${NEEDS}. ${reason} ${RAN_NOTHING}`, code);
}

/** `CODE ("message")`, the server's refusal as a refusal sentence quotes it. */
function quotedAnswer(answer: TrinoTransportError & { code: string }): string {
  return `${answer.code} (${JSON.stringify(answer.message)})`;
}

/** Runs `sql` and answers its result; a refusal of the server's is handed to `refused`, any other failure leaves. */
async function ask(
  run: TrinoProofRun,
  sql: string,
  refused: (answer: TrinoTransportError & { code: string }) => never,
): Promise<TrinoQueryResult> {
  try {
    return await run(sql);
  } catch (error) {
    const answer = serverAnswer(error);
    if (answer === null) throw error;
    return refused(answer);
  }
}

/** The check of a table function: it must be refused by permission, or be a known name the catalog does not have. */
async function proveFunction(run: TrinoProofRun, catalog: string, name: string, listed: boolean): Promise<void> {
  const which = `the table function ${catalog}.system.${name}`;
  try {
    await run(trinoTableFunctionProbe(catalog, name));
  } catch (error) {
    const answer = serverAnswer(error);
    if (answer === null) throw error;
    if (answer.code === PERMISSION_DENIED) return;
    if (answer.code === FUNCTION_NOT_FOUND && !listed) return;
    if (!ARGUMENT_REFUSALS.has(answer.code)) {
      refuse(
        `This server answered the check of ${which} with ${quotedAnswer(answer)}, which is not a permission refusal, so whether it refuses the function is unmeasured and the connection is refused.`,
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }
  }
  refuse(
    `This server lets it call ${which}, which can send its text to the catalog's source under the catalog's own credential, so the connection is refused.`,
    "PROFILE_SERVER_UNENFORCED",
  );
}

/** The check of the access control in force: the table procedure probe must meet the read-only access control's refusal. */
async function proveReadOnlyAccessControl(run: TrinoProofRun): Promise<void> {
  const what = "ALTER TABLE ... EXECUTE of a table procedure no connector registers";
  try {
    await run(TRINO_ACCESS_CONTROL_PROBE);
  } catch (error) {
    const answer = serverAnswer(error);
    if (answer === null) throw error;
    if (answer.code === PERMISSION_DENIED && answer.message === READ_ONLY_REFUSAL) return;
    if (answer.code === PROCEDURE_NOT_FOUND) {
      refuse(
        `This server looked up a table procedure no connector registers, answering ${quotedAnswer(answer)}, where the read-only access control refuses the call first, so the read-only access control is not in force: a table function the server does not list, which a lookup finds before any permission check, could run. The connection is refused.`,
        "PROFILE_SERVER_UNENFORCED",
      );
    }
    refuse(
      `This server answered ${what} with ${quotedAnswer(answer)}, which is not the read-only access control's refusal, so the access control in force is unmeasured and the connection is refused.`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  refuse(
    `This server ran ${what}, so the access control in force is unmeasured and the connection is refused.`,
    "PROFILE_UNSUPPORTED_TARGET",
  );
}

/** The check of catalog management: removing a catalog no one holds must be refused by permission. */
async function proveCatalogManagement(run: TrinoProofRun, nonce: string): Promise<void> {
  const what = "DROP CATALOG of a catalog that does not exist";
  try {
    await run(trinoCatalogManagementProbe(nonce));
  } catch (error) {
    const answer = serverAnswer(error);
    if (answer === null) throw error;
    if (answer.code === PERMISSION_DENIED) return;
    refuse(
      `This server answered ${what} with ${quotedAnswer(answer)} rather than a permission refusal, so catalog management is not refused and the connection is refused.`,
      "PROFILE_SERVER_UNENFORCED",
    );
  }
  refuse(
    `This server ran ${what}, so catalog management is not refused and the connection is refused.`,
    "PROFILE_SERVER_UNENFORCED",
  );
}

/**
 * The proof that the read-only access control is in force and refuses every catalog's table functions and catalog
 * management. `run` sends each statement inside a read-only transaction of its own. Resolves with the catalogs it
 * proved, in the server's order; refuses the profile on any other answer.
 */
export async function proveTrinoAgentBoundary(run: TrinoProofRun, nonce: string): Promise<string[]> {
  await proveReadOnlyAccessControl(run);
  const listed = await ask(run, TRINO_CATALOG_LIST_STATEMENT, (answer) =>
    refuse(
      `This server refused ${TRINO_CATALOG_LIST_STATEMENT} with ${quotedAnswer(answer)}, so its catalogs cannot be checked and the connection is refused.`,
      "PROFILE_UNSUPPORTED_TARGET",
    ),
  );
  const catalogs = readTrinoCatalogs(listed);
  if (catalogs === null) {
    refuse(
      `This server's answer to ${TRINO_CATALOG_LIST_STATEMENT} could not be read as a list of catalog names, so the connection is refused.`,
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }

  for (const catalog of catalogs) {
    const statement = trinoFunctionListStatement(catalog);
    const functions = readTableFunctions(
      await ask(run, statement, (answer) =>
        refuse(
          `This server refused ${statement} with ${quotedAnswer(answer)}, so the table functions of catalog ${catalog} cannot be checked and the connection is refused.`,
          "PROFILE_UNSUPPORTED_TARGET",
        ),
      ),
    );
    if (functions === null) {
      refuse(
        `This server's answer to ${statement} could not be read as a list of functions and their types, so the connection is refused.`,
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }
    for (const name of functions) await proveFunction(run, catalog, name, true);
    for (const name of PASS_THROUGH_NAMES) {
      if (!functions.includes(name)) await proveFunction(run, catalog, name, false);
    }
  }

  await proveCatalogManagement(run, nonce);
  return catalogs;
}

/** What every fence refusal starts with. */
const FENCE =
  "The agent read-only execution profile sends one Trino statement, a SELECT (a WITH before it is fine), and nothing else";

/** The statement's first keyword, read from its first code character, case aside and not a longer word. */
const FIRST_KEYWORD = /^(?:select|with)(?![\w$@:])/i;

/**
 * The fence in front of every agent statement: `null` when `sql` is one statement whose first keyword is SELECT or
 * WITH, else the reason it is refused, before anything is sent. Every agent statement runs inside a read-only
 * transaction Studio opens and rolls back; a COMMIT, ROLLBACK or START TRANSACTION written inside it would end or nest
 * it (capture 03), a SET SESSION or USE would change the session, and CALL, EXECUTE and PREPARE run what the text does
 * not show, so only a SELECT is sent.
 *
 * The text is walked with the shared span reader under Trino's registered grammar row (`sql-grammar.ts`), so `--` and
 * block comments and whitespace are skipped, string literals and double-quoted names are opaque, and `#` and `//` are
 * code, as Trino reads them. The first code character must open SELECT or WITH; a code semicolon ends the statement,
 * and only comments and whitespace may follow it. Text that ends inside a comment, string or quoted name cannot be
 * bounded and is refused. A carriage return inside a `--` comment with more text after it is refused, since readers
 * differ on whether it ends the comment, and so is a `$$` run, which the span reader reads as a string and Trino does
 * not.
 */
export function trinoAgentStatementRefusal(sql: string): string | null {
  const grammar = resolveSqlGrammar("trino");
  if (hasLoneCarriageReturnInLineComment(sql, grammar)) {
    return `${FENCE}; this text holds a carriage return inside a -- comment with more text after it, which a reader may end the comment at or not, so where the statement ends cannot be read, and it was not sent. End a comment with a line feed.`;
  }
  let opened = false;
  let ended = false;
  for (let at = 0; at < sql.length; ) {
    const span = readSqlSpan(sql, at, grammar);
    if (span !== null && span.kind !== "subscript") {
      if (!span.terminated) {
        return `${FENCE}; this text ends inside a comment, a string or a quoted name, so where it ends cannot be read, and it was not sent.`;
      }
      const trivia = span.kind === "whitespace" || span.kind === "line-comment" || span.kind === "block-comment";
      if (!trivia) {
        if (span.kind === "dollar-string") {
          return `${FENCE}; this text holds a dollar-quoted run ($$ ... $$), which Trino does not read as a string, so where its statement ends cannot be read, and it was not sent.`;
        }
        if (!opened) return notSelect();
        if (ended) return goesOn();
      }
      at = span.end;
      continue;
    }
    if (ended) return goesOn();
    if (!opened) {
      if (!FIRST_KEYWORD.test(sql.slice(at, at + 7))) return notSelect();
      opened = true;
    }
    if (sql[at] === ";") ended = true;
    at++;
  }
  return opened ? null : `${FENCE}; this text holds no statement, so nothing was sent.`;
}

function notSelect(): string {
  return `${FENCE}; this statement does not begin with SELECT or WITH, so it was not sent. A statement that ends, nests or leaves the read-only transaction, changes the session or calls a procedure is never sent, so only a SELECT reaches the server.`;
}

function goesOn(): string {
  return `${FENCE}; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.`;
}
