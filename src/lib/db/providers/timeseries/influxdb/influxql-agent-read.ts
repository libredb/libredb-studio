/**
 * The `influxdb` agent read-only execution profile's own rules: the proof that the connection's principal reads only,
 * the response cap taken from the byte budget, the strict shaping of an answer, and the budget refusals a failed
 * request becomes.
 *
 * The boundary is the principal. The v1 `/query` route runs any statement the principal may run, so the profile
 * opens only for a principal the server itself refuses every write, proved from the server's own answers before the
 * open and again before every agent statement, on the requests that statement's call sends, with no verdict kept
 * between them. Measured on 1.13.1 and 2.9.1 (tests/fixtures/influxdb/<version>/agent-boundary/), in this order:
 *
 * 1. **A line where a principal can be proved.** `GENERATION_TRAITS[generation].agentPrincipal`: a 1.x user or a 2.x
 *    token. InfluxDB 3 is refused, since Core mints only admin tokens and its own SQL path is the measured one, and so
 *    is a server that names no version.
 * 2. **Not an administrator.** On 1.x, `SHOW USERS` must be refused as needing the admin privilege
 *    (`admin-read-reader`); an admin is answered (`admin-read-admin`), and so is anyone on a server with
 *    authentication off (`admin-read-auth-off`). 2.x answers `SHOW USERS` "not implemented" to every token, the
 *    operator's included (`admin-read-operator`), so there the administrator is told by the listing: only the operator
 *    and all-access tokens list the system buckets `_monitoring` and `_tasks` (`listing-operator`).
 * 3. **No write anywhere it can reach.** `SHOW DATABASES` lists every database the principal holds any privilege on, a
 *    1.x WRITE-only grant included (`listing-rw`), and each is sent a no-op write: a DELETE from a measurement named
 *    for this probe alone, before 1970. A reader is refused it (`write-probe-reader-home`, 403 "requires WRITE on";
 *    `write-probe-ro-home`, "insufficient permissions"); a principal that can write is answered it, and deletes nothing.
 *    This is what stops `SELECT ... INTO`: 1.13.1 writes into a second database where a principal that reads only the
 *    bound one holds WRITE (`into-second-rw`, written 2), and refuses a principal with no write there
 *    (`into-second-reader`). 2.9.1 refuses `SELECT ... INTO` to every token, and a token's write on a bucket it cannot
 *    read is out of InfluxQL's reach (`write-probe-rwother-other`, "no dbrp mappings found").
 *
 * The connection's own database must be one the listing names, and a principal listing more than
 * `INFLUXQL_AGENT_PROBED_DATABASES` databases is refused, so a statement's probes stay bounded. Every answer is matched
 * on the measured status and wording; anything else refuses the profile, and a failure to reach the server leaves as
 * it came. A grant widened between the proof and the statement it precedes is a window of one statement: the next
 * statement's proof sees it.
 *
 * Budgets refuse rather than truncate: the request's response cap comes from the byte budget, and a result past the
 * row budget, the cell budget or the byte budget throws the shared sentence of `read-only-budget.ts`.
 */
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  assertReadOnlyBudget,
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import type { QueryWarning } from "@/lib/types";
import type { InfluxAnswer, InfluxRequest } from "./client";
import { INFLUX_CELL_BUDGET } from "./connection-options";
import { shapeInfluxqlBody } from "./influxql-results";
import type { InfluxqlRouteId } from "./routes";
import { GENERATION_TRAITS, type InfluxGeneration } from "./versions";

/** The most databases a principal may list: each is sent its own probe before every agent statement. */
export const INFLUXQL_AGENT_PROBED_DATABASES = 32;

/** InfluxDB 2.x's own buckets, listed only to an operator or all-access token (`listing-operator`). */
const SYSTEM_BUCKETS: ReadonlySet<string> = new Set(["_monitoring", "_tasks"]);

/** What the proof is given: the provider's limited send, the call's deadline, and what the connection says. */
export interface InfluxqlAgentProofContext {
  readonly send: (request: InfluxRequest<InfluxqlRouteId>, signal: AbortSignal) => Promise<InfluxAnswer>;
  readonly signal: AbortSignal;
  readonly generation: InfluxGeneration;
  /** The connection's database: the one every agent statement is sent with. */
  readonly database: string | undefined;
  /** Whether the connection sends a credential at all. */
  readonly hasUser: boolean;
  /** Lower-case hex, fresh for each proof, so the probe's measurement is one no one wrote. */
  readonly nonce: string;
}

const NOTHING_ELSE = "Nothing else was sent.";

/** The no-op write: a DELETE from a measurement named for this probe alone, of points before 1970. */
export function writeProbeStatement(nonce: string): string {
  if (!/^[0-9a-f]+$/.test(nonce)) throw new Error("The write probe's nonce must be lower-case hex.");
  return `DELETE FROM "libredb_agent_probe_${nonce}" WHERE time < 0`;
}

