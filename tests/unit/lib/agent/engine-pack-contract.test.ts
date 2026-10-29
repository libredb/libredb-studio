import { describe, expect, test } from "bun:test";
import { AGENT_STATEMENT_LANGUAGE, workflowAvailability } from "@/lib/agent/agent-manifest";
import type { AgentCatalogKind, AgentCatalogRead, AgentCatalogSelector } from "@/lib/agent/composed-sql-primitives";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { verifyRunGoal } from "@/lib/agent/goal-verifier";
import { agentEnginePack } from "@/lib/agent/languages/engines/index";
import { runServerPack } from "@/lib/agent/languages/engines/server";
import type { AgentEnginePack, AgentEngineServerDialect } from "@/lib/agent/languages/pack";
import { REFERENCE_RECOMMENDATION_CARD } from "@/lib/agent/languages/server";
import { type AgentToolName, agentToolDefinition } from "@/lib/agent/tools";
import { AGENT_WORKFLOW_SENDS_STATEMENTS, type AgentRunWorkflowType } from "@/lib/agent/types";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { admitComposedStatement, agentQueryReadSqlInput } from "@/lib/db/operations/statement-guard";
import { DEFAULT_SQL_GRAMMAR, resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import type { DatabaseType } from "@/lib/types";
import { toolsNamedIn } from "../../../helpers/agent-tool-rules";

/**
 * The engine pack contract (#1821): what must hold for the pack an engine RESOLVES to, run over every engine that
 * speaks a statement language. It is written against the resolved pack rather than the family pack, so it keeps
 * holding, or fails by name, once an engine overrides a member its family supplies.
 *
 * What it does not repeat:
 * - the registry facts, member identity against the family pack, the dialect keyset, client and server parity,
 *   `statistics` implying `catalogRead`, the capture-kind bound and empty-overlay identity, which
 *   `engine-overlays.test.ts` holds;
 * - the per-language census of offers, arms, rules and statement reads, which `tool-offer-census.test.ts` holds.
 */

const ENGINES = (Object.keys(AGENT_STATEMENT_LANGUAGE) as DatabaseType[]).filter(
  (type) => AGENT_STATEMENT_LANGUAGE[type] !== null,
);

const WORKFLOWS = Object.keys(AGENT_WORKFLOW_BUDGETS) as AgentRunWorkflowType[];

/** Every workflow an agent-mode run opens on `type` with a variant, with that variant. */
const openVariants = (type: DatabaseType) =>
  WORKFLOWS.flatMap((workflow) => {
    const availability = workflowAvailability("agent", workflow, type);
    return availability.open && availability.variant !== null ? [{ workflow, variant: availability.variant }] : [];
  });

/** The tools whose arm is the engine's own, each held to the very schema it is offered with. */
const ARMED_TOOLS = ["inspect_schema", "inspect_plan", "profile_table"] as const;

/** Each dialect-bound tool, and the server dialect member that serves it. */
const DIALECT_MEMBER_OF: Readonly<Record<(typeof ARMED_TOOLS)[number], keyof AgentEngineServerDialect>> = {
  inspect_schema: "catalogRead",
  inspect_plan: "planEstimate",
  profile_table: "profileComposition",
};

/**
 * The offered dialect-bound tools whose member is unsupported, exactly. `profile_table` on DuckDB is offered and
 * refuses with `UNSUPPORTED_DIALECT` (B111). Held both ways, so the entry goes when DuckDB gains a composition.
 */
const UNSERVED_OFFERS: Readonly<Partial<Record<DatabaseType, readonly AgentToolName[]>>> = {
  duckdb: ["profile_table"],
  clickhouse: ["profile_table"],
  influxdb3: ["profile_table"],
  // The catalog-only workflows open on Elasticsearch and offer both; it composes no estimating plan and no profile.
  elasticsearch: ["inspect_plan", "profile_table"],
};

/**
 * The engines whose catalog read maps the engine's own rows into the catalog rows the core reads, exactly: an engine
 * whose catalog statement answers under column names no SELECT can rename. Held both ways, so an engine that gains a
 * mapper is named here and held to the mapper contract below.
 */
const MAPPED_CATALOG_READS: readonly DatabaseType[] = ["elasticsearch"];

const CATALOG_KINDS: readonly AgentCatalogKind[] = ["columns", "relations", "indexes", "statistics"];

/** Engine answers no mapper may throw on: none, an empty row, and a row of names it never asked for. */
const MAPPER_CORPUS: readonly (readonly Record<string, unknown>[])[] = [[], [{}], [{ unexpected: 1, other: null }]];

/** A row set no mapper can write into: the rows and the array are frozen, so a write throws. */
const frozenRows = (rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] =>
  Object.freeze(rows.map((row) => Object.freeze({ ...row })));

/**
 * What a catalog read's row mapper gets wrong over every kind and the corpus; empty when it holds. A mapper is pure:
 * it never throws on an engine answer, never writes into it, answers the same rows twice, keeps no row it was not given
 * (the budget was spent on the engine's rows), and keys every row by the columns it declares, which are named and
 * distinct like any `QueryResult`'s.
 */
function catalogMapperViolations(mapRows: NonNullable<AgentCatalogRead["mapRows"]>): string[] {
  const violations: string[] = [];
  for (const kind of CATALOG_KINDS) {
    for (const rows of MAPPER_CORPUS) {
      const where = `${kind} ${JSON.stringify(rows)}`;
      let first: ReturnType<typeof mapRows>;
      try {
        first = mapRows(kind, frozenRows(rows));
      } catch (error) {
        violations.push(`${where}: throws ${(error as Error).message}`);
        continue;
      }
      if (first.fields.length === 0 || first.fields.some((field) => field.length === 0)) {
        violations.push(`${where}: an unnamed column`);
      }
      if (new Set(first.fields).size !== first.fields.length) violations.push(`${where}: a repeated column`);
      if (first.rows.length > rows.length) violations.push(`${where}: more rows than it was given`);
      for (const row of first.rows) {
        for (const key of Object.keys(row)) {
          if (!first.fields.includes(key)) violations.push(`${where}: a cell under an undeclared column ${key}`);
        }
      }
      if (JSON.stringify(mapRows(kind, frozenRows(rows))) !== JSON.stringify(first)) {
        violations.push(`${where}: a second call answers differently`);
      }
    }
  }
  return violations;
}

describe("the catalog row mapper contract", () => {
  test("holds for a mapper that renames the engine's own columns", () => {
    const renaming: NonNullable<AgentCatalogRead["mapRows"]> = (_kind, rows) => ({
      fields: ["table_name", "column_name"],
      rows: rows.map((row) => ({ table_name: row.TABLE_NAME ?? null, column_name: row.COLUMN_NAME ?? null })),
    });
    expect(catalogMapperViolations(renaming)).toEqual([]);
  });

  test("names each way a mapper can break it", () => {
    let calls = 0;
    const broken: NonNullable<AgentCatalogRead["mapRows"]> = (kind, rows) => {
      calls += 1;
      if (kind === "statistics") throw new Error("no statistics");
      if (kind === "indexes" && rows.length > 0) (rows[0] as Record<string, unknown>).written = true;
      return {
        fields: kind === "relations" ? ["", "name", "name"] : ["name"],
        rows: [...rows.map(() => ({ name: "t", extra: calls })), { name: "invented" }],
      };
    };
    const violations = catalogMapperViolations(broken);
    expect(violations).toContain("statistics []: throws no statistics");
    expect(violations.some((violation) => violation.startsWith("indexes [{}]: throws"))).toBe(true);
    expect(violations).toContain("relations []: an unnamed column");
    expect(violations).toContain("relations []: a repeated column");
    expect(violations).toContain("columns []: more rows than it was given");
    expect(violations).toContain("columns [{}]: a cell under an undeclared column extra");
    expect(violations).toContain("columns [{}]: a second call answers differently");
  });
});

test("the mapped catalog reads name only engines that speak a language", () => {
  for (const type of MAPPED_CATALOG_READS) expect(ENGINES).toContain(type);
});

/**
 * The engines whose catalog read is a command rather than a SELECT (`AgentCatalogRead.commandShaped`), exactly. Held
 * both ways, so an engine that declares it is named here and held to the composer contract below.
 */
const COMMAND_CATALOG_READS: readonly DatabaseType[] = ["elasticsearch"];

/** A name no composer writes on its own, so where it shows in a composed statement, a selector put it there. */
const SENTINEL_NAME = "zq_sentinel_name";

/**
 * Names a composer is handed: the sentinel, and for each delimiter a grammar reads as quoting (single and double
 * quotes, backticks, brackets) three ways out of it: one that ends the statement or opens a comment, one that closes
 * the quote and goes on in plain words, and one that keeps the sentinel quoted and puts plain words after the quote.
 * The last two carry no terminator and no comment, so only the quoting check below catches a composer that lets them
 * through.
 */
const COMMAND_NAMES: readonly string[] = [
  SENTINEL_NAME,
  `${SENTINEL_NAME}'; SHOW TABLES --`,
  `${SENTINEL_NAME}"; SHOW TABLES /*`,
  `${SENTINEL_NAME}\`; SHOW TABLES --`,
  `${SENTINEL_NAME}]; SHOW TABLES /*`,
  ...[
    ["'", "'"],
    ['"', '"'],
    ["`", "`"],
    ["[", "]"],
  ].flatMap(([open, close]) => [`x${close} ${SENTINEL_NAME} ${open}y`, `${SENTINEL_NAME}${close} IN ${open}other`]),
];

/** A quoted run's content, its doubled closers undoubled, or null for a run not quoted that way. */
function decodedQuote(run: string): string | null {
  const close = { "'": "'", '"': '"', "`": "`", "[": "]" }[run[0] ?? ""];
  if (close === undefined || run.length < 2 || !run.endsWith(close)) return null;
  const body = run.slice(1, -1);
  return body.replaceAll(close + close, "").includes(close) ? null : body.replaceAll(close + close, close);
}

/**
 * What a composed statement's quoting gets wrong for `name`, read with `grammar`: the sentinel shows outside every
 * literal and quoted name (in code, a comment or a subscript), or a literal or quoted name holding it is not exactly
 * `name` once its doubled delimiters are undone, so words outside the quote went with it.
 */
function quotingViolations(sql: string, name: string, grammar: SqlGrammar): string[] {
  const violations = new Set<string>();
  let unquoted = "";
  let i = 0;
  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span === null) {
      unquoted += sql[i];
      i++;
      continue;
    }
    const run = sql.slice(i, span.end);
    if (!span.terminated) violations.add("a run its grammar never closes");
    if (span.kind !== "string" && span.kind !== "quoted-identifier") unquoted += run;
    else if (run.includes(SENTINEL_NAME) && decodedQuote(run) !== name) {
      violations.add("a quoted name that is not the name it was given");
    }
    i = span.end;
  }
  if (unquoted.includes(SENTINEL_NAME)) violations.add("a name it does not quote");
  return [...violations];
}

