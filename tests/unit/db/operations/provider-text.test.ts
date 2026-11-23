/**
 * The one core scrub of a provider's text: the calling connection's secret-class values and every form `secretForms`
 * derives from them; a text holding any of them is withheld whole.
 *
 * Every credential here is generated at run time, so no source line holds one.
 */
import { describe, expect, test } from "bun:test";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import {
  AuthenticationError,
  ByteBudgetRefusal,
  ConnectionError,
  connectPhase,
  CutValueRefusal,
  ExecutionProfileError,
  QueryError,
  ReadAllowanceExceededError,
  RefusedBeforeSendError,
  RowBudgetRefusal,
  SerialisedResultRefusal,
  StudioByteBudgetRefusal,
  StudioProfileRefusal,
  StudioRowBudgetRefusal,
  StudioTimeBudgetRefusal,
  StudioTimeoutRefusal,
  ProviderTextWithheldError,
  TimeBudgetRefusal,
  TimeoutError,
} from "@/lib/db/errors";
import { errorOutcome } from "@/lib/db/error-record";
import {
  errorRecord,
  isStudioRefusal,
  PROVIDER_TEXT_WITHHELD,
  providerAuthor,
  providerTextScrub,
  scrubKindCounts,
  scrubObjectDetail,
  scrubProviderText,
  scrubProviderWarnings,
  scrubSourceDocument,
  withheldErrorMessage,
  withheldProviderError,
  withholdProviderError,
  withScrubbedWarnings,
} from "@/lib/db/operations/provider-text";
import { secretForms } from "@/lib/db/utils/server-text";
import { CONNECTION_FIELDS, SSH_TUNNEL_FIELDS, SSL_FIELDS, type FieldClass } from "@/lib/storage/secret-fields";
import type { KindCount, ObjectDetail, ObjectSourceDocument } from "@/lib/db/types";
import type { DatabaseConnection, DatabaseType, QueryResult } from "@/lib/types";

const generated = () => `${crypto.randomUUID()}/${crypto.randomUUID().slice(0, 8)}`;

function connectionWith(fields: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "c1",
    name: "Prod",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    createdAt: new Date(0),
    ...fields,
  } as DatabaseConnection;
}

/** Every path the classification maps call secret, read off the maps, so a field classified tomorrow is covered. */
function secretPaths(): string[] {
  const of = (map: Record<string, FieldClass>, prefix: string) =>
    Object.keys(map)
      .filter((key) => map[key] === "secret")
      .map((key) => `${prefix}${key}`);
  return [...of(CONNECTION_FIELDS, ""), ...of(SSL_FIELDS, "ssl."), ...of(SSH_TUNNEL_FIELDS, "sshTunnel.")];
}

function connectionWithPath(path: string, value: string): DatabaseConnection {
  const [head, key] = path.split(".");
  if (key === undefined) return connectionWith({ [head]: value } as Partial<DatabaseConnection>);
  return connectionWith({ [head]: { [key]: value } } as Partial<DatabaseConnection>);
}

const base64url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
/** Built from random JSON, so the value is shaped as a JWT and no source line holds one. */
const generatedJwt = () =>
  [
    base64url(JSON.stringify({ alg: crypto.randomUUID() })),
    base64url(JSON.stringify({ sub: crypto.randomUUID() })),
    base64url(crypto.randomUUID()),
  ].join(".");

/** The secret paths a provider receives: every one but the tunnel's, which `providerConnection` strips. */
const providerPaths = () => secretPaths().filter((path) => !path.startsWith("sshTunnel."));
const tunnelPaths = () => secretPaths().filter((path) => path.startsWith("sshTunnel."));