function tooBroad(message: string): ExecutionProfileError {
  return new ExecutionProfileError(message, "PROFILE_PRIVILEGES_TOO_BROAD");
}

function unreadable(label: string, read: string): ExecutionProfileError {
  return new ExecutionProfileError(
    `The agent read-only profile could not read ${label}'s answer to ${read}, so this principal is not proved read-only and is refused. ${NOTHING_ELSE}`,
    "PROFILE_UNSUPPORTED_TARGET",
  );
}

/** A body as JSON, or undefined when it is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A 1.x authorization refusal whose reason is exactly `requirement` (`{"error":"error authorizing query: ..."}`). */
function isAuthorizationRefusal(answer: InfluxAnswer, requirement: string): boolean {
  if (answer.status !== 403) return false;
  const body = parsed(answer.text) as { error?: unknown } | undefined;
  const error = body?.error;
  return (
    typeof error === "string" && error.startsWith("error authorizing query: ") && error.endsWith(`, ${requirement}`)
  );
}

/** A 200 whose one result carries the error `wording` and nothing else. */
function isStatementRefusal(answer: InfluxAnswer, wording: string): boolean {
  if (answer.status !== 200) return false;
  const results = (parsed(answer.text) as { results?: unknown } | undefined)?.results;
  return (
    Array.isArray(results) && results.length === 1 && (results[0] as { error?: unknown } | null)?.error === wording
  );
}

/** A 200 that carries no error anywhere: the statement ran (`{}` on 2.x, an empty result on 1.x). */
function ran(answer: InfluxAnswer): boolean {
  if (answer.status !== 200) return false;
  const body = parsed(answer.text) as { error?: unknown; results?: unknown } | undefined;
  if (body === undefined || body === null || typeof body !== "object" || "error" in body) return false;
  const results = body.results ?? [];
  return (
    Array.isArray(results) &&
    results.every((result: unknown) => typeof result === "object" && result !== null && !("error" in result))
  );
}

/** The names `SHOW DATABASES` lists, or undefined when the answer is not a listing. */
function listedNames(answer: InfluxAnswer): readonly string[] | undefined {
  if (answer.status !== 200) return undefined;
  try {
    const shaped = shapeInfluxqlBody(
      answer.text,
      { rowCut: INFLUXQL_AGENT_PROBED_DATABASES + 1, cellBudget: INFLUX_CELL_BUDGET },
      [],
    );
    const names = shaped.rows.map((row) => row.name);
    return names.every((name): name is string => typeof name === "string") ? names : undefined;
  } catch {
    return undefined;
  }
}