/**
 * What a command catalog read's composers get wrong over every kind and name; empty when they hold. Each statement it
 * composes is one the fence admits by identity (one determinate statement, no comment, no forbidden word), and every
 * name it takes sits inside one literal or quoted name that holds exactly that name, read with each of `grammars`. A
 * composer that refuses a name, by throwing, holds: a refusal sends nothing.
 *
 * The fence reads quoting with `DEFAULT_SQL_GRAMMAR`, where brackets quote a name, and an engine reads it with its own
 * row, where they may be a subscript, so a declaring engine is held under both (`resolveSqlGrammar`).
 */
function commandComposerViolations(
  compose: AgentCatalogRead["compose"],
  grammars: readonly SqlGrammar[] = [DEFAULT_SQL_GRAMMAR],
): string[] {
  const violations = new Set<string>();
  for (const kind of CATALOG_KINDS) {
    for (const name of COMMAND_NAMES) {
      for (const selector of [
        { kind, table: name },
        { kind, schema: name },
        { kind, schema: name, table: name },
      ]) {
        let sql: string;
        try {
          sql = compose[kind](selector);
        } catch {
          continue;
        }
        const where = `${kind} ${JSON.stringify(selector)}`;
        if (!agentQueryReadSqlInput.safeParse({ sql, composed: admitComposedStatement(sql) }).success) {
          violations.add(`${where}: not one statement the fence admits by identity`);
        }
        for (const grammar of grammars) {
          for (const violation of quotingViolations(sql, name, grammar)) violations.add(`${where}: ${violation}`);
        }
      }
    }
  }
  return [...violations];
}

