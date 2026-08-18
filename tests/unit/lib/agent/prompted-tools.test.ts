import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { promptedToolContract, readPromptedAction } from "@/lib/agent/prompted-tools";
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
});
