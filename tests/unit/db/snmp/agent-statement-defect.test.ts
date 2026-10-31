/**
 * The agent's SNMP reader passes on a defect rather than wording it as a refusal: only the console parser's and
 * resolver's own refusals become agent mode's sentence. Its own file, because the parser is replaced for the whole
 * process here (`mock.module`), and the runner gives each file a process of its own.
 */
import { expect, mock, test } from "bun:test";

const real = await import("@/lib/db/providers/network/snmp/statement");
mock.module("@/lib/db/providers/network/snmp/statement", () => ({
  ...real,
  parseStatement: () => {
    throw new TypeError("a defect in the parser");
  },
}));
const { readSnmpAgentStatement } = await import("@/lib/db/providers/network/snmp/agent-statement");

test("a defect that is not a refusal passes as it is", () => {
  expect(() => readSnmpAgentStatement("get 1.3")).toThrow(TypeError);
});
