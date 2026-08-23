import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { promptedToolContract, readPromptedAction, readPromptedPayload } from "@/lib/agent/prompted-tools";
import type { AgentToolDefinition } from "@/lib/agent/tools";

/**
 * The two halves of driving a model that cannot emit `tool_calls`: describing the tools
 * in prose, and reading an action back out of ordinary text. Both are pure, so both are
 * tested here rather than through a run.
 */

const definition = (name: string, description: string, schema: z.ZodType<unknown>): AgentToolDefinition =>
  ({ name, description, inputSchema: schema }) as unknown as AgentToolDefinition;

const INSPECT = definition(
  "inspect_operations",
  "Read live database operational state.",
  z.strictObject({ kind: z.enum(["health", "slow_queries"]) }),
);

const READ = definition(
  "run_read_query",
  "Run one bounded read-only SQL statement.",
  z.strictObject({ sql: z.string(), rationale: z.string().optional() }),
);

describe("the contract a model without tool calling is given in prose", () => {
  test("names every tool it was handed, and nothing it was not", () => {
    const text = promptedToolContract([INSPECT, READ]);

    expect(text).toContain("inspect_operations");
    expect(text).toContain("run_read_query");
    expect(text).not.toContain("compose_report");
  });

  test("carries each tool's own description, so the prose says what the tool does", () => {
    expect(promptedToolContract([INSPECT])).toContain("Read live database operational state.");
  });

  test("states the argument shape, including which fields are required", () => {
    const text = promptedToolContract([READ]);

    // The shape reaches the model as JSON Schema derived from the tool's own zod
    // schema, so the prose cannot drift from what the tool actually accepts.
    expect(text).toContain('"sql"');
    expect(text).toContain("required");
  });

  test("demands one JSON object and says what it looks like, since that is the whole protocol", () => {
    const text = promptedToolContract([INSPECT]);

    expect(text).toContain('{"action"');
    expect(text).toContain('"arguments"');
  });

  test("an empty tool set produces no contract at all, so a toolless run is told nothing", () => {
    expect(promptedToolContract([])).toBeNull();
  });
});

describe("reading an action back out of a model's prose", () => {
  test("a bare object is read, and its name and arguments come back typed", () => {
    expect(readPromptedAction('{"action": "inspect_operations", "arguments": {"kind": "health"}}')).toEqual({
      name: "inspect_operations",
      input: { kind: "health" },
    });
  });

  test("prose around the object does not hide it, because models explain themselves", () => {
    const text =
      'I should check the health first.\n\n{"action": "inspect_operations", "arguments": {"kind": "health"}}';

    expect(readPromptedAction(text)).toEqual({ name: "inspect_operations", input: { kind: "health" } });
  });

  test("a fenced object is read, because a model told not to fence sometimes fences", () => {
    const text = '```json\n{"action": "run_read_query", "arguments": {"sql": "SELECT 1"}}\n```';

    expect(readPromptedAction(text)).toEqual({ name: "run_read_query", input: { sql: "SELECT 1" } });
  });

  test("a reasoning block is not mistaken for the action, so a plan is not run as a call", () => {
    // The failure this guards: a reasoning model rehearses the call inside its thinking
    // and then answers something else. The LAST object is the one it settled on.
    const text =
      '<think>Maybe {"action": "run_read_query", "arguments": {"sql": "SELECT 2"}} would work.</think>\n' +
      '{"action": "inspect_operations", "arguments": {"kind": "health"}}';

    expect(readPromptedAction(text)).toEqual({ name: "inspect_operations", input: { kind: "health" } });
  });

  test("nested argument objects survive, so a chart spec is not flattened", () => {
    const text = '{"action": "present_answer", "arguments": {"artifact": "a1", "presentation": {"kind": "table"}}}';

    expect(readPromptedAction(text)).toEqual({
      name: "present_answer",
      input: { artifact: "a1", presentation: { kind: "table" } },
    });
  });

  test("prose with no object at all is not an action", () => {
    expect(readPromptedAction("I cannot access the database from here.")).toBeNull();
  });

  test("an object that is not an action is not one either", () => {
    expect(readPromptedAction('{"result": 42}')).toBeNull();
  });

  test("a malformed object is refused rather than half-read", () => {
    expect(readPromptedAction('{"action": "inspect_operations", "arguments": {kind: health}}')).toBeNull();
  });

  test("an action naming no tool is refused, because a name is the whole dispatch", () => {
    expect(readPromptedAction('{"action": "", "arguments": {}}')).toBeNull();
  });

  test("missing arguments read as an empty object, so a no-argument tool still dispatches", () => {
    expect(readPromptedAction('{"action": "compose_report"}')).toEqual({ name: "compose_report", input: {} });
  });

  /*
    The fields a model wrote one level too high, and what they cost before they were read.

    One evaluated model, query-optimization: THIRTY-FIVE `recommend_change` refusals in a single
    run, every one of them saying the same three fields did not match, until the run hit its
    deadline. The refusal detail is what made it readable — `change: invalid value; statement:
    expected string; rationale: expected string` is not three separate mistakes, it is an
    arguments object with nothing in it at all, listed three at a time.

    Nothing was missing from the reply. The model had named the right tool, chosen the right
    kind of change, written a statement and a rationale, and cited an artifact its own run
    produced; it had simply written those beside `action` rather than inside `arguments`, and
    the whole call was discarded for it.

    This reads them, and it can only ADD: an object that already carries `arguments` keeps
    exactly what it had, and a sibling never replaces a field the model put in the right
    place. Nothing that parsed before parses differently.
  */
  test("fields written beside the action, rather than inside it, are still the arguments", () => {
    expect(
      readPromptedAction('{"action": "recommend_change", "change": "index", "statement": "CREATE INDEX ..."}'),
    ).toEqual({ name: "recommend_change", input: { change: "index", statement: "CREATE INDEX ..." } });
  });

  test("a field that escaped the arguments object is folded back into it", () => {
    /*
      The same mistake by half. Reproduced against the model through the product's own
      contract text: it built `arguments` correctly and then put `evidence` outside, which
      leaves a call that is complete in the reply and incomplete by the time it is validated.
    */
    expect(
      readPromptedAction(
        '{"action": "recommend_change", "arguments": {"change": "index", "statement": "CREATE INDEX ..."}, "evidence": [{"correlationId": "a1"}]}',
      ),
    ).toEqual({
      name: "recommend_change",
      input: { change: "index", statement: "CREATE INDEX ...", evidence: [{ correlationId: "a1" }] },
    });
  });

  test("a sibling never overrides what the model put in the right place", () => {
    expect(
      readPromptedAction('{"action": "compose_report", "arguments": {"claims": ["inside"]}, "claims": ["outside"]}'),
    ).toEqual({ name: "compose_report", input: { claims: ["inside"] } });
  });
});