describe("providerTextScrub", () => {
  test.each(providerPaths().flatMap((path) => (["profiled", "any"] as const).map((reach) => [path, reach] as const)))(
    "withholds a text holding the value of any secret-class field a provider receives: %s (%s)",
    (path, reach) => {
      const value = generated();
      const scrub = providerTextScrub(connectionWithPath(path, value), reach);
      expect(scrubProviderText(scrub, `rejected ${value} by the server`)).toBe(PROVIDER_TEXT_WITHHELD);
    },
  );

  test.each(tunnelPaths().flatMap((path) => (["profiled", "any"] as const).map((reach) => [path, reach] as const)))(
    "leaves out a tunnel secret, which no provider receives: %s (%s)",
    (path, reach) => {
      const value = generated();
      const scrub = providerTextScrub(connectionWithPath(path, value), reach);
      expect(scrub.forms).toEqual([]);
      expect(scrubProviderText(scrub, `echoed ${value}`)).toBe(`echoed ${value}`);
    },
  );

  test("a profiled scrub leaves out the connection's own password where an agent password replaces it", () => {
    const own = generated();
    const agent = generated();
    const connection = connectionWith({ password: own, agentUser: "agent", agentPassword: agent });
    const profiled = providerTextScrub(connection, "profiled");
    expect(scrubProviderText(profiled, `echoed ${own}`)).toBe(`echoed ${own}`);
    expect(scrubProviderText(profiled, `echoed ${agent}`)).toBe(PROVIDER_TEXT_WITHHELD);
    const any = providerTextScrub(connection, "any");
    expect(scrubProviderText(any, `echoed ${own}`)).toBe(PROVIDER_TEXT_WITHHELD);
    expect(scrubProviderText(any, `echoed ${agent}`)).toBe(PROVIDER_TEXT_WITHHELD);
  });

  test("a profiled scrub keeps the connection's own password where no agent password replaces it", () => {
    const own = generated();
    const scrub = providerTextScrub(connectionWith({ password: own, agentUser: "agent" }), "profiled");
    expect(scrubProviderText(scrub, `echoed ${own}`)).toBe(PROVIDER_TEXT_WITHHELD);
  });

  const password = generated();
  const token = generatedJwt();
  test.each([
    ["the value itself", password],
    ["its base64 without padding", Buffer.from(password, "utf8").toString("base64").replace(/=+$/, "")],
    ["its padded base64", Buffer.from(password, "utf8").toString("base64")],
    ["its URI-encoded form", encodeURIComponent(password)],
  ])("withholds each form secretForms derives from a value, padded base64 included: %s", (_label, form) => {
    const scrub = providerTextScrub(connectionWith({ password }), "profiled");
    expect(scrubProviderText(scrub, `header ${form}.`)).toBe(PROVIDER_TEXT_WITHHELD);
  });

  test.each<[string, (value: string) => string]>([
    ["at a Basic offset", (value) => `Authorization: Basic ${Buffer.from(`user:${value}`, "utf8").toString("base64")}`],
    ["JSON-escaped", (value) => JSON.stringify(JSON.stringify(`rejected ${value}`))],
    ["with control characters between its characters", (value) => `rejected ${value.split("").join("\u0000")}`],
  ])("withholds a provider text holding the credential %s", (_label, spell) => {
    const value = `${generated()}"\\`;
    const scrub = providerTextScrub(connectionWith({ password: value }), "profiled");
    expect(scrubProviderText(scrub, spell(value))).toBe(PROVIDER_TEXT_WITHHELD);
    const error = new QueryError("failed", "postgres", undefined, undefined, spell(value));
    expect(withholdProviderError(scrub, error)).toBeInstanceOf(ProviderTextWithheldError);
  });

  test("withholds each segment of a JWT-shaped value", () => {
    const scrub = providerTextScrub(connectionWith({ password: token }), "profiled");
    for (const segment of token.split(".")) {
      expect(scrubProviderText(scrub, `bad segment ${segment}`)).toBe(PROVIDER_TEXT_WITHHELD);
    }
  });

  test("says by name that a text was withheld and echoes none of it", () => {
    const scrub = providerTextScrub(connectionWith({ password }), "profiled");
    const withheld = scrubProviderText(scrub, `rejected ${password}`);
    expect(withheld).toBe(PROVIDER_TEXT_WITHHELD);
    expect(withheld).toContain("withheld");
    expect(withheld).toContain("credential");
    for (const form of secretForms([password])) expect(withheld).not.toContain(form);
  });

  test("returns a text holding no form unchanged", () => {
    const scrub = providerTextScrub(connectionWith({ password }), "profiled");
    const raw = 'relation "orders" does not exist';
    expect(scrubProviderText(scrub, raw)).toBe(raw);
  });

  test("adds no form for an empty secret", () => {
    const scrub = providerTextScrub(connectionWith({ password: "" }), "any");
    expect(scrub.forms).toEqual([]);
    expect(scrubProviderText(scrub, "any text")).toBe("any text");
  });

  test("names the connection's type", () => {
    expect(providerTextScrub(connectionWith({ type: "mysql" }), "any").type).toBe("mysql");
  });

  test("matches as serverText does, case-sensitively", () => {
    const value = `Upper${crypto.randomUUID()}`;
    const scrub = providerTextScrub(connectionWith({ password: value }), "profiled");
    expect(scrubProviderText(scrub, `rejected ${value.toLowerCase()}`)).toBe(`rejected ${value.toLowerCase()}`);
  });
});

