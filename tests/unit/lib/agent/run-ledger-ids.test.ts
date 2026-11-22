import { describe, expect, test } from "bun:test";
import { type AgentStatementLanguageId, persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import { type AgentGoalVerifierId, hasGoalRule, RETIRED_GOAL_VERIFIERS } from "@/lib/agent/goal-verifier";
import { isAgentStatementLanguage, RETIRED_STATEMENT_LANGUAGES } from "@/lib/agent/languages/client";
import { type AgentRunHeaderVocabulary, RUN_HEADER_VOCABULARY, runHeaderRefusal } from "@/lib/agent/run-ledger-ids";
import { AGENT_WORKFLOW_PRESENTS_ANSWER, type AgentRunMode, type AgentRunWorkflowType } from "@/lib/agent/types";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";

/**
 * A run header persists three ids this build resolves (FND-1): the statement language the run is written in, the
 * workflow it was opened for, and the goal rule it is judged by. An agent-mode header also needs its workflow's variant
 * on its language, so the pair of the two is resolved too. These tests pin the one check of all of them, and the census
 * that keeps every language and verifier a header can carry either live or retired by name, and every agent-mode
 * language and workflow pair a header can carry still resolvable.
 */

/* Total over the language ids, so the compiler fails here when a language is added without a row. */
const LIVE_LANGUAGES: Readonly<Record<AgentStatementLanguageId, true>> = {
  sql: true,
  kubectl: true,
  mongo: true,
  libredbkv: true,
  influxql: true,
  weaviateapi: true,
  qdrantapi: true,
  cypher: true,
  milvusrpc: true,
  rediscli: true,
  etcdctl: true,
  oxiacli: true,
  rabbitread: true,
  kafkaread: true,
  s3api: true,
  fsquery: true,
  snmpget: true,
  netconfrpc: true,
  modbusread: true,
  promql: true,
  opcuaread: true,
  mtconnectread: true,
  mqttread: true,
  sparkplugread: true,
};

/** The verifiers a run can still be judged by: every id with a rule. */
const JUDGED_VERIFIERS: readonly AgentGoalVerifierId[] = [
  "agent-investigation.1",
  "agent-query-optimization.3",
  "agent-database-assessment.1",
  "agent-operations.2",
  "agent-data-analysis.1",
  "agent-query-optimization-kubectl.1",
  "agent-database-assessment-kubectl.1",
  "agent-query-optimization-mongo.1",
];

const RETIRED_VERIFIERS: readonly AgentGoalVerifierId[] = [
  "agent-query-optimization.1",
  "agent-query-optimization.2",
  "agent-operations.1",
];

/**
 * Every statement language a header has ever been able to carry, measured from the history of `persistedRunFacts`
 * (every live id but `sql`, which is persisted as absence). Frozen on purpose: an id leaves this list never, and an id
 * that leaves the live set has to move to `RETIRED_STATEMENT_LANGUAGES`, or ledgers that carry it would read as unknown.
 */
const PERSISTED_STATEMENT_LANGUAGES: readonly string[] = [
  "kubectl",
  "mongo",
  "libredbkv",
  "influxql",
  "weaviateapi",
  "qdrantapi",
  "cypher",
  "milvusrpc",
  "rediscli",
  "etcdctl",
  "oxiacli",
  "rabbitread",
  "kafkaread",
  "s3api",
  "fsquery",
  "snmpget",
  "netconfrpc",
  "modbusread",
  "promql",
  "opcuaread",
  "mtconnectread",
  "mqttread",
  "sparkplugread",
];

/**
 * Every goal verifier a header has ever been able to carry, measured the same way (the SQL workflow's verifier is
 * persisted as absence). Frozen for the same reason: a persisted verifier keeps its rule, and a changed rule takes a
 * new id, appended here.
 */
const PERSISTED_GOAL_VERIFIERS: readonly string[] = [
  "agent-query-optimization-kubectl.1",
  "agent-database-assessment-kubectl.1",
  "agent-query-optimization-mongo.1",
];

/**
 * Every agent-mode pair of statement language and workflow a header has ever been able to carry, measured the same way
 * (`sql` stands for the absent language). Frozen and append-only for the same reason: a header that names a pair is
 * read only while the pair has a variant, so a variant a header can name is never dropped.
 */
const PERSISTED_AGENT_PAIRS: readonly (readonly [language: string, workflow: string])[] = [
  ["cypher", "data-analysis"],
  ["cypher", "investigation"],
  ["cypher", "operations"],
  ["etcdctl", "investigation"],
  ["etcdctl", "operations"],
  ["fsquery", "investigation"],
  ["fsquery", "operations"],
  ["influxql", "data-analysis"],
  ["influxql", "investigation"],
  ["influxql", "operations"],
  ["kafkaread", "investigation"],
  ["kafkaread", "operations"],
  ["kubectl", "data-analysis"],
  ["kubectl", "database-assessment"],
  ["kubectl", "investigation"],
  ["kubectl", "operations"],
  ["kubectl", "query-optimization"],
  ["libredbkv", "data-analysis"],
  ["libredbkv", "investigation"],
  ["libredbkv", "operations"],
  ["milvusrpc", "investigation"],
  ["milvusrpc", "operations"],
  ["modbusread", "investigation"],
  ["modbusread", "operations"],
  ["mongo", "data-analysis"],
  ["mongo", "database-assessment"],
  ["mongo", "investigation"],
  ["mongo", "operations"],
  ["mongo", "query-optimization"],
  ["mqttread", "investigation"],
  ["mqttread", "operations"],
  ["mtconnectread", "investigation"],
  ["mtconnectread", "operations"],
  ["netconfrpc", "investigation"],
  ["netconfrpc", "operations"],
  ["opcuaread", "investigation"],
  ["opcuaread", "operations"],
  ["oxiacli", "investigation"],
  ["oxiacli", "operations"],
  ["promql", "data-analysis"],
  ["promql", "investigation"],
  ["promql", "operations"],
  ["qdrantapi", "investigation"],
  ["qdrantapi", "operations"],
  ["rabbitread", "investigation"],
  ["rabbitread", "operations"],
  ["rediscli", "investigation"],
  ["rediscli", "operations"],
  ["s3api", "investigation"],
  ["s3api", "operations"],
  ["snmpget", "investigation"],
  ["snmpget", "operations"],
  ["sparkplugread", "investigation"],
  ["sparkplugread", "operations"],
  ["sql", "data-analysis"],
  ["sql", "database-assessment"],
  ["sql", "investigation"],
  ["sql", "operations"],
  ["sql", "query-optimization"],
  ["weaviateapi", "investigation"],
  ["weaviateapi", "operations"],
];

function pairKey(language: string, workflow: string): string {
  return `${language}/${workflow}`;
}

/**
 * What `persistedRunFacts` can write today, through the availability production opens a run under: every shipped
 * engine, every workflow, both modes, keeping only the availabilities that open.
 */
function persistableIds(): {
  readonly languages: ReadonlySet<string>;
  readonly verifiers: ReadonlySet<string>;
  readonly agentPairs: ReadonlySet<string>;
} {
  const languages = new Set<string>();
  const verifiers = new Set<string>();
  const agentPairs = new Set<string>();
  const workflows = Object.keys(AGENT_WORKFLOW_PRESENTS_ANSWER) as AgentRunWorkflowType[];
  for (const type of SHIPPED_DATABASE_TYPES) {
    for (const mode of ["agent", "planning"] as const satisfies readonly AgentRunMode[]) {
      for (const workflow of workflows) {
        const availability = workflowAvailability(mode, workflow, type);
        if (!availability.open) continue;
        const facts = persistedRunFacts(mode, workflow, availability);
        if (facts.statementLanguage !== undefined) languages.add(facts.statementLanguage);
        if (facts.verifier !== undefined) verifiers.add(facts.verifier);
        if (mode === "agent") agentPairs.add(pairKey(facts.statementLanguage ?? "sql", workflow));
      }
    }
  }
  return { languages, verifiers, agentPairs };
}

const AGENT = { mode: "agent" } as const;

describe("runHeaderRefusal", () => {
  test("a header that names neither id is readable", () => {
    expect(runHeaderRefusal(AGENT)).toBeNull();
  });

  test.each(Object.keys(LIVE_LANGUAGES))("every statement language this build holds is readable (%s)", (id) => {
    expect(runHeaderRefusal({ ...AGENT, statementLanguage: id })).toBeNull();
  });

  test.each(JUDGED_VERIFIERS)("every verifier goalOf judges is readable (%s)", (id) => {
    expect(runHeaderRefusal({ ...AGENT, verifier: id })).toBeNull();
  });

  test.each([
    ["cobol", '"cobol"'],
    ["Mongo", '"Mongo"'],
    [" mongo", '" mongo"'],
    ["", '""'],
    ["constructor", '"constructor"'],
    ["__proto__", '"__proto__"'],
    ["toString", '"toString"'],
  ])("a statement language this build does not hold is refused as unknown, by its quoted id (%p)", (id, quoted) => {
    expect(runHeaderRefusal({ ...AGENT, statementLanguage: id })).toEqual({
      field: "statementLanguage",
      reason: "unknown",
      id,
      named: `the statement language ${quoted}`,
      sentence: `This run was recorded in the statement language ${quoted}, which this LibreDB Studio does not have. The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.`,
    });
  });

  test("a statement language the vocabulary holds as retired is refused as retired", () => {
    const vocabulary: AgentRunHeaderVocabulary = {
      ...RUN_HEADER_VOCABULARY,
      isLanguage: (id) => id !== "kubectl" && RUN_HEADER_VOCABULARY.isLanguage(id),
      retiredLanguages: new Set(["kubectl"]),
    };
    expect(runHeaderRefusal({ ...AGENT, statementLanguage: "kubectl" }, vocabulary)).toEqual({
      field: "statementLanguage",
      reason: "retired",
      id: "kubectl",
      named: 'the statement language "kubectl"',
      sentence:
        'This run was recorded in the statement language "kubectl", which this LibreDB Studio has retired. The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.',
    });
  });

  test.each(RETIRED_VERIFIERS)("each retired verifier is refused as retired (%s)", (id) => {
    expect(runHeaderRefusal({ ...AGENT, verifier: id })).toEqual({
      field: "verifier",
      reason: "retired",
      id,
      named: `the goal rule "${id}"`,
      sentence: `This run is judged by the goal rule "${id}", which this LibreDB Studio has retired. The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.`,
    });
  });

  test.each(["agent-nonexistent.1", "agent-planning.1", "toString"])(
    "a verifier no rule judges is refused as unknown on an agent-mode header (%s)",
    (id) => {
      expect(runHeaderRefusal({ ...AGENT, verifier: id })).toEqual({
        field: "verifier",
        reason: "unknown",
        id,
        named: `the goal rule "${id}"`,
        sentence: `This run is judged by the goal rule "${id}", which this LibreDB Studio does not have. The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.`,
      });
    },
  );

  test.each(["agent-planning.1", "agent-planning.2", "agent-nonexistent.1"])(
    "a planning header's verifier is not checked, because a plan is judged by the planning rule whatever it names (%s)",
    (id) => {
      expect(runHeaderRefusal({ mode: "planning", verifier: id })).toBeNull();
    },
  );

  test.each([
    ["agent", "rediscli", "data-analysis"],
    ["agent", "qdrantapi", "query-optimization"],
    ["agent", "libredbkv", "database-assessment"],
  ] as const)(
    "in %s mode, a header whose workflow this build holds no variant of for its language is refused as unknown (%s, %s)",
    (mode, language, workflow) => {
      expect(runHeaderRefusal({ mode, statementLanguage: language, workflowType: workflow })).toEqual({
        field: "workflowType",
        reason: "unknown",
        id: workflow,
        named: `the workflow "${workflow}" in the statement language "${language}"`,
        sentence: `This run is for the workflow "${workflow}" in the statement language "${language}", which this LibreDB Studio does not have. The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.`,
      });
    },
  );

  test.each(["agent", "planning"] as const)(
    "in %s mode, a header whose workflow this build does not hold is refused as unknown, whatever its language",
    (mode) => {
      expect(runHeaderRefusal({ mode, workflowType: "schema-review" })).toEqual({
        field: "workflowType",
        reason: "unknown",
        id: "schema-review",
        named: 'the workflow "schema-review"',
        sentence:
          'This run is for the workflow "schema-review", which this LibreDB Studio does not have. The run is kept as it was, and this LibreDB Studio does not open, drive, stop or replay it.',
      });
    },
  );

  test.each(["toString", "constructor", ""])("a workflow that is a prototype key or empty is unknown (%p)", (id) => {
    expect(runHeaderRefusal({ ...AGENT, workflowType: id })?.field).toBe("workflowType");
  });

  test("a planning header whose language has no variant of a workflow this build holds is readable", () => {
    expect(
      runHeaderRefusal({ mode: "planning", statementLanguage: "rediscli", workflowType: "data-analysis" }),
    ).toBeNull();
  });

  test("an agent-mode header with no workflow reads as the default workflow, which every language holds", () => {
    expect(runHeaderRefusal({ ...AGENT, statementLanguage: "rediscli" })).toBeNull();
  });

  test("an agent-mode header whose verifier is present still needs its variant", () => {
    expect(
      runHeaderRefusal({
        ...AGENT,
        statementLanguage: "rediscli",
        workflowType: "data-analysis",
        verifier: "agent-data-analysis.1",
      })?.field,
    ).toBe("workflowType");
  });

  test("the language is named before the workflow, and the workflow before the verifier", () => {
    expect(runHeaderRefusal({ ...AGENT, statementLanguage: "cobol", workflowType: "schema-review" })?.field).toBe(
      "statementLanguage",
    );
    expect(runHeaderRefusal({ ...AGENT, workflowType: "schema-review", verifier: "agent-nonexistent.1" })?.field).toBe(
      "workflowType",
    );
  });

  test("the language is named first when both are refused", () => {
    expect(runHeaderRefusal({ ...AGENT, statementLanguage: "cobol", verifier: "agent-nonexistent.1" })).toMatchObject({
      field: "statementLanguage",
      id: "cobol",
    });
  });

  test.each([
    ["a newline", "co\nbol", '"co\\nbol"'],
    ["U+2028", "co\u2028bol", '"co\\u2028bol"'],
  ])("the sentence quotes %s escaped, on one line", (_name, id, quoted) => {
    const refusal = runHeaderRefusal({ ...AGENT, statementLanguage: id });
    expect(refusal?.id).toBe(id);
    expect(refusal?.sentence).toContain(`statement language ${quoted}, which`);
    expect(refusal?.sentence).not.toMatch(/[\n\u2028]/);
  });
});

describe("the ids a run header can carry", () => {
  const persistable = persistableIds();

  test("every statement language persistedRunFacts can write is on the persisted list", () => {
    const missing = [...persistable.languages].filter((id) => !PERSISTED_STATEMENT_LANGUAGES.includes(id));
    // A new statement language is appended to PERSISTED_STATEMENT_LANGUAGES, so the day it is removed the census
    // asks for its tombstone in RETIRED_STATEMENT_LANGUAGES.
    expect(missing).toEqual([]);
  });

  test("every persisted statement language is live or retired", () => {
    const lost = PERSISTED_STATEMENT_LANGUAGES.filter(
      (id) => !isAgentStatementLanguage(id) && !RETIRED_STATEMENT_LANGUAGES.has(id),
    );
    // A language whose pack is removed keeps its id in RETIRED_STATEMENT_LANGUAGES, so its ledgers are named as retired.
    expect(lost).toEqual([]);
  });

  test("every verifier persistedRunFacts can write is on the persisted list", () => {
    const missing = [...persistable.verifiers].filter((id) => !PERSISTED_GOAL_VERIFIERS.includes(id));
    // A new family verifier is appended to PERSISTED_GOAL_VERIFIERS, which then holds it to its rule.
    expect(missing).toEqual([]);
  });

  test("a persisted verifier keeps its rule and is never retired", () => {
    const lost = PERSISTED_GOAL_VERIFIERS.filter((id) => !hasGoalRule(id) || RETIRED_GOAL_VERIFIERS.has(id as never));
    // A verifier a header can carry keeps its rule; a changed rule takes a new id.
    expect(lost).toEqual([]);
  });

  test("the retired verifiers are the three retired before any header carried a verifier, and none has a rule", () => {
    expect([...RETIRED_GOAL_VERIFIERS].sort()).toEqual([...RETIRED_VERIFIERS].sort());
    expect(RETIRED_VERIFIERS.filter((id) => hasGoalRule(id))).toEqual([]);
  });

  test("every agent-mode pair persistedRunFacts can write is on the persisted list", () => {
    const listed = new Set(PERSISTED_AGENT_PAIRS.map(([language, workflow]) => pairKey(language, workflow)));
    const missing = [...persistable.agentPairs].filter((pair) => !listed.has(pair));
    // A new variant is appended to PERSISTED_AGENT_PAIRS, which then holds the header that names it readable.
    expect(missing).toEqual([]);
  });

  test("every persisted agent-mode pair is still read by the header check", () => {
    const lost = PERSISTED_AGENT_PAIRS.filter(
      ([language, workflow]) =>
        runHeaderRefusal({
          mode: "agent",
          ...(language === "sql" ? {} : { statementLanguage: language }),
          workflowType: workflow,
        }) !== null,
    ).map(([language, workflow]) => pairKey(language, workflow));
    // A variant a header can name keeps existing; dropping it would refuse every ledger that names the pair.
    expect(lost).toEqual([]);
  });

  test("no id is both live and retired", () => {
    expect([...RETIRED_STATEMENT_LANGUAGES].filter((id) => isAgentStatementLanguage(id))).toEqual([]);
    expect([...RETIRED_GOAL_VERIFIERS].filter((id) => hasGoalRule(id))).toEqual([]);
  });

  test("no statement language has been retired yet", () => {
    // Pins today's set, so the first retirement is a visible change here; a PR that retires a language updates this.
    expect(RETIRED_STATEMENT_LANGUAGES.size).toBe(0);
  });

  test("the live checks hold no prototype key", () => {
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(isAgentStatementLanguage(id)).toBe(false);
      expect(hasGoalRule(id)).toBe(false);
    }
  });
});