describe("a tool call the model wrote as its payload rather than as a call", () => {
  /*
    The largest measured loss, and the shape it actually has.

    `no-report` was 37 of 66 failing cells across 25 local models on six surfaces. Reading
    the ledgers of 36 of those runs, SEVEN had written a complete `compose_report` payload
    into their prose — a fenced JSON object with a `claims` array — instead of calling the
    tool. Seven different families did it, `granite4.1:30b` among them, and an eighth did it and
    appended "(The compose_report tool was successfully used with the required structure,
    producing the above report.)" — it believed it had called the tool.

    `readPromptedAction` cannot help: it looks for an `{"action", "arguments"}` envelope and
    these models wrote the bare ARGUMENTS. So the payload is matched against the schemas of
    the tools the run actually holds, which is the only way to know which tool a bare object
    belongs to without guessing.

    Two refusals matter more than the recovery:

      - AMBIGUITY is not resolved. If a payload satisfies two held tools, nothing is
        recovered, because picking one would be the reader inventing an intent.
      - Recovery grants no authority. The action goes back through the same schema and the
        same audited pipeline as a native call, so a recovered report citing an id the run
        never produced is refused by the citation contract exactly as it would be.
  */
  const report = definition(
    "compose_report",
    "Compose the report",
    z.strictObject({
      claims: z
        .array(z.strictObject({ claim: z.string().min(1), evidence: z.array(z.object({ source: z.string() })).min(1) }))
        .min(1),
    }),
  );
  const profile = definition("profile_table", "Profile a table", z.strictObject({ table: z.string().min(1) }));

  test("a fenced payload is recovered as a call to the tool whose schema it fits", () => {
    const prose = [
      "**Report**",
      "```json",
      '{ "claims": [ { "claim": "The engineering table is sparsely populated.",',
      '  "evidence": [ { "source": "artifact", "correlationId": "1aac8a1c" } ] } ] }',
      "```",
      "(The compose_report tool was successfully used with the required structure.)",
    ].join("\n");

    const action = readPromptedPayload(prose, [report, profile]);

    expect(action?.name).toBe("compose_report");
    expect(action?.input).toMatchObject({ claims: [{ claim: "The engineering table is sparsely populated." }] });
  });

  test("prose with no object in it recovers nothing", () => {
    expect(readPromptedPayload("I have finished looking at the tables.", [report, profile])).toBeNull();
  });

  test("an object that fits no held tool recovers nothing", () => {
    expect(readPromptedPayload('{"thoughts": "I should probably report now"}', [report, profile])).toBeNull();
  });

  test("a payload the model left malformed is skipped rather than half-read", () => {
    /*
      The recovery path reads every brace-delimited span in the prose, and prose is where
      unparseable ones live: a model that writes `{claims: [...]}` without quoting its keys, or
      one whose reply was cut mid-object, produces a span that is not JSON at all.

      Skipped rather than refused, because a later span in the same reply may still be the call —
      which is exactly the arrangement here: the broken object comes first and the whole one
      after it, and the whole one is what comes back.
    */
    const text =
      '{"claims": [{"claim": "The engineering table is sparsely populated.", "evidence": [{"source": "artifact", "correlationId": "a1"}]}]}\nand then, half-written: {claims: unquoted}';

    expect(readPromptedPayload(text, [report, profile])?.name).toBe("compose_report");
  });

  test("an object that fits TWO held tools recovers nothing, because the intent is unknown", () => {
    // Two tools taking the same shape is the case a reader must not guess at.
    const first = definition("first_tool", "one", z.strictObject({ table: z.string() }));
    const second = definition("second_tool", "two", z.strictObject({ table: z.string() }));

    expect(readPromptedPayload('{"table": "engineering"}', [first, second])).toBeNull();
  });

  test("the LAST fitting object wins, because a reasoning model rehearses before it commits", () => {
    // The same reason `readPromptedAction` reads backwards: a thinking model writes
    // candidate payloads inside its reasoning and the one it means is the final one.
    const prose = [
      '{"table": "draft_one"}',
      "on reflection the interesting one is the other table",
      '{"table": "engineering"}',
    ].join("\n");

    expect(readPromptedPayload(prose, [profile])?.input).toEqual({ table: "engineering" });
  });

  test("a run holding no tools recovers nothing", () => {
    expect(readPromptedPayload('{"table": "engineering"}', [])).toBeNull();
  });
});