describe("withholdProviderError", () => {
  const password = generated();
  const scrub = providerTextScrub(connectionWith({ password }), "profiled");

  test("returns the same error when no text a renderer reads holds a form", () => {
    const error = new QueryError("syntax error at or near SELEC", "postgres", "SELEC 1", 1, "near SELEC");
    expect(withholdProviderError(scrub, error)).toBe(error);
    const plain = "a thrown string";
    expect(withholdProviderError(scrub, plain)).toBe(plain);
  });

  const holders: [string, () => unknown][] = [
    ["the message", () => new ConnectionError(`could not connect with ${password}`, "postgres")],
    [
      "the stack's header, set after the error was built",
      () => {
        const error = new ConnectionError("could not connect", "postgres");
        error.stack = `ConnectionError: could not connect as ${password}\n    at connect (driver.js:1:1)`;
        return error;
      },
    ],
    [
      "the name",
      () => {
        const error = new Error("failed");
        error.name = `Error ${password}`;
        return error;
      },
    ],
    ["a QueryError's detail", () => new QueryError("failed", "postgres", undefined, undefined, `detail ${password}`)],
    [
      "an AuthenticationError's fixStatement",
      () => new AuthenticationError("denied", "postgres", { fixStatement: `ALTER ROLE x PASSWORD '${password}'` }),
    ],
  ];

  holders.push(
    ["a thrown string", () => `password authentication failed for ${password}`],
    ["a thrown object's string form", () => ({ toString: () => `auth failed for ${password}` })],
  );

  test.each(holders)("answers a ProviderTextWithheldError when %s holds one", (_label, make) => {
    const withheld = withholdProviderError(scrub, make());
    expect(withheld).toBeInstanceOf(ProviderTextWithheldError);
    const error = withheld as ProviderTextWithheldError;
    expect(error.message).toContain("withheld");
    expect(error.message).not.toContain(password);
    expect(error.provider).toBe("postgres");
    expect(String(error.stack)).not.toContain(password);
  });

  test.each([
    ["a ConnectionError", new ConnectionError(`could not connect with ${password}`, "postgres"), "ConnectionError"],
    [
      "an AuthenticationError",
      new AuthenticationError("denied", "postgres", { fixStatement: `ALTER ROLE x PASSWORD '${password}'` }),
      "AuthenticationError",
    ],
    ["a thrown string", `failed for ${password}`, "thrown string"],
  ] as const)("names the class of %s it replaced, which is code and not provider text", (_label, error, replaced) => {
    expect((withholdProviderError(scrub, error) as Error).message).toBe(
      `(Studio withheld the text of this ${replaced} because it contained a credential of this connection)`,
    );
    expect(withheldErrorMessage(replaced)).toBe((withholdProviderError(scrub, error) as Error).message);
  });

  test("names no class whose name holds a form", () => {
    const error = new Error("failed");
    error.name = `Error ${password}`;
    expect((withholdProviderError(scrub, error) as Error).message).toBe(
      "(Studio withheld the text of this error because it contained a credential of this connection)",
    );
  });

  test("returns the same error when a form occurs only in a frame line of its stack, which is code, not its text", () => {
    const error = new Error("No API key is configured for the model");
    error.stack = `Error: No API key is configured for the model\n    at admit (/srv/${password}/chunk.js:12:34)\n    at run (x.js:1:1)`;
    expect(withholdProviderError(scrub, error)).toBe(error);
  });

  test("never changes the error it was given", () => {
    const error = new ConnectionError(`could not connect with ${password}`, "postgres");
    const { message, stack } = error;
    withholdProviderError(scrub, error);
    expect(error.message).toBe(message);
    expect(error.stack).toBe(stack);
  });
});