/** Proves the principal reads only, from the server's own answers; throws the refusal, never a verdict to keep. */
export async function proveInfluxqlAgentPrincipal(context: InfluxqlAgentProofContext): Promise<void> {
  const traits = GENERATION_TRAITS[context.generation];
  const { label } = traits;
  if (traits.agentPrincipal === "refused") {
    throw new ExecutionProfileError(
      context.generation === "v3"
        ? "The agent read-only profile reads InfluxQL on InfluxDB 1.x and 2.x, where a principal can be proved read-only, and this server is InfluxDB 3: connect it as InfluxDB 3 (SQL), whose agent path is measured on its own."
        : "The agent read-only profile reads InfluxQL on InfluxDB 1.x and 2.x, where a principal can be proved read-only, and this server names no version Studio can place, so it is refused.",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  const { database } = context;
  if (database === undefined || database === "") {
    throw new ExecutionProfileError(
      "The agent read-only profile reads the connection's database, and this connection names none: set Database on the connection.",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  const send = (values: Readonly<Record<string, string>>) =>
    context.send({ route: "query-unchunked", values }, context.signal);

  if (traits.agentPrincipal === "user") {
    const users = await send({ q: "SHOW USERS" });
    if (ran(users)) {
      throw context.hasUser
        ? tooBroad(
            `The agent read-only profile needs a principal that is not an administrator, and ${label} answered this one SHOW USERS. Use a user granted READ only. ${NOTHING_ELSE}`,
          )
        : new ExecutionProfileError(
            `The agent read-only profile needs a server that checks who asks, and ${label} answered SHOW USERS to a connection with no credential: its authentication is off. Turn on [http] auth-enabled and connect as a user granted READ only. ${NOTHING_ELSE}`,
            "PROFILE_SERVER_UNENFORCED",
          );
    }
    if (!isAuthorizationRefusal(users, "requires admin privilege")) throw unreadable(label, "SHOW USERS");
  }

  const names = listedNames(await send({ q: "SHOW DATABASES" }));
  if (names === undefined) throw unreadable(label, "SHOW DATABASES");
  if (names.length > INFLUXQL_AGENT_PROBED_DATABASES) {
    throw tooBroad(
      `The agent read-only profile proves a principal read-only on every database it lists, at most ${INFLUXQL_AGENT_PROBED_DATABASES}, and ${label} lists more for this one: scope it to fewer databases. ${NOTHING_ELSE}`,
    );
  }
  if (traits.agentPrincipal === "token" && names.some((name) => SYSTEM_BUCKETS.has(name))) {
    throw tooBroad(
      `The agent read-only profile needs a token scoped to the buckets it reads, and this one lists ${label}'s system buckets, which only an operator or all-access token reads. Use a token with read permission on the connection's bucket. ${NOTHING_ELSE}`,
    );
  }
  if (!names.includes(database)) {
    throw new ExecutionProfileError(
      `The agent read-only profile reads the connection's database ${JSON.stringify(database)}, and ${label} does not list it for this principal: grant it READ there. ${NOTHING_ELSE}`,
      "PROFILE_PRIVILEGES_TOO_NARROW",
    );
  }

  const probe = writeProbeStatement(context.nonce);
  for (const name of names) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time keeps the proof to one permit.
    const answer = await send({ db: name, q: probe });
    const refused =
      traits.agentPrincipal === "user"
        ? isAuthorizationRefusal(answer, `requires WRITE on ${name}`)
        : isStatementRefusal(answer, "insufficient permissions");
    if (refused) continue;
    if (ran(answer)) {
      throw tooBroad(
        `The agent read-only profile needs a principal that writes nothing, and this one can write the database ${JSON.stringify(name)}: ${label} answered a no-op DELETE there. Use a ${traits.agentPrincipal === "user" ? "user granted READ only" : "token with read permission only"}. ${NOTHING_ELSE}`,
      );
    }
    throw unreadable(label, `a no-op DELETE on the database ${JSON.stringify(name)}`);
  }
}

/** Refuses a budget any field of which is not a positive integer in range, as every agent read path does. */
export function assertInfluxqlAgentBudget(budget: ReadOnlyStatementBudget): void {
  assertReadOnlyBudget(budget, "influxdb");
}

/**
 * How many wire bytes one byte of an answer, as the caller receives it, may take: the server's JSON encoder writes
 * `<`, `>` and `&` as six-byte `<` escapes, the widest form any one character takes on the wire.
 */
export const INFLUXQL_AGENT_WIRE_EXPANSION = 6;

/** Room beside the rows for an answer the server words as an error, which is not a row. */
export const INFLUXQL_AGENT_ENVELOPE_ALLOWANCE_BYTES = 64 * 1024;

/** The most bytes an agent answer may carry on the wire. */
export function influxqlAgentResponseCap(budget: ReadOnlyStatementBudget): number {
  return budget.maxResultBytes * INFLUXQL_AGENT_WIRE_EXPANSION + INFLUXQL_AGENT_ENVELOPE_ALLOWANCE_BYTES;
}

/**
 * A `/query` answer as the agent's fields and rows, or the shared refusal: the row bound, the cell bound, then the
 * byte bound. The shaper reads one row past the row budget, so a result one row over it is refused, never cut.
 */
export function shapeInfluxqlAgentAnswer(
  text: string,
  budget: ReadOnlyStatementBudget,
  secretForms: readonly string[],
  statement: string,
): { fields: string[]; rows: Record<string, unknown>[]; warnings: QueryWarning[] } {
  const shaped = shapeInfluxqlBody(
    text,
    { rowCut: budget.maxResultRows + 1, cellBudget: INFLUX_CELL_BUDGET },
    secretForms,
  );
  const rows = [...shaped.rows];
  if (rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(rows.length, budget.maxResultRows), "influxdb", statement);
  }
  // Under the row budget and still cut: the cell budget kept fewer rows than the result holds.
  if (shaped.cut) throw new QueryError(rowBudgetSentence(rows.length + 1, rows.length), "influxdb", statement);
  const bytes = measureResultBytes(rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "influxdb", statement);
  }
  return { fields: [...shaped.fields], rows, warnings: [...shaped.warnings] };
}

/**
 * A failed agent request as the shared refusal it is: an answer past the response cap (more than the cap, so the
 * sentence names one byte past it) or a request past its deadline. Anything else is undefined, for the provider's own
 * error table to word.
 */
export function influxqlAgentReadFailure(
  error: unknown,
  budget: ReadOnlyStatementBudget,
  statement: string,
): QueryError | undefined {
  if (!(error instanceof TransportError)) return undefined;
  if (error.kind === "too-large") {
    return new QueryError(
      byteBudgetSentence(influxqlAgentResponseCap(budget) + 1, budget.maxResultBytes),
      "influxdb",
      statement,
    );
  }
  if (error.kind === "timeout") {
    return new QueryError(
      `${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`,
      "influxdb",
      statement,
    );
  }
  return undefined;
}