describe("what these models actually write, read off their ledgers", () => {
  /*
    Both of the cases below were recovered from real losing runs, and both are runs where the
    model had DONE the work and lost the cell on the envelope its answer arrived in. That is
    the measured shape of the largest loss class on this path: four reasoning distills
    lock 2 cells out of 24 between them, and the ledgers are full of correct payloads that
    were never read.

    Every recovered call still goes through `AGENT_TOOL_DEFINITIONS` and the audited
    pipeline afterwards, exactly as a native call does. Reading is not granting: a recovered
    report citing an artifact this run never produced is refused by the citation contract
    like any other.
  */
  const report = definition(
    "compose_report",
    "Compose the run's findings and finish.",
    z.strictObject({
      claims: z.array(z.strictObject({ claim: z.string().min(1), evidence: z.array(z.looseObject({})).min(1) })).min(1),
    }),
  );
  const schema = definition(
    "inspect_schema",
    "Read the catalog.",
    z.strictObject({ kind: z.string().optional(), table: z.string().optional() }),
  );

  test("a payload whose last brace never arrived is still read", () => {
    /*
      One evaluated model, database-assessment: 498 characters of closing prose holding six `{`
      and five `}`. Two well-formed claims, each citing an artifact id from one of its own
      two `profile_table` calls — and the outermost brace missing, because the endpoint cut
      the reply off. `objectsIn` only emitted a candidate when depth returned to zero, so
      both readers saw nothing and the run scored `no-report`.

      Tolerated LAST, after every well-formed candidate, so a complete reply is read exactly
      as it was before: this can only add a reading where there was none.
    */
    const truncated =
      '{"action": "compose_report", "arguments": {"claims": [{"claim": "The employee table holds 1000 rows.",' +
      ' "evidence": [{"source": "artifact", "correlationId": "0563d4a6-1111-4222-8333-444444444444"}]}]}';

    const action = readPromptedAction(truncated);
    if (action === null) throw new Error("expected the truncated payload to be recovered");
    expect(action.name).toBe("compose_report");
    expect((action.input as { claims?: unknown[] }).claims).toHaveLength(1);
  });

  test("a call wrapped in an envelope is read out of it", () => {
    /*
      Another, investigation: the intended call is legible twice over — the key
      names a tool this run holds, and the nested `arguments` object fits that tool's schema
      — but the outermost object fits nothing, so nothing was recovered and the run ended
      having called no tool at all. It is the only model in the fleet with no agent cell at
      any score, and this is what its turns look like.

      Note what it echoed back as arguments: `type`, `properties`, `$schema`. Those come
      from the JSON Schema the prose contract prints for each tool. A 7B model reads that as
      part of the payload — worth knowing separately, but not what this test fixes.
    */
    const enveloped = JSON.stringify({
      actions: {
        inspect_schema: {
          arguments: { kind: "columns", table: "employee" },
          type: "object",
          properties: { kind: "string", table: "string" },
        },
      },
    });

    const action = readPromptedAction(enveloped, [schema, report]);
    expect(action).toEqual({ name: "inspect_schema", input: { kind: "columns", table: "employee" } });
  });

  test("an envelope naming two held tools is refused rather than guessed", () => {
    // The rule the rest of this reader keeps: exactly one fit, or nothing. An envelope is a
    // weaker signal than a schema match, so it may not become the place ambiguity is
    // resolved by picking.
    const ambiguous = JSON.stringify({
      actions: { inspect_schema: { arguments: { table: "a" } }, compose_report: { arguments: { claims: [] } } },
    });

    expect(readPromptedAction(ambiguous, [schema, report])).toBeNull();
  });
});