/** One composer for every kind. */
const composingAll = (composer: (selector: AgentCatalogSelector) => string): AgentCatalogRead["compose"] => ({
  columns: composer,
  relations: composer,
  indexes: composer,
  statistics: composer,
});

/** The name quoted as an identifier, its own quotes doubled. */
const quotedName = (name: string): string => `"${name.replaceAll('"', '""')}"`;

describe("the command catalog read contract", () => {
  test("holds for composers that quote every name, or refuse it", () => {
    const quoting = composingAll((selector) =>
      selector.table === undefined ? "SHOW TABLES" : `SHOW COLUMNS FROM ${quotedName(selector.table)}`,
    );
    expect(commandComposerViolations(quoting)).toEqual([]);
    const refusing = composingAll(() => {
      throw new Error("not a name this engine takes");
    });
    expect(commandComposerViolations(refusing)).toEqual([]);
  });

  test("names each way a composer can break it", () => {
    const unquoting = composingAll((selector) => `SHOW COLUMNS FROM ${selector.table ?? selector.schema}`);
    expect(commandComposerViolations(unquoting)).toContain(
      `columns {"kind":"columns","table":"${SENTINEL_NAME}"}: a name it does not quote`,
    );
    expect(commandComposerViolations(unquoting)).toContain(
      `columns {"kind":"columns","table":"${SENTINEL_NAME}'; SHOW TABLES --"}: not one statement the fence admits by identity`,
    );
    const commented = composingAll(() => "SHOW TABLES /* the catalog */");
    expect(commandComposerViolations(commented)).toContain(
      `relations {"kind":"relations","schema":"${SENTINEL_NAME}"}: not one statement the fence admits by identity`,
    );
    const twoStatements = composingAll(() => "SHOW TABLES; SHOW COLUMNS");
    expect(commandComposerViolations(twoStatements)).toContain(
      `indexes {"kind":"indexes","table":"${SENTINEL_NAME}"}: not one statement the fence admits by identity`,
    );
  });

  // A composer that wraps a name in a delimiter and never escapes it, one per delimiter the grammar reads as quoting.
  test.each([
    ["backticks", "`", "`"],
    ["brackets", "[", "]"],
    ["double quotes", '"', '"'],
    ["single quotes", "'", "'"],
  ])("names a composer that wraps a name in %s without escaping it", (_label, open, close) => {
    const unescaped = composingAll(
      (selector) => `SHOW COLUMNS FROM ${open}${selector.table ?? selector.schema}${close}`,
    );
    const violations = commandComposerViolations(unescaped);
    // The quote closed early and the name goes on in plain words, no terminator and no comment.
    expect(violations).toContain(
      `columns ${JSON.stringify({ kind: "columns", table: `x${close} ${SENTINEL_NAME} ${open}y` })}: a name it does not quote`,
    );
    // The name stays quoted, and words of the model's choosing follow the quote.
    expect(violations).toContain(
      `columns ${JSON.stringify({ kind: "columns", table: `${SENTINEL_NAME}${close} IN ${open}other` })}: a quoted name that is not the name it was given`,
    );
  });

  test("holds for composers that escape their own delimiter, whichever it is", () => {
    for (const [open, close] of [
      ["`", "`"],
      ["[", "]"],
      ['"', '"'],
      ["'", "'"],
    ]) {
      const escaping = composingAll(
        (selector) => `SHOW COLUMNS FROM ${open}${(selector.table ?? "t").replaceAll(close, close + close)}${close}`,
      );
      expect(commandComposerViolations(escaping)).toEqual([]);
    }
  });

  test("reads a name with the grammar it is given, so brackets an engine reads as a subscript quote nothing", () => {
    const bracketing = composingAll(
      (selector) => `SHOW COLUMNS FROM [${(selector.table ?? "t").replaceAll("]", "]]")}]`,
    );
    const subscripting: SqlGrammar = { ...DEFAULT_SQL_GRAMMAR, bracket: "subscript" };
    expect(commandComposerViolations(bracketing, [DEFAULT_SQL_GRAMMAR])).toEqual([]);
    expect(commandComposerViolations(bracketing, [DEFAULT_SQL_GRAMMAR, subscripting])).toContain(
      `columns {"kind":"columns","table":"${SENTINEL_NAME}"}: a name it does not quote`,
    );
  });
});