describe("withheldProviderError", () => {
  const password = generated();
  const scrub = providerTextScrub(connectionWith({ password }), "any");

  test("answers null for a value none of whose texts holds a form", () => {
    expect(withheldProviderError(scrub, new QueryError("syntax error", "postgres", "SELEC 1", 1, "near"))).toBeNull();
    expect(withheldProviderError(scrub, "a thrown string")).toBeNull();
    expect(withheldProviderError(scrub, { toString: () => "a thrown object" })).toBeNull();
  });

  test("answers a ProviderTextWithheldError naming the replaced class when any rendered text holds a form", () => {
    const fromDetail = new QueryError("failed", "postgres", undefined, undefined, `detail ${password}`);
    const fromFix = new AuthenticationError("denied", "postgres", {
      fixStatement: `ALTER ROLE x PASSWORD '${password}'`,
    });
    const fromSqlstate = new QueryError("failed", "postgres");
    fromSqlstate.sqlstate = password;
    for (const [error, replaced] of [
      [new ConnectionError(`could not connect with ${password}`, "postgres"), "ConnectionError"],
      [fromDetail, "QueryError"],
      [fromFix, "AuthenticationError"],
      [fromSqlstate, "QueryError"],
      [`failed for ${password}`, "thrown string"],
    ] as const) {
      const withheld = withheldProviderError(scrub, error);
      expect(withheld).toBeInstanceOf(ProviderTextWithheldError);
      expect(withheld?.message).toBe(withheldErrorMessage(replaced));
      expect(withheld?.provider).toBe("postgres");
    }
  });

  test("keeps not-sent and never changes the error given", async () => {
    const connectFailure = new ConnectionError(`could not connect with ${password}`, "postgres");
    const raised = await connectPhase(() => Promise.reject(connectFailure)).catch((error: unknown) => error);
    const { message, stack } = raised as Error;
    expect(errorOutcome(withheldProviderError(scrub, raised))).toBe("not-sent");
    expect((raised as Error).message).toBe(message);
    expect((raised as Error).stack).toBe(stack);
    expect(errorOutcome(withheldProviderError(scrub, new ConnectionError(`lost ${password}`, "postgres")))).toBe(
      "unknown",
    );
  });

  test("withholdProviderError answers the withheld error or the value itself", () => {
    const clean = new QueryError("syntax error", "postgres");
    expect(withholdProviderError(scrub, clean)).toBe(clean);
    const held = new QueryError(`syntax error near ${password}`, "postgres");
    const withheld = withholdProviderError(scrub, held) as Error;
    expect(withheld).toBeInstanceOf(ProviderTextWithheldError);
    expect(withheld.message).toBe(withheldProviderError(scrub, held)?.message ?? "");
  });
});

