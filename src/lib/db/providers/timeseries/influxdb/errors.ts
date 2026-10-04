/**
 * The InfluxDB error table (InfluxDB spec 5.9; E14, E21): every measured failure of both types, worded as one of the
 * repository's error classes and the sentence a person reads.
 *
 * Four inputs reach `toInfluxError`. An `InfluxAnswerError` is an answer the provider would not read as a result: a
 * status that is not a success, or a 2xx whose content type is not the route's. An `InfluxAnswerShapeError` is what a
 * results module found inside a 200: a statement's own error, a top-level error, text that is not JSON, or results for
 * more than one statement (C5). A `TransportError` is the shared transport's, read by its kind and its `truncated`
 * flag. Any other `DatabaseError` (the egress guard's refusal, a refusal raised before the wire) is returned as it is.
 *
 * Each table is a list of rows tried in order, so a measured answer is one more row and never another `if`. A row
 * matches the server's raw words and its sentence carries them only through `serverText`, cut to 500 characters, so
 * a text that holds any form of the configured secret is withheld whole and never shown in part. What differs
 * between the lines comes from `GENERATION_TRAITS` (how a body names its error, and whether a token is read as
 * user:password) or from the measured text itself, which names its line; what differs between the two types is one
 * row of `TYPE_WORDING`. Nothing here retries, logs, or imports an `influxql-*` or `sql-*` module.
 */