test("the command catalog reads name only engines that speak a language", () => {
  for (const type of COMMAND_CATALOG_READS) expect(ENGINES).toContain(type);
});

/** Inputs no adapter may throw on: a statement, the empty one, and every non-string a ledger or a model can send. */
const ADAPTER_CORPUS: readonly unknown[] = ["", "SELECT 1", {}, { a: 1 }, null, 42, []];

const REGISTERED_OPERATIONS = new Set(createCanonicalOperationRegistry().registeredIds());

test("the engines are every type with a statement language, and the execution engines are among them", () => {
  // Read from the manifest, never restated: an engine that gains a language joins every case below.
  expect(ENGINES.length).toBeGreaterThan(0);
  // A subset only. A type may speak a language and execute nothing; the two lists are not the same claim.
  for (const type of AGENT_EXECUTION_ENGINES) expect(ENGINES).toContain(type);
});

test.each([...AGENT_EXECUTION_ENGINES])(
  "%s opens a workflow that sends a statement, so agent mode executing there is true",
  (type) => {
    const sending = openVariants(type).filter(({ workflow }) => AGENT_WORKFLOW_SENDS_STATEMENTS[workflow]);
    expect(sending.length).toBeGreaterThan(0);
  },
);

test("the unserved offers name only engines that speak a language", () => {
  for (const type of Object.keys(UNSERVED_OFFERS)) expect(ENGINES).toContain(type as DatabaseType);
});