describe("scrubProviderWarnings and withScrubbedWarnings", () => {
  const password = generated();
  const scrub = providerTextScrub(connectionWith({ password }), "profiled");

  test("scrubs a warning's message, string code and severity", () => {
    const warnings = scrubProviderWarnings(scrub, [
      { message: `notice ${password}`, code: `C${password}`, severity: `W${password}` },
      { message: "kept", code: 7, severity: "NOTICE" },
      { message: "no code" },
    ]);
    expect(warnings).toEqual([
      { message: PROVIDER_TEXT_WITHHELD, code: PROVIDER_TEXT_WITHHELD, severity: PROVIDER_TEXT_WITHHELD },
      { message: "kept", code: 7, severity: "NOTICE" },
      { message: "no code" },
    ]);
  });

  test("keeps a result with no warnings as the same object", () => {
    const result = { rows: [], fields: [], rowCount: 0, executionTime: 1 } as QueryResult;
    expect(withScrubbedWarnings(scrub, result)).toBe(result);
  });

  test("answers a copy of a result whose warnings it scrubbed", () => {
    const result = {
      rows: [{ a: password }],
      fields: ["a"],
      rowCount: 1,
      executionTime: 1,
      warnings: [{ message: `notice ${password}` }],
    } as QueryResult;
    const scrubbed = withScrubbedWarnings(scrub, result);
    expect(scrubbed.warnings).toEqual([{ message: PROVIDER_TEXT_WITHHELD }]);
    expect(scrubbed.rows).toBe(result.rows);
    expect(result.warnings).toEqual([{ message: `notice ${password}` }]);
  });
});

describe("the object read sentences", () => {
  const password = generated();
  const scrub = providerTextScrub(connectionWith({ password }), "any");

  test("scrubKindCounts withholds an unavailable or sampledFrom sentence that holds the connection's credential and keeps every count", () => {
    const counts: Record<string, KindCount> = {
      table: { unavailable: `permission denied for ${password}` },
      view: { count: 7, sampledFrom: `sampled as ${password}` },
      index: { count: 3 },
      sequence: { count: 2, sampledFrom: "pg_class estimate" },
      function: { unavailable: "the catalog refused the read" },
    };
    expect(scrubKindCounts(scrub, counts)).toEqual({
      table: { unavailable: PROVIDER_TEXT_WITHHELD },
      view: { count: 7, sampledFrom: PROVIDER_TEXT_WITHHELD },
      index: { count: 3 },
      sequence: { count: 2, sampledFrom: "pg_class estimate" },
      function: { unavailable: "the catalog refused the read" },
    });
  });

  test("scrubObjectDetail withholds an unavailable index sentence and answers a detail whose indexes are a list as given", () => {
    const refused: ObjectDetail = {
      path: ["public", "orders"],
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: { unavailable: `index read refused for ${password}` },
      foreignKeys: [],
    };
    expect(scrubObjectDetail(scrub, refused)).toEqual({ ...refused, indexes: { unavailable: PROVIDER_TEXT_WITHHELD } });
    const listed: ObjectDetail = {
      path: ["public", "orders"],
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
      foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
    };
    expect(scrubObjectDetail(scrub, listed)).toEqual(listed);
  });

  test("scrubSourceDocument withholds a part's refusal, truncation and refused edit sentences, and keeps its text, its statement flag and an offered edit", () => {
    const document: ObjectSourceDocument = {
      path: ["public", "report"],
      kind: "function",
      parts: [
        { id: "definition", label: "Definition", unavailable: `pg_get_functiondef refused for ${password}` },
        { id: "grants", label: "Grants", unavailable: `grant read refused for ${password}`, statement: true },
        {
          id: "body",
          label: "Body",
          text: "SELECT 1",
          language: "sql",
          form: "complete",
          origin: "stored",
          truncated: { limit: 10, reason: `cut for ${password}` },
          edit: { offered: false, reason: `owned by ${password}` },
        },
        {
          id: "comment",
          label: "Comment",
          text: `COMMENT ON FUNCTION report IS 'kept'`,
          language: "sql",
          form: "complete",
          origin: "rendered",
          edit: { offered: true },
        },
      ],
    };
    const scrubbed = scrubSourceDocument(scrub, document);
    expect(scrubbed).toEqual({
      path: ["public", "report"],
      kind: "function",
      parts: [
        { id: "definition", label: "Definition", unavailable: PROVIDER_TEXT_WITHHELD },
        { id: "grants", label: "Grants", unavailable: PROVIDER_TEXT_WITHHELD, statement: true },
        {
          id: "body",
          label: "Body",
          text: "SELECT 1",
          language: "sql",
          form: "complete",
          origin: "stored",
          truncated: { limit: 10, reason: PROVIDER_TEXT_WITHHELD },
          edit: { offered: false, reason: PROVIDER_TEXT_WITHHELD },
        },
        document.parts[3],
      ],
    });
  });

  test("scrubSourceDocument answers a document with no parts as given, for the source route's bound to refuse", () => {
    const empty = { path: ["report"], kind: "view", parts: [] } as unknown as ObjectSourceDocument;
    expect(scrubSourceDocument(scrub, empty)).toBe(empty);
  });

  test("a value none of whose sentences holds a form answers deep-equal to the value given, and the value given is not changed", () => {
    const counts: Record<string, KindCount> = {
      table: { unavailable: `refused for ${password}` },
      view: { count: 1, sampledFrom: "estimate" },
    };
    const detail: ObjectDetail = {
      path: ["orders"],
      columns: [],
      indexes: { unavailable: `refused for ${password}` },
      foreignKeys: [],
    };
    const document: ObjectSourceDocument = {
      path: ["report"],
      kind: "view",
      parts: [
        {
          id: "definition",
          label: "Definition",
          text: `SELECT '${password}'`,
          language: "sql",
          form: "partial",
          origin: "regenerated",
          truncated: { limit: 5, reason: `cut for ${password}` },
          edit: { offered: false, reason: "a view built by the engine" },
        },
      ],
    };
    const before = structuredClone({ counts, detail, document });
    scrubKindCounts(scrub, counts);
    scrubObjectDetail(scrub, detail);
    scrubSourceDocument(scrub, document);
    expect({ counts, detail, document }).toEqual(before);

    const clean = providerTextScrub(connectionWith({ password: generated() }), "any");
    expect(scrubKindCounts(clean, counts)).toEqual(counts);
    expect(scrubObjectDetail(clean, detail)).toEqual(detail);
    expect(scrubSourceDocument(clean, document)).toEqual(document);
  });
});