import {
  AuthenticationError,
  ConnectionError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { serverText } from "@/lib/db/utils/server-text";
import type { InfluxAnswer } from "./client";
import type { InfluxType } from "./connection-options";
import { INFLUXQL_ROUTES, SQL_ROUTES } from "./routes";
import { RUN_DATABASE_SENTENCES } from "./run-database";
import { GENERATION_TRAITS, type GenerationTraits, type InfluxGeneration } from "./versions";

/**
 * An answer the provider would not read as a result, with the path of the route that asked for it (a path of the
 * route tables, `INFLUXQL_ROUTES.query.path` for example), which decides which rows apply.
 */
export class InfluxAnswerError extends Error {
  constructor(
    readonly answer: InfluxAnswer,
    readonly route: string,
  ) {
    super("InfluxDB answer");
  }
}

/** What a results module found in a 200 answer; `serverText` is the server's raw words, when it sent any. */
export class InfluxAnswerShapeError extends Error {
  constructor(
    readonly fault: "lexer-disagreement" | "not-json" | "top-level-error" | "statement-error",
    readonly serverText?: string,
  ) {
    super(fault);
  }
}

export interface InfluxErrorContext {
  readonly type: InfluxType;
  /** `connect` while the provider connects; `surface` (tree and monitoring reads) and `query` after it. */
  readonly phase: "connect" | "surface" | "query";
  /** The endpoint as configured: the far end under an SSH tunnel. */
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly generation: InfluxGeneration;
  readonly hasUser: boolean;
  /** The database the run or the session reads, which Studio sent. */
  readonly database: string | undefined;
  readonly timeoutMs: number;
  readonly responseCapBytes: number;
  /** `InfluxConnectionOptions.secretForms`. */
  readonly secretForms: readonly string[];
}

/** The longest server text a sentence carries (E21). */
const MAX_SERVER_TEXT = 500;
/** The longest content type the mis-pick sentence repeats. */
const MAX_CONTENT_TYPE = 100;
/** An error body longer than this is read as text and never parsed: a refusal's body is a sentence, not a result. */
const MAX_ERROR_BODY = 65_536;

/**
 * K11: the hosts of InfluxData's managed services, read from influxdata/docs-v2 `data/influxdb_urls.yml` on
 * 2026-10-04: Cloud Serverless (and Cloud 2 TSM) regions are `<region>.<provider>.cloud2.influxdata.com`, Cloud
 * Dedicated clusters `<cluster-id>.a.influxdb.io`. Clustered runs on the operator's own host and has no suffix.
 */
const CLOUD_HOST_SUFFIXES: readonly string[] = [".cloud2.influxdata.com", ".influxdb.io"];

/**
 * Every fixed sentence of spec 5.9 and the T08 and R33 amendments, templates as functions, so the provider-doc tests
 * read them back. `statementRefused` and `unrecognised` are plan-defined: spec 5.9 words no 200 statement error that
 * no row names, and no failure outside the four inputs.
 */
const SENTENCES = Object.freeze({
  parse: (text: string) => `InfluxDB could not parse the statement: ${text}`,
  influxqlParse: (text: string) => `InfluxQL could not parse the statement: ${text}`,
  databaseNotFound: (text: string) =>
    `InfluxDB has no database named in this run, or this credential cannot see it: ${text}`,
  cloudDbrp:
    "On InfluxDB Cloud Serverless, InfluxQL needs a DBRP mapping for the bucket first; see docs/providers/influxdb.md.",
  chooseDatabase: RUN_DATABASE_SENTENCES.chooseDatabase,
  readerCannotRead: (database: string) => `This user cannot read database ${database}, or it does not exist.`,
  oneDatabasePerStatement: "InfluxDB 3 reads one database per InfluxQL statement; name one database in the statement.",
  userMayNotListDatabases: "This user may not run SHOW DATABASES; check its grants.",
  userMayNotRun: (text: string) => `This user may not run this statement: ${text}`,
  tokenMayNotRun: (text: string) => `This token may not run this statement on that bucket: ${text}`,
  passwordWithoutUser: "InfluxDB 1.x reads a password with no user as user:password; fill User with the user name.",
  userPasswordRefused: "InfluxDB refused the user and password.",
  token2Refused: "InfluxDB 2.x refused the token: put an API token in Password or token with User empty.",
  token3Refused: "InfluxDB 3 refused the token.",
  infinity:
    "InfluxDB could not encode a value of this result (an infinity), so it sent no rows; filter that value out.",
  queryKilled: "The query was stopped on the server (an administrator ran KILL QUERY).",
  influxqlNotImplemented: (text: string) => `InfluxDB 3 does not implement this InfluxQL feature: ${text}`,
  statementRefused: (text: string) => `InfluxDB refused the statement: ${text}`,
  notReadable: "InfluxDB answered with text Studio cannot read as a result.",
  lexerDisagreement:
    "InfluxDB returned results for more than one statement, although Studio read the text as one statement. Nothing was shown; please report this, it means Studio's InfluxQL reader and the server disagree.",
  partial: "InfluxDB marked this result partial: the server cut it (max-row-limit).",
  noQueryEndpoint: (endpoint: string) => `This server has no InfluxDB /query endpoint at ${endpoint}.`,
  httpStatus: (status: string, text: string) => `InfluxDB answered HTTP ${status}: ${text}`,
  sqlParse: (text: string) => `InfluxDB 3 could not parse the SQL statement: ${text}`,
  sqlPlan: (text: string) => `InfluxDB 3 could not plan the statement: ${text}`,
  sqlDatabaseNotFound: (database: string) =>
    `InfluxDB 3 has no database named ${database}, or this token cannot see it.`,
  crossDatabase: (table: string, database: string) =>
    `InfluxDB 3 found no table ${table}: this connection reads one database, ${database}, and a statement cannot name another database; set Database on the connection to read another.`,
  noSqlEndpoint:
    "This server has no InfluxDB 3 SQL endpoint. InfluxDB Cloud Serverless and Dedicated serve SQL only over Flight, which Studio does not use: connect with InfluxDB (InfluxQL).",
  notSqlContentType: (endpoint: string, contentType: string) =>
    `InfluxDB at ${endpoint} answered the SQL request with ${contentType}, not JSON, so it is not an InfluxDB 3 SQL endpoint; check Host, Port and the connection type, or connect with InfluxDB (InfluxQL).`,
  sqlNotImplemented: (text: string) => `InfluxDB 3 does not implement this statement: ${text}`,
  sqlRefused: (text: string) => `InfluxDB 3 refused the statement: ${text}`,
  fileLimit:
    "InfluxDB 3 Core refuses a query that would read more than its file limit (432 Parquet files, about 72 hours, by default). Add a time range such as WHERE time >= now() - INTERVAL '1 day', or raise --query-file-limit on the server.",
  outOfMemory: (text: string) => `InfluxDB 3 ran out of the memory it allows one query: ${text}`,
  sqlTokenMayNotRead: (database: string) => `This token may not read database ${database}.`,
  authorizationMalformed: "InfluxDB 3 could not read the Authorization header; re-enter the token.",
  truncated:
    "InfluxDB failed while running this query after accepting it, so its reason did not reach Studio; it is in the server log. Common causes: a division by zero, a failed cast.",
  notReadableRow: "InfluxDB 3 answered with a line Studio cannot read as a row.",
  noSqlOnVersion: (version: string) =>
    `This server is ${version}, which has no SQL endpoint: connect with InfluxDB (InfluxQL).`,
  pingForbiddenNoDatabase:
    "This token cannot read the server's version, which an InfluxDB 3 Enterprise database token cannot; set Database on the connection.",
  noPing: (endpoint: string) => `This server does not answer InfluxDB's /ping at ${endpoint}; check Host and Port.`,
  timeout: (ms: string) =>
    `InfluxDB did not answer within ${ms} ms, so Studio stopped waiting and closed the connection, which stops the query on the server.`,
  cancelled: "The query was cancelled.",
  tooLarge: (size: string) =>
    `The result is larger than ${size}, the most Studio reads for one answer; add a LIMIT or a narrower time range.`,
  tls: (endpoint: string, code: string) =>
    `The TLS connection to InfluxDB at ${endpoint} failed: check the SSL mode and the CA under SSL / TLS. ${code}`,
  noCompleteAnswer: (endpoint: string, code: string) =>
    `No complete answer arrived from InfluxDB at ${endpoint}, and the request was not sent again. ${code}`,
  redirect: (endpoint: string) => `InfluxDB at ${endpoint} answered with a redirect Studio does not follow.`,
  encoding: (endpoint: string) => `InfluxDB at ${endpoint} answered with an encoding Studio does not follow.`,
  unrecognised: "The request to InfluxDB failed in a way Studio does not recognise.",
});

export const INFLUX_ERROR_SENTENCES: Readonly<Record<string, string | ((...parts: string[]) => string)>> = SENTENCES;

const S = SENTENCES;

/** What differs between the two types where a sentence does: one row each, never a branch on the type-id. */
const TYPE_WORDING: Readonly<Record<InfluxType, { readonly notReadable: string }>> = {
  influxdb: { notReadable: S.notReadable },
  influxdb3: { notReadable: S.notReadableRow },
};

const QUERY_PATH = INFLUXQL_ROUTES.query.path;
const PING_PATH = INFLUXQL_ROUTES.ping.path;
const SQL_PATHS: readonly string[] = [SQL_ROUTES.query.path, SQL_ROUTES.databases.path];
/** The content types the SQL routes answer with: `json` for the listing, `jsonl` for a query. */
const SQL_CONTENT_TYPE = /^application\/jsonl?\s*(;|$)/i;

function endpointOf(context: InfluxErrorContext): string {
  const { host, port } = context.endpoint;
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** The server's words as a sentence may carry them: withheld whole when they hold a secret form, then cut (E21). */
function shown(raw: string, context: InfluxErrorContext, max = MAX_SERVER_TEXT): string {
  const text = serverText(raw, context.secretForms);
  return text.length > max ? `${text.slice(0, max)} (cut)` : text;
}

function traitsOf(context: InfluxErrorContext): GenerationTraits {
  return GENERATION_TRAITS[context.generation];
}

/**
 * The server's own words in an error body, read the way the line's envelope sends them: the `message` of a 2.x
 * `{"code","message"}` body first, the `error` of the others first, the other field after it, because a server of an
 * unknown generation may send either; a body that is not JSON, or names neither field, is its text. A longer body is
 * cut to its first `MAX_ERROR_BODY` characters, so no row ever tests more than that (R40).
 */
function wordsOf(text: string, context: InfluxErrorContext): string {
  const fields = traitsOf(context).errorEnvelope === "code-message" ? ["message", "error"] : ["error", "message"];
  if (text.length <= MAX_ERROR_BODY) {
    try {
      const parsed: unknown = JSON.parse(text);
      const body = typeof parsed === "object" && parsed !== null ? (parsed as Readonly<Record<string, unknown>>) : {};
      const value = fields.map((field) => body[field]).find((candidate) => typeof candidate === "string");
      if (value !== undefined) return value as string;
    } catch {
      // Not JSON: a 3.x SQL error, a 404 page and a proxy's answer are plain text, which is read as it is.
    }
  }
  return text.slice(0, MAX_ERROR_BODY).trim();
}

/** The rest of the line after the first `marker` in `text`, read by index, never by a pattern (R40). */
function afterMarker(text: string, marker: string): string | undefined {
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  const rest = text.slice(at + marker.length);
  const end = rest.indexOf("\n");
  return end < 0 ? rest : rest.slice(0, end);
}

const READ_REFUSED = "requires READ on ";
const DATABASE_NOT_FOUND = "database not found: ";

const atConnect = (context: InfluxErrorContext): boolean => context.phase === "connect";

/** A QueryError at query, the given class at connect. */
function byPhase(
  context: InfluxErrorContext,
  message: string,
  atConnectAs: "authentication" | "connection",
): DatabaseError {
  if (!atConnect(context)) return new QueryError(message, context.type);
  return atConnectAs === "authentication"
    ? new AuthenticationError(message, context.type)
    : connectionError(context, message);
}

function connectionError(context: InfluxErrorContext, message: string): ConnectionError {
  return new ConnectionError(message, context.type, context.endpoint.host, context.endpoint.port);
}

interface Facts {
  readonly raw: string;
  readonly context: InfluxErrorContext;
}

interface Row<F extends Facts> {
  readonly when: (facts: F) => boolean;
  readonly error: (facts: F) => Error;
}

/** The first row that matches; the table's last row matches everything. */
function first<F extends Facts>(rows: readonly Row<F>[], facts: F): Error {
  return (rows.find((row) => row.when(facts)) as Row<F>).error(facts);
}

const query = (context: InfluxErrorContext, message: string) => new QueryError(message, context.type);

function isCloudHost(host: string): boolean {
  const lower = host.toLowerCase();
  return CLOUD_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

const INFINITY = /json: unsupported value: [+-]Inf/;

/** A statement's own error in a 200, or a top-level error: the server ran the request and refused the statement. */
const STATEMENT_ROWS: readonly Row<Facts>[] = [
  {
    when: ({ raw }) => raw.includes("database not found: "),
    error: ({ raw, context }) => {
      const cloud = isCloudHost(context.endpoint.host) ? ` ${S.cloudDbrp}` : "";
      return query(context, `${S.databaseNotFound(shown(raw, context))}${cloud}`);
    },
  },
  {
    when: ({ raw }) => raw.includes("database name required") || raw.includes("must specify a 'db' parameter"),
    error: ({ context }) => query(context, S.chooseDatabase),
  },
  {
    when: ({ raw }) => raw.includes("can only perform queries on a single database"),
    error: ({ context }) => query(context, S.oneDatabasePerStatement),
  },
  {
    when: ({ raw }) => raw.includes("insufficient permissions"),
    error: ({ raw, context }) => query(context, S.tokenMayNotRun(shown(raw, context))),
  },
  { when: ({ raw }) => INFINITY.test(raw), error: ({ context }) => query(context, S.infinity) },
  { when: ({ raw }) => raw.includes("query interrupted"), error: ({ context }) => query(context, S.queryKilled) },
  // K15: 3.12.0 sends the Core file limit on /query as a 200 statement error after "datafusion error: ".
  {
    when: ({ raw }) => raw.includes("Query would scan") && raw.includes("file limit"),
    error: ({ context }) => query(context, S.fileLimit),
  },
  {
    when: ({ raw }) => raw.includes("This feature is not implemented"),
    error: ({ raw, context }) => query(context, S.influxqlNotImplemented(shown(raw, context))),
  },
  {
    when: ({ raw }) => raw.includes("parsing error"),
    error: ({ raw, context }) => query(context, S.influxqlParse(shown(raw, context))),
  },
  { when: () => true, error: ({ raw, context }) => query(context, S.statementRefused(shown(raw, context))) },
];

interface AnswerFacts extends Facts {
  readonly status: number;
  readonly route: string;
  readonly contentType: string | null;
  /** The server's words, read through the line's envelope. */
  readonly words: string;
}

const onSql = ({ route }: AnswerFacts): boolean => SQL_PATHS.includes(route);
const said =
  (pattern: RegExp) =>
  ({ words }: AnswerFacts) =>
    pattern.test(words);
const words = (facts: AnswerFacts): string => shown(facts.words, facts.context);
const httpStatus = (facts: AnswerFacts): Error =>
  byPhase(facts.context, S.httpStatus(String(facts.status), words(facts)), "connection");

/**
 * The table name of a planning error, when it has three parts and its catalog is neither the default one nor the
 * session database's own (K18); with no session database there is no other database to name.
 */
function crossDatabaseTable(facts: AnswerFacts): string | undefined {
  const { database } = facts.context;
  const name = /table '([^']+)' not found/.exec(words(facts))?.[1];
  const parts = name?.split(".") ?? [];
  const other = database !== undefined && parts.length === 3 && parts[0] !== "public" && parts[0] !== database;
  return other ? name : undefined;
}

/** A password or token is configured: `secretForms` is empty with no password (`InfluxConnectionOptions`). */
const hasSecret = (context: InfluxErrorContext): boolean => context.secretForms.length > 0;

/**
 * A 401: the measured texts name their line, and the generation's traits decide where no text does. A password
 * sentence needs a password: with no credential configured the 401 carries the server's words.
 */
const UNAUTHENTICATED_ROWS: readonly Row<AnswerFacts>[] = [
  {
    when: said(/^authorization failed$/),
    error: ({ context }) => new AuthenticationError(S.userPasswordRefused, context.type),
  },
  {
    when: (facts) =>
      hasSecret(facts.context) &&
      (traitsOf(facts.context).tokenMeansUserPassword || said(/^unable to parse authentication credentials$/)(facts)),
    error: ({ context }) =>
      new AuthenticationError(context.hasUser ? S.userPasswordRefused : S.passwordWithoutUser, context.type),
  },
  {
    when: (facts) => traitsOf(facts.context).errorEnvelope === "code-message" || said(/^unauthori[sz]ed/i)(facts),
    error: ({ context }) => new AuthenticationError(S.token2Refused, context.type),
  },
  {
    when: said(/the request was not authenticated/),
    error: ({ context }) => new AuthenticationError(S.token3Refused, context.type),
  },
  {
    when: () => true,
    error: (facts) => new AuthenticationError(S.httpStatus("401", words(facts)), facts.context.type),
  },
];

/** An answer that is not a success, or a 2xx the route does not read, on either route table. */
const ANSWER_ROWS: readonly Row<AnswerFacts>[] = [
  { when: ({ status }) => status === 401, error: (facts) => first(UNAUTHENTICATED_ROWS, facts) },
  {
    when: (facts) =>
      facts.status >= 200 && facts.status <= 299 && onSql(facts) && !SQL_CONTENT_TYPE.test(facts.contentType ?? ""),
    error: (facts) => {
      const type =
        facts.contentType === null ? "no content type" : shown(facts.contentType, facts.context, MAX_CONTENT_TYPE);
      return byPhase(facts.context, S.notSqlContentType(endpointOf(facts.context), type), "connection");
    },
  },
  {
    when: ({ status, route }) => status >= 200 && status <= 299 && route === QUERY_PATH,
    error: ({ context }) => query(context, TYPE_WORDING[context.type].notReadable),
  },
  // 1.x and 2.x on /query.
  {
    when: (facts) => facts.status === 400 && said(/error parsing query|failed to parse query/)(facts),
    error: (facts) => query(facts.context, S.parse(words(facts))),
  },
  {
    when: (facts) => facts.status === 403 && /^\S/.test(afterMarker(words(facts), READ_REFUSED) ?? ""),
    error: (facts) => {
      const database = afterMarker(words(facts), READ_REFUSED) as string;
      return byPhase(facts.context, S.readerCannotRead(database), "authentication");
    },
  },
  {
    when: (facts) => facts.status === 403 && said(/not authorized to execute statement/)(facts),
    error: (facts) =>
      atConnect(facts.context)
        ? new AuthenticationError(S.userMayNotListDatabases, facts.context.type)
        : query(facts.context, S.userMayNotRun(words(facts))),
  },
  {
    when: ({ status, route }) => status === 404 && route === QUERY_PATH,
    error: ({ context }) => connectionError(context, S.noQueryEndpoint(endpointOf(context))),
  },
  {
    when: ({ status, route }) => status === 404 && route === PING_PATH,
    error: ({ context }) => connectionError(context, S.noPing(endpointOf(context))),
  },
  // 3.x on /api/v3.
  {
    when: (facts) => onSql(facts) && facts.status === 404 && facts.words.includes(DATABASE_NOT_FOUND),
    error: (facts) =>
      query(
        facts.context,
        S.sqlDatabaseNotFound(facts.context.database ?? (afterMarker(words(facts), DATABASE_NOT_FOUND) as string)),
      ),
  },
  {
    when: (facts) => onSql(facts) && facts.status === 404,
    error: ({ context }) => connectionError(context, S.noSqlEndpoint),
  },
  {
    when: (facts) => onSql(facts) && facts.status === 400 && said(/^SQL error: ParserError/)(facts),
    error: (facts) => query(facts.context, S.sqlParse(words(facts))),
  },
  {
    when: (facts) => onSql(facts) && facts.status === 400 && crossDatabaseTable(facts) !== undefined,
    error: (facts) =>
      query(facts.context, S.crossDatabase(crossDatabaseTable(facts) as string, facts.context.database as string)),
  },
  {
    when: (facts) => onSql(facts) && facts.status === 400 && said(/^Error during planning:/)(facts),
    error: (facts) => query(facts.context, S.sqlPlan(words(facts))),
  },
  {
    when: (facts) => onSql(facts) && facts.status === 400 && said(/missing field .db./)(facts),
    error: ({ context }) => query(context, S.chooseDatabase),
  },
  {
    when: (facts) => onSql(facts) && facts.status === 400 && said(/Authorization header was malformed/)(facts),
    error: ({ context }) => new AuthenticationError(S.authorizationMalformed, context.type),
  },
  {
    when: (facts) => onSql(facts) && facts.status === 403 && facts.context.database !== undefined,
    error: ({ context }) => byPhase(context, S.sqlTokenMayNotRead(context.database as string), "authentication"),
  },
  {
    when: (facts) => onSql(facts) && facts.status === 405,
    error: (facts) => query(facts.context, S.sqlNotImplemented(words(facts))),
  },
  {
    when: (facts) =>
      onSql(facts) &&
      facts.status >= 500 &&
      facts.words.includes("Query would scan") &&
      facts.words.includes("file limit"),
    error: ({ context }) => query(context, S.fileLimit),
  },
  {
    when: (facts) => onSql(facts) && facts.status >= 500 && said(/Resources exhausted/i)(facts),
    error: (facts) => query(facts.context, S.outOfMemory(words(facts))),
  },
  // I9: a 500 with a text body is the statement's refusal, never a connection or server-down error.
  {
    when: (facts) => onSql(facts) && facts.status >= 500 && facts.words !== "",
    error: (facts) => query(facts.context, S.sqlRefused(words(facts))),
  },
  // The contract's family table: a 403 at connect is the credential's.
  {
    when: (facts) => facts.status === 403,
    error: (facts) => byPhase(facts.context, S.httpStatus("403", words(facts)), "authentication"),
  },
  { when: () => true, error: httpStatus },
];

function answerError(error: InfluxAnswerError, context: InfluxErrorContext): Error {
  const { status, contentType, text } = error.answer;
  return first(ANSWER_ROWS, {
    raw: text,
    context,
    status,
    route: error.route,
    contentType,
    words: wordsOf(text, context),
  });
}

function shapeError(error: InfluxAnswerShapeError, context: InfluxErrorContext): Error {
  switch (error.fault) {
    case "lexer-disagreement":
      return query(context, S.lexerDisagreement);
    case "not-json":
      return query(context, TYPE_WORDING[context.type].notReadable);
    case "top-level-error":
    case "statement-error":
      return first(STATEMENT_ROWS, { raw: error.serverText ?? "", context });
  }
}

function formatBytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

function transportError(error: TransportError, context: InfluxErrorContext): Error {
  const endpoint = endpointOf(context);
  const code = shown(error.message, context);
  switch (error.kind) {
    case "timeout":
      return new TimeoutError(S.timeout(String(context.timeoutMs)), context.type, context.timeoutMs);
    case "aborted":
      return new QueryCancelledError(S.cancelled, context.type);
    case "too-large":
      return query(context, S.tooLarge(formatBytes(context.responseCapBytes)));
    case "tls":
      return connectionError(context, S.tls(endpoint, code));
    case "network":
      return error.truncated
        ? query(context, S.truncated)
        : connectionError(context, S.noCompleteAnswer(endpoint, code));
    case "redirect":
      return connectionError(context, S.redirect(endpoint));
    case "encoding":
      return connectionError(context, S.encoding(endpoint));
  }
}

/**
 * What a person reads for a failure of either type. The answer, shape and transport errors are worded by the
 * tables; any other error of the repository's own classes is returned as it is (`TransportError` is one, so it is
 * read first); anything else is a failure this provider did not expect, reported without its text.
 */
export function toInfluxError(error: unknown, context: InfluxErrorContext): Error {
  if (error instanceof TransportError) return transportError(error, context);
  if (error instanceof DatabaseError) return error;
  if (error instanceof InfluxAnswerError) return answerError(error, context);
  if (error instanceof InfluxAnswerShapeError) return shapeError(error, context);
  return query(context, S.unrecognised);
}
