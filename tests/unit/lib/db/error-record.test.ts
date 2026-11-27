/**
 * The error record: one kind per error class, the API or deny code, the engine's SQLSTATE, and whether the statement
 * may have reached the database. Held by seeded property tests where a property is over generated values.
 *
 * The generator is mulberry32 with fixed seeds, written here rather than taken from a property-testing library, as in
 * packages/provider-sdk/tests/values/codec.test.ts. Every assertion message names the seed and the case, so a failure
 * can be replayed by running that seed alone. Every marker and credential is generated at run time, so no source line
 * holds one.
 */
import { describe, expect, test } from "bun:test";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { ERROR_KINDS, type ErrorKind, EXECUTE_OUTCOMES, SESSION_STATES } from "@libredb/provider-sdk/errors";
import {
  EXECUTION_PROFILE_DENY_CODES,
  ErrorRecordError,
  type ErrorRecord,
  errorCode,
  errorKind,
  errorOutcome,
  readErrorRecord,
} from "@/lib/db/error-record";
import * as errorsModule from "@/lib/db/errors";
import {
  AuthenticationError,
  ByteBudgetRefusal,
  ConnectionError,
  connectPhase,
  CutValueRefusal,
  DatabaseConfigError,
  DatabaseError,
  ExecutionProfileError,
  FacetNotOfferedError,
  PackageEngineUnsupportedError,
  ProviderUnavailableError,
  OffsetUnsupportedError,
  PermissionDeniedError,
  PoolExhaustedError,
  ProviderTextWithheldError,
  QueryCancelledError,
  QueryError,
  ReadAllowanceExceededError,
  RefusedBeforeSendError,
  RowBudgetRefusal,
  SerialisedResultRefusal,
  StudioByteBudgetRefusal,
  StudioObjectModelRefusal,
  StudioOffsetRefusal,
  StudioProfileRefusal,
  StudioRowBudgetRefusal,
  StudioTimeBudgetRefusal,
  StudioTimeoutRefusal,
  TimeBudgetRefusal,
  TimeoutError,
  TransactionLostError,
  UnknownProviderError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { errorRecord, isStudioRefusal, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { secretForms } from "@/lib/db/utils/server-text";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = [1, 7, 42, 2026, 0x5eed] as const;
const CASES_PER_SEED = 200;

const int = (random: () => number, below: number) => Math.floor(random() * below);
const pick = <T>(random: () => number, values: readonly T[]): T => values[int(random, values.length)];

const UPPER_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ENGINE_CODE_CHARS = `${UPPER_DIGITS}abcdefghijklmnopqrstuvwxyz_.:-`;

/** A SQLSTATE as `mapDatabaseError` keeps one: five digits or upper-case letters, with a digit. */
function generatedSqlState(random: () => number): string {
  const chars = Array.from({ length: 5 }, () => pick(random, [...UPPER_DIGITS]));
  chars[int(random, 5)] = String(int(random, 10));
  return chars.join("");
}

function generatedEngineCode(random: () => number): string {
  return Array.from({ length: 1 + int(random, 64) }, () => pick(random, [...ENGINE_CODE_CHARS])).join("");
}

/** A text of the error, generated, with no form of the scrub's credential. */
const marker = () => `marker-${crypto.randomUUID()}`;

/** A scrub whose forms are generated and occur in no text these tests build. */
const scrub: ProviderTextScrub = { type: "postgres", forms: secretForms([crypto.randomUUID()]) };

type ErrorClass = abstract new (...args: never[]) => Error;

/** Each class errors.ts exports, its kind, and an instance carrying `text` in every text field it has. */
const CLASSES: readonly (readonly [ErrorClass, ErrorKind, (text: string) => Error])[] = [
  [DatabaseError, "database", (text) => new DatabaseError(text, "postgres", undefined, text)],
  [DatabaseConfigError, "config", (text) => new DatabaseConfigError(text, "postgres")],
  [
    UnknownProviderError,
    "unknown-provider",
    (text) => new UnknownProviderError({ reason: "unknown", typeId: text, sentence: text }),
  ],
  [
    ProviderUnavailableError,
    "provider-unavailable",
    (text) => new ProviderUnavailableError(text, text, ["PROVIDER_LOAD_FAILED"]),
  ],
  [
    PackageEngineUnsupportedError,
    "package-engine-unsupported",
    (text) => new PackageEngineUnsupportedError(text, text),
  ],
  [FacetNotOfferedError, "not-offered", (text) => new FacetNotOfferedError(text, "mysql", "maintenance", text)],
  [ConnectionError, "connection", (text) => new ConnectionError(text, "postgres", text, 5432)],
  [TransactionLostError, "transaction-lost", (text) => new TransactionLostError(text, "postgres", text, 5432)],
  [AuthenticationError, "authentication", (text) => new AuthenticationError(text, "postgres", { fixStatement: text })],
  [PermissionDeniedError, "permission", (text) => new PermissionDeniedError(text, "postgres", text)],
  [PoolExhaustedError, "pool-exhausted", (text) => new PoolExhaustedError(text, "postgres", 10)],
  [QueryError, "query", (text) => new QueryError(text, "postgres", text, 3, text)],
  [OffsetUnsupportedError, "offset-unsupported", (text) => new OffsetUnsupportedError(text, "cassandra", text)],
  [StudioOffsetRefusal, "studio-offset-refusal", (text) => new StudioOffsetRefusal(text, "sqlite")],
  [StudioObjectModelRefusal, "studio-object-model-refusal", (text) => new StudioObjectModelRefusal(text)],
  [RefusedBeforeSendError, "refused-before-send", (text) => new RefusedBeforeSendError(text, "postgres", text)],
  [ReadAllowanceExceededError, "read-allowance-exceeded", (text) => new ReadAllowanceExceededError(text, "postgres")],
  [RowBudgetRefusal, "row-budget-refusal", (text) => new RowBudgetRefusal(text, "postgres", text)],
  [ByteBudgetRefusal, "byte-budget-refusal", (text) => new ByteBudgetRefusal(text, "postgres", text)],
  [TimeBudgetRefusal, "time-budget-refusal", (text) => new TimeBudgetRefusal(text, "postgres", text)],
  [CutValueRefusal, "cut-value-refusal", (text) => new CutValueRefusal(text, "mssql", text)],
  [SerialisedResultRefusal, "serialised-result-refusal", (text) => new SerialisedResultRefusal(text, "mssql", text)],
  [StudioRowBudgetRefusal, "studio-row-budget-refusal", (text) => new StudioRowBudgetRefusal(text, "postgres", text)],
  [
    StudioByteBudgetRefusal,
    "studio-byte-budget-refusal",
    (text) => new StudioByteBudgetRefusal(text, "postgres", text),
  ],
  [
    StudioTimeBudgetRefusal,
    "studio-time-budget-refusal",
    (text) => new StudioTimeBudgetRefusal(text, "postgres", text),
  ],
  [TimeoutError, "timeout", (text) => new TimeoutError(text, "postgres", 1000, text)],
  [StudioTimeoutRefusal, "studio-timeout-refusal", (text) => new StudioTimeoutRefusal(text, "postgres", 1000)],
  [QueryCancelledError, "cancelled", (text) => new QueryCancelledError(text, "postgres", text)],
  [ExecutionProfileError, "execution-profile", (text) => new ExecutionProfileError(text, "UNSUPPORTED_PROFILE")],
  [
    StudioProfileRefusal,
    "studio-profile-refusal",
    (text) => new StudioProfileRefusal(text, "PROFILE_UNSUPPORTED_BY_PROVIDER"),
  ],
  [ProviderTextWithheldError, "provider-text-withheld", (text) => new ProviderTextWithheldError(text, "postgres")],
];

/**
 * The same instance re-parented onto a prototype that inherits from its class's, which is what `class X extends C`
 * makes and what a provider's own subclass constructor sets with `Object.setPrototypeOf`.
 */
function asSubclass(error: Error): Error {
  return Object.setPrototypeOf(error, Object.create(Object.getPrototypeOf(error))) as Error;
}

/** Every instance: one of each class, and one of a subclass of each. */
function everyInstance(): { readonly error: Error; readonly label: string }[] {
  return CLASSES.flatMap(([Class, , make]) => [
    { error: make(marker()), label: Class.name },
    { error: asSubclass(make(marker())), label: `a subclass of ${Class.name}` },
  ]);
}

async function throughConnect(error: unknown): Promise<unknown> {
  return connectPhase(() => Promise.reject(error)).catch((raised: unknown) => raised);
}

function refusal(value: unknown): ErrorRecordError {
  try {
    readErrorRecord(value);
  } catch (error) {
    if (error instanceof ErrorRecordError) return error;
    throw error;
  }
  throw new Error("readErrorRecord accepted the value");
}

describe("kinds", () => {
  test.each(CLASSES.map(([Class, kind, make]) => [Class.name, kind, make] as const))(
    "each error class answers its own kind: %s is %s",
    (_name, kind, make) => {
      expect(errorKind(make(marker()))).toBe(kind);
    },
  );

  test.each(CLASSES.map(([Class, kind, make]) => [Class.name, kind, make] as const))(
    "a subclass declared elsewhere answers its nearest core class's kind: a subclass of %s is %s",
    (_name, kind, make) => {
      expect(errorKind(asSubclass(make(marker())))).toBe(kind);
    },
  );

  test("a TransportError answers connection, whatever its own kind field says", () => {
    for (const own of [
      "timeout",
      "unreachable",
      "aborted",
      "too-large",
      "redirect",
      "encoding",
      "tls",
      "network",
    ] as const) {
      const error = new TransportError(own, marker());
      expect(error.kind).toBe(own);
      expect(errorKind(error)).toBe("connection");
    }
  });

  test("a value that is no error class answers internal", () => {
    for (const value of [new Error(marker()), new TypeError("fetch failed"), marker(), undefined, null, 7]) {
      expect(errorKind(value)).toBe("internal");
      expect(errorCode(value)).toBe(ApiErrorCode.INTERNAL_ERROR);
    }
    expect(errorKind({ kind: "connection", code: "CONNECTION_ERROR" })).toBe("internal");
    expect(errorKind(Object.create(null))).toBe("internal");
  });

  test("every class errors.ts exports has exactly one kind, and no two share one", () => {
    const exported = (Object.values(errorsModule) as unknown[]).filter(
      (value): value is ErrorClass => typeof value === "function" && value.prototype instanceof Error,
    );
    expect(exported.map((Class) => Class.name).sort()).toEqual(CLASSES.map(([Class]) => Class.name).sort());
    const kinds = exported.map((Class) => errorKind(Object.create(Class.prototype)));
    expect(kinds).not.toContain("internal");
    expect(new Set(kinds).size).toBe(exported.length);
    expect([...kinds, "internal"].sort()).toEqual([...ERROR_KINDS].sort());
  });
});

describe("outcome", () => {
  class LocalRefusal extends RefusedBeforeSendError {
    constructor(message: string) {
      super(message, "postgres");
      Object.setPrototypeOf(this, LocalRefusal.prototype);
    }
  }

  test("a refusal before send answers not-sent wherever it is raised", async () => {
    const makers = [
      () => new RefusedBeforeSendError(marker(), "postgres"),
      () => new ReadAllowanceExceededError(marker(), "postgres"),
      () => new LocalRefusal(marker()),
    ];
    for (const make of makers) expect(errorOutcome(make())).toBe("not-sent");
    const raised = await Promise.all(makers.map((make) => throughConnect(make())));
    for (const error of raised) expect(errorOutcome(error)).toBe("not-sent");
    expect(errorKind(new LocalRefusal(marker()))).toBe("refused-before-send");
  });

  test("Studio's refusal of an offset it did not see applied answers not-sent wherever it is raised", async () => {
    const refusal = new StudioOffsetRefusal(marker(), "sqlite");
    expect(errorOutcome(refusal)).toBe("not-sent");
    expect(errorOutcome(await throughConnect(refusal))).toBe("not-sent");
  });

  test("Studio's refusal of a level or a kind the object model does not state answers not-sent wherever it is raised", async () => {
    const refusal = new StudioObjectModelRefusal(marker());
    expect(errorOutcome(refusal)).toBe("not-sent");
    expect(errorOutcome(await throughConnect(refusal))).toBe("not-sent");
  });

  test("a connection error raised by a statement answers unknown", () => {
    expect(errorOutcome(new ConnectionError(marker(), "postgres"))).toBe("unknown");
    expect(errorOutcome(new TransportError("network", marker(), { truncated: true }))).toBe("unknown");
  });

  test("every other class answers unknown", () => {
    for (const [Class, , make] of CLASSES) {
      const made = make(marker());
      if (
        made instanceof RefusedBeforeSendError ||
        made instanceof StudioOffsetRefusal ||
        made instanceof StudioObjectModelRefusal
      )
        continue;
      expect(errorOutcome(made), Class.name).toBe("unknown");
    }
    for (const value of [new Error(marker()), marker(), undefined]) expect(errorOutcome(value)).toBe("unknown");
  });
});

describe("round trip", () => {
  const roundTrip = (record: ErrorRecord) => readErrorRecord(JSON.parse(JSON.stringify(record)));

  test("every record built from a generated instance of every class crosses JSON and the reader unchanged", async () => {
    const cases: Promise<{ readonly label: string; readonly error: unknown }>[] = [];
    for (const seed of SEEDS) {
      const random = mulberry32(seed);
      for (const [Class, , make] of CLASSES) {
        for (let n = 0; n < CASES_PER_SEED; n++) {
          const label = `seed ${seed}, ${Class.name}, case ${n}`;
          const error = make(`${marker()} ${int(random, 1_000_000)}`);
          if (error instanceof DatabaseError && random() < 0.5) error.sqlstate = generatedSqlState(random);
          const raised = random() < 0.5 ? throughConnect(error) : Promise.resolve(error);
          cases.push(raised.then((settled) => ({ label, error: settled })));
        }
      }
    }
    for (const { label, error } of await Promise.all(cases)) {
      const record = errorRecord(scrub, error);
      expect(roundTrip(record), label).toEqual(record);
    }
  });

  test("every generated record over the whole shape crosses JSON and the reader unchanged", () => {
    const apiCodes = Object.values(ApiErrorCode);
    for (const seed of SEEDS) {
      const random = mulberry32(seed);
      for (let n = 0; n < CASES_PER_SEED; n++) {
        const kind = pick(random, ERROR_KINDS);
        const profile = kind === "execution-profile" || kind === "studio-profile-refusal";
        const record: Record<string, unknown> = {
          kind,
          code: profile ? pick(random, EXECUTION_PROFILE_DENY_CODES) : pick(random, apiCodes),
        };
        if (random() < 0.5) record.sqlState = generatedSqlState(random);
        if (random() < 0.5) record.engineCode = generatedEngineCode(random);
        if (random() < 0.5) record.outcome = pick(random, EXECUTE_OUTCOMES);
        if (random() < 0.5) record.sessionState = pick(random, SESSION_STATES);
        expect(roundTrip(record as unknown as ErrorRecord), `seed ${seed}, case ${n}`).toEqual(
          record as unknown as ErrorRecord,
        );
      }
    }
  });
});

describe("reader refuses", () => {
  const valid = { kind: "query", code: "QUERY_ERROR", outcome: "unknown" };

  test("a value that is not a record object is refused", () => {
    for (const value of [null, undefined, "query", 7, [], [valid]]) expect(refusal(value).field).toBe("record");
  });

  test("a missing or unknown kind or code is refused, naming the field", () => {
    expect(refusal({ code: "QUERY_ERROR" }).field).toBe("kind");
    expect(refusal({ kind: "query" }).field).toBe("code");
    const kind = marker();
    const unknownKind = refusal({ ...valid, kind });
    expect(unknownKind.field).toBe("kind");
    expect(unknownKind.message).not.toContain(kind);
    const code = marker();
    const unknownCode = refusal({ ...valid, code });
    expect(unknownCode.field).toBe("code");
    expect(unknownCode.message).not.toContain(code);
    expect(refusal({ ...valid, kind: 7 }).field).toBe("kind");
    expect(refusal({ ...valid, code: null }).field).toBe("code");
  });

  test("a profile kind with an API code, and an API kind with a deny code, are refused", () => {
    expect(refusal({ kind: "execution-profile", code: "QUERY_ERROR" }).field).toBe("code");
    expect(refusal({ kind: "studio-profile-refusal", code: "INTERNAL_ERROR" }).field).toBe("code");
    expect(refusal({ kind: "query", code: "UNSUPPORTED_PROFILE" }).field).toBe("code");
    expect(refusal({ kind: "internal", code: "READ_ROOTS_REQUIRED" }).field).toBe("code");
  });

  test("a malformed sqlState or engineCode is refused, naming the field and not the value", () => {
    for (const sqlState of ["42p01", "4201", "EPIPE", "ABCDE", "42P011", 42601]) {
      const error = refusal({ ...valid, sqlState });
      expect(error.field).toBe("sqlState");
      expect(error.message).not.toContain(String(sqlState));
    }
    for (const engineCode of ["ORA 00942", "x".repeat(65), "", 1146]) {
      const error = refusal({ ...valid, engineCode });
      expect(error.field).toBe("engineCode");
      if (engineCode !== "") expect(error.message).not.toContain(String(engineCode));
    }
    expect(readErrorRecord({ ...valid, engineCode: "x".repeat(64) }).engineCode).toBe("x".repeat(64));
    for (const engineCode of ["1146", "ORA-00942", "-204", "SQLITE_ERROR", "NamespaceNotFound"]) {
      expect(readErrorRecord({ ...valid, engineCode }).engineCode).toBe(engineCode);
    }
  });

  test("an unknown outcome or session state is refused", () => {
    expect(refusal({ ...valid, outcome: "sent" }).field).toBe("outcome");
    expect(refusal({ ...valid, outcome: null }).field).toBe("outcome");
    expect(refusal({ ...valid, sessionState: "aborted" }).field).toBe("sessionState");
  });

  test("an extra key is refused", () => {
    const key = `extra${crypto.randomUUID().slice(0, 8)}`;
    const error = refusal({ ...valid, [key]: 1 });
    expect(error.field).toBe(key);
    expect(refusal({ ...valid, message: "the error's words" }).field).toBe("message");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ErrorRecordError");
  });
});

describe("no text", () => {
  test("no record holds any text the error carries", async () => {
    const keys = new Set(["kind", "code", "sqlState", "engineCode", "outcome", "sessionState"]);
    const texts = CLASSES.map(() => marker());
    const raised = await Promise.all(CLASSES.map(([, , make], index) => throughConnect(make(texts[index]))));
    CLASSES.forEach(([Class, , make], index) => {
      for (const error of [make(texts[index]), raised[index]]) {
        const record = errorRecord(scrub, error);
        expect(JSON.stringify(record), Class.name).not.toContain(texts[index]);
        for (const key of Object.keys(record)) expect(keys.has(key), `${Class.name}: ${key}`).toBe(true);
      }
    });
  });
});

describe("carries what today's branches read", () => {
  test("Studio's own refusals are told apart by kind", () => {
    for (const { error, label } of everyInstance()) {
      const kind = errorRecord(scrub, error).kind;
      const studio = [
        "read-allowance-exceeded",
        "studio-row-budget-refusal",
        "studio-byte-budget-refusal",
        "studio-time-budget-refusal",
        "studio-timeout-refusal",
        "studio-profile-refusal",
        "studio-offset-refusal",
        "studio-object-model-refusal",
      ];
      expect(studio.includes(kind), label).toBe(isStudioRefusal(error));
    }
  });

  test("a refusal before send is told apart by kind and outcome", () => {
    for (const { error, label } of everyInstance()) {
      const record = errorRecord(scrub, error);
      const refused = error instanceof RefusedBeforeSendError;
      expect(record.kind === "refused-before-send" || record.kind === "read-allowance-exceeded", label).toBe(refused);
      expect(record.outcome === "not-sent", label).toBe(
        refused || error instanceof StudioOffsetRefusal || error instanceof StudioObjectModelRefusal,
      );
    }
  });

  test("the agent's environment failures are told apart by kind (ENVIRONMENT_FAILURES in src/lib/agent/tools.ts)", () => {
    const environmentFailures = [ConnectionError, PoolExhaustedError, DatabaseConfigError, StudioObjectModelRefusal];
    const environmentKinds = new Set<ErrorKind>([
      "studio-object-model-refusal",
      "connection",
      "transaction-lost",
      "pool-exhausted",
      "config",
      "unknown-provider",
      "provider-unavailable",
    ]);
    for (const { error, label } of everyInstance()) {
      expect(environmentKinds.has(errorRecord(scrub, error).kind), label).toBe(
        environmentFailures.some((Class) => error instanceof Class),
      );
    }
  });

  test("a profile refusal's code is its reason code", () => {
    for (const reasonCode of EXECUTION_PROFILE_DENY_CODES) {
      for (const error of [
        new ExecutionProfileError(marker(), reasonCode),
        new StudioProfileRefusal(marker(), reasonCode),
      ]) {
        expect(errorRecord(scrub, error).code).toBe(reasonCode);
        expect(errorCode(asSubclass(error))).toBe(reasonCode);
      }
    }
  });
});