describe("providerAuthor", () => {
  test("names the PostgreSQL provider as bundled with Studio", () => {
    expect(providerAuthor("postgres")).toBe("PostgreSQL provider, bundled with Studio");
  });

  test("names every engine by its form label", () => {
    for (const type of Object.keys(CONNECTION_FORM) as DatabaseType[]) {
      expect(providerAuthor(type)).toBe(`${CONNECTION_FORM[type].label} provider, bundled with Studio`);
    }
  });
});

describe("isStudioRefusal", () => {
  test("is true for the two classes only core constructs", () => {
    expect(isStudioRefusal(new ReadAllowanceExceededError("too many reads", "postgres"))).toBe(true);
    expect(isStudioRefusal(new StudioProfileRefusal("refused", "AGENT_CREDENTIAL_REQUIRED"))).toBe(true);
  });

  test("is false for a provider's refusal", () => {
    expect(isStudioRefusal(new ExecutionProfileError("refused", "READ_ROOTS_REQUIRED"))).toBe(false);
    expect(isStudioRefusal(new RefusedBeforeSendError("refused", "postgres"))).toBe(false);
    expect(isStudioRefusal("text")).toBe(false);
  });

  test("the core budget and time classes are Studio's, and a plain QueryError or TimeoutError is not", () => {
    const timeRefusal = new StudioTimeoutRefusal("did not answer in time", "postgres", 50);
    for (const Class of [StudioRowBudgetRefusal, StudioByteBudgetRefusal, StudioTimeBudgetRefusal]) {
      const budgetRefusal = new Class("refused by the budget", "postgres", "SELECT 1");
      expect(isStudioRefusal(budgetRefusal), Class.name).toBe(true);
      expect(budgetRefusal, Class.name).toBeInstanceOf(QueryError);
      expect(budgetRefusal.name, Class.name).toBe("QueryError");
      expect(budgetRefusal.query, Class.name).toBe("SELECT 1");
    }
    expect(isStudioRefusal(timeRefusal)).toBe(true);
    expect(isStudioRefusal(new QueryError("refused by the row budget", "postgres"))).toBe(false);
    expect(isStudioRefusal(new TimeoutError("did not answer in time", "postgres", 50))).toBe(false);
    expect(timeRefusal).toBeInstanceOf(TimeoutError);
    expect(timeRefusal.name).toBe("TimeoutError");
    expect(timeRefusal.timeout).toBe(50);
  });

  test("a provider's budget refusal classes are not Studio's", () => {
    for (const Class of [
      RowBudgetRefusal,
      ByteBudgetRefusal,
      TimeBudgetRefusal,
      CutValueRefusal,
      SerialisedResultRefusal,
    ]) {
      expect(isStudioRefusal(new Class("refused by the budget", "postgres", "SELECT 1")), Class.name).toBe(false);
    }
  });

  test("a StudioProfileRefusal keeps the name ExecutionProfileError", () => {
    const refusal = new StudioProfileRefusal("refused", "AGENT_CREDENTIAL_REQUIRED");
    expect(refusal).toBeInstanceOf(ExecutionProfileError);
    expect(refusal.name).toBe("ExecutionProfileError");
    expect(refusal.reasonCode).toBe("AGENT_CREDENTIAL_REQUIRED");
  });
});

