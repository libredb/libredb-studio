/**
 * The inputs the driver error classification parity test runs through `mapDatabaseError`: every message beside every
 * set of driver code fields, for two providers. `golden-classification.json` holds what the classification answered
 * for each before each driver's rules moved beside its provider, so a move that changes one answer fails.
 */

/** Messages, as drivers spell them, each reaching one branch of the classification or none. */
export const CORPUS_MESSAGES: readonly string[] = [
  "",
  "connect ECONNREFUSED 127.0.0.1:5432",
  "getaddrinfo ENOTFOUND db",
  "NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode",
  "NJS-116: password verifier type 0x939 is not supported by node-oracledb in Thin mode",
  "NJS-533: Advanced Networking Option service negotiation failed",
  "NJS-529: invalid wallet content format",
  "NJS-089: feature not supported",
  "feature X is not supported by node-oracledb in Thin mode",
  'Cannot open database "shop" requested by the login. The login failed.',
  "permission denied for table orders",
  'password authentication failed for user "app"',
  "Access denied for user 'app'@'%'",
  "Login failed for user 'app'.",
  "ORA-01017: invalid username/password; logon denied",
  'syntax error at or near "SELEC"',
  "canceling statement due to statement timeout",
  "canceling statement due to lock timeout",
  "canceling statement due to user request",
  "Query execution was interrupted",
  "Query was cancelled",
  "KILL QUERY was issued",
  "Canceled.",
  "Connection timed out",
  "operation timeout",
  "ORA-12541: TNS:no listener",
  "ORA-12154: TNS:could not resolve the connect identifier",
  "ORA-00942: table or view does not exist",
  'column "x" does not exist',
  'relation "y" does not exist',
  "pool is draining",
  "Too many connections",
  "something else entirely",
];

/** Driver code fields, each as one installed driver puts them on its errors, plus none at all. */
export const CORPUS_FIELDS: readonly Readonly<Record<string, unknown>>[] = [
  {},
  { code: "42601", position: 8 },
  { code: "42P01" },
  { code: "28P01" },
  { code: "42501" },
  { code: "08006" },
  { code: "57014" },
  { code: "40001" },
  { sqlState: "42000", errno: 1142 },
  { sqlState: "42000", errno: 1064 },
  { sqlState: "42000", errno: 1203 },
  { errno: 1226 },
  { sqlState: "HY000", errno: 1045 },
  { sqlState: "HY000", errno: 3118 },
  { errno: 1142 },
  { number: 2812 },
  { number: 229 },
  { number: 1205 },
  { number: 4060 },
  { errorNum: 900 },
  { errorNum: 1031 },
  { errorNum: 1017 },
  { errorNum: 12899 },
  { errorNum: 1861 },
  { errorNum: 2291 },
  { errorNum: 6550 },
  { errorNum: 3113 },
  { sqlstate: "08004", sqlcode: -1060 },
  { sqlcode: -30082 },
  { sqlstate: "42704", sqlcode: -204 },
  { code: 13, codeName: "Unauthorized" },
  { code: 18, codeName: "AuthenticationFailed" },
  { code: 2, codeName: "BadValue" },
  { code: 13 },
  { code: "SQLITE_CONSTRAINT_PRIMARYKEY" },
  { code: "SQLITE_ERROR" },
  { code: "SQLITE_BUSY" },
  { code: "ERR_SQLITE_ERROR", errcode: 2067 },
  { code: "ERR_SQLITE_ERROR", errcode: 5 },
  { code: "ECANCEL" },
  { code: "ECANCELED" },
  { code: "EPIPE" },
];

/** The providers each input is mapped for: the classification names the provider in some messages. */
export const CORPUS_PROVIDERS = ["postgres", "oracle"] as const;

/** One input: an Error with the message and the fields, and a statement. */
export function corpusError(message: string, fields: Readonly<Record<string, unknown>>): Error {
  return Object.assign(new Error(message), fields);
}

/** What one classification answered, as the golden file stores it. */
export function classificationOf(error: {
  readonly name: string;
  readonly message: string;
  readonly code?: unknown;
  readonly sqlstate?: unknown;
  readonly position?: unknown;
  readonly query?: unknown;
}): readonly unknown[] {
  return [
    error.name,
    error.message,
    error.code ?? null,
    error.sqlstate ?? null,
    error.position ?? null,
    error.query ?? null,
  ];
}