describe.each(ENGINES)("%s", (type) => {
  const pack: AgentEnginePack = agentEnginePack(type);

  test("is its language's pack, frozen, and is what the run resolver reads", () => {
    expect<string | null>(pack.id).toBe(AGENT_STATEMENT_LANGUAGE[type]);
    for (const frozen of [pack, pack.client, pack.server, pack.execution, pack.server.adapter, pack.client.posture]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    const run = runServerPack(pack.id, type);
    expect(Object.keys(run).sort()).toEqual(Object.keys(pack.server).sort());
    for (const member of Object.keys(pack.server) as (keyof typeof pack.server)[]) {
      expect(run[member], member).toBe(pack.server[member]);
    }
  });

  test("every workflow it opens is told its rules, offered resolvable tools, armed and judged", () => {
    const opened = openVariants(type);
    expect(opened.length).toBeGreaterThan(0);
    const arms: Partial<Record<AgentToolName, { readonly inputSchema: unknown }>> = pack.execution.arms;
    for (const { workflow, variant } of opened) {
      const rules = pack.server.workflowToolRules[workflow];
      if (rules === undefined) throw new Error(`${type} opens ${workflow} with no rules for it`);
      for (const tool of toolsNamedIn(rules)) expect(variant.tools, `${workflow} names ${tool}`).toContain(tool);
      for (const tool of [...variant.tools, ...variant.narrowedExtras]) {
        expect(agentToolDefinition(pack.id, workflow, tool).name, `${workflow} ${tool}`).toBe(tool);
      }
      for (const tool of ARMED_TOOLS) {
        if (!variant.tools.includes(tool)) continue;
        const arm = arms[tool];
        if (arm === undefined) throw new Error(`${type} ${workflow} offers ${tool} with no arm`);
        expect(arm.inputSchema, `${workflow} ${tool}`).toBe(agentToolDefinition(pack.id, workflow, tool).inputSchema);
      }
      const verdict = verifyRunGoal({
        mode: "agent",
        workflowType: workflow,
        status: "succeeded",
        events: [],
        statementLanguage: pack.id,
        verifier: variant.verifier,
      });
      expect(verdict.verifier).toBe(variant.verifier);
    }
  });

  test("an offered dialect-bound tool has its member, except the exact unserved offers", () => {
    const dialect = pack.server.dialect;
    const unserved = new Set<AgentToolName>();
    if (dialect !== undefined) {
      for (const { variant } of openVariants(type)) {
        for (const tool of ARMED_TOOLS) {
          if (variant.tools.includes(tool) && dialect[DIALECT_MEMBER_OF[tool]] === "unsupported") unserved.add(tool);
        }
      }
    }
    expect([...unserved].sort()).toEqual([...(UNSERVED_OFFERS[type] ?? [])].sort());
  });

  test("declares a catalog row mapper exactly where it is listed, and that mapper holds the contract", () => {
    const catalogRead = pack.server.dialect?.catalogRead;
    const mapRows = catalogRead === undefined || catalogRead === "unsupported" ? undefined : catalogRead.mapRows;
    expect(mapRows !== undefined).toBe(MAPPED_CATALOG_READS.includes(type));
    if (mapRows !== undefined) expect(catalogMapperViolations(mapRows)).toEqual([]);
  });

  test("declares its catalog read a command exactly where it is listed, and its composers hold the contract", () => {
    const catalogRead = pack.server.dialect?.catalogRead;
    const commandShaped =
      catalogRead !== undefined && catalogRead !== "unsupported" && catalogRead.commandShaped === true;
    expect(commandShaped).toBe(COMMAND_CATALOG_READS.includes(type));
    if (commandShaped) {
      expect(commandComposerViolations(catalogRead.compose, [DEFAULT_SQL_GRAMMAR, resolveSqlGrammar(type)])).toEqual(
        [],
      );
    }
  });

  test("its adapter is total over the corpus", () => {
    const { adapter } = pack.server;
    for (const raw of ADAPTER_CORPUS) {
      const canonical = adapter.canonicalize(raw);
      expect(canonical === null || typeof canonical === "string", JSON.stringify(raw)).toBe(true);
    }
    for (const text of ADAPTER_CORPUS.filter((raw): raw is string => typeof raw === "string")) {
      expect(adapter.fingerprint(text)).toBe(adapter.fingerprint(text));
      expect(adapter.fingerprint(text).length, JSON.stringify(text)).toBeGreaterThan(0);
      expect(adapter.rowCapAdvice(text, "500").length, JSON.stringify(text)).toBeGreaterThan(0);
    }
  });

  test("its read operation and its plan operation are registered operations", () => {
    expect(REGISTERED_OPERATIONS.has(pack.server.adapter.readOperation)).toBe(true);
    const plan = pack.client.planEstimateOperation;
    if (plan !== null) expect(REGISTERED_OPERATIONS.has(plan)).toBe(true);
  });

  test("says what it is under every workflow's statement bounds", () => {
    expect(pack.server.answerNotADataRead.length).toBeGreaterThan(0);
    expect(pack.server.grounding.omissionAdvice.length).toBeGreaterThan(0);
    for (const workflow of WORKFLOWS) {
      const bounds = AGENT_WORKFLOW_BUDGETS[workflow].policy.budgets;
      for (const posture of [pack.client.posture.reads(bounds), pack.client.posture.widened(bounds)]) {
        for (const field of [posture.headline, posture.qualifier, posture.title, posture.body]) {
          expect(field.length, workflow).toBeGreaterThan(0);
        }
      }
      expect(pack.client.posture.handoverTerms(bounds).length, workflow).toBeGreaterThan(0);
    }
  });

  test("its card is frozen, and every recommend_change it offers is read by the card that owns its schema", () => {
    // The schema itself is a zod object, which is not frozen; the card that holds it is. `recommendChangeTool` parses
    // with the family's card when the offered schema is that card's, with the reference card when it is that one's,
    // and throws for a schema neither owns, so this holds every shipped offer to one of the two before a run does.
    const card = pack.server.recommendationCard;
    if (card !== undefined) expect(Object.isFrozen(card)).toBe(true);
    const owners: readonly unknown[] = [card?.inputSchema, REFERENCE_RECOMMENDATION_CARD.inputSchema];
    for (const { workflow, variant } of openVariants(type)) {
      if (!variant.tools.includes("recommend_change")) continue;
      expect(owners, workflow).toContain(agentToolDefinition(pack.id, workflow, "recommend_change").inputSchema);
    }
  });
});