describe("the error record", () => {
  /** A five-character credential shaped as a SQLSTATE: upper-case hex with a digit, generated at run time. */
  const sqlstateShaped = () =>
    `${Math.floor(Math.random() * 10)}${crypto.randomUUID().replace(/-/g, "").slice(0, 4)}`.toUpperCase();
  const password = sqlstateShaped();
  const scrub = providerTextScrub(connectionWith({ password }), "any");

  function withSqlstate<T extends QueryError | RefusedBeforeSendError>(error: T, sqlstate: string): T {
    error.sqlstate = sqlstate;
    return error;
  }

  test("a credential in an error's SQLSTATE withholds the error, and the record holds no sqlState", () => {
    expect(password).toMatch(/^(?=[A-Z]*\d)[0-9A-Z]{5}$/);
    const error = withSqlstate(new QueryError("relation does not exist", "postgres"), password);
    expect(withholdProviderError(scrub, error)).toBeInstanceOf(ProviderTextWithheldError);
    const record = errorRecord(scrub, error);
    expect(record).toEqual({ kind: "query", code: "QUERY_ERROR", outcome: "unknown" });
    expect(JSON.stringify(record)).not.toContain(password);
  });

  test("a withheld error's record keeps the error's kind, code and outcome", async () => {
    const connectFailure = new ConnectionError(`could not connect with ${password}`, "postgres");
    const raised = await connectPhase(() => Promise.reject(connectFailure)).catch((error: unknown) => error);
    expect(errorRecord(scrub, raised)).toEqual({
      kind: "connection",
      code: "CONNECTION_ERROR",
      outcome: "not-sent",
    });
    const refused = withSqlstate(new RefusedBeforeSendError("refused", "postgres"), password);
    expect(errorRecord(scrub, refused)).toEqual({
      kind: "refused-before-send",
      code: "QUERY_ERROR",
      outcome: "not-sent",
    });
    const statementFailure = new ConnectionError(`lost ${password}`, "postgres");
    expect(errorRecord(scrub, statementFailure).outcome).toBe("unknown");
  });

  test("the error given is never changed", () => {
    for (const error of [
      withSqlstate(new QueryError("relation does not exist", "postgres"), password),
      withSqlstate(new RefusedBeforeSendError(`refused ${password}`, "postgres"), password),
    ]) {
      const keys = Object.keys(error);
      const own = keys.map((key) => (error as unknown as Record<string, unknown>)[key]);
      errorRecord(scrub, error);
      expect(Object.keys(error)).toEqual(keys);
      expect(keys.map((key) => (error as unknown as Record<string, unknown>)[key])).toEqual(own);
    }
  });

  test("a SQLSTATE with no credential form is kept", () => {
    let kept = sqlstateShaped();
    while (kept === password) kept = sqlstateShaped();
    const error = withSqlstate(new QueryError("relation does not exist", "postgres"), kept);
    expect(withholdProviderError(scrub, error)).toBe(error);
    expect(errorRecord(scrub, error)).toEqual({
      kind: "query",
      code: "QUERY_ERROR",
      sqlState: kept,
      outcome: "unknown",
    });
  });
});
