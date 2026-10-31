/**
 * The agent's reader of one NETCONF request: the two shapes it admits, read with the console's own parser, and every
 * refusal in agent mode's own words, followed by the list of reads, before anything is sent.
 */
import { describe, expect, test } from "bun:test";
import { NETCONF_AGENT_SENTENCES, readNetconfAgentStatement } from "@/lib/db/providers/network/netconf/agent-statement";
import { NETCONF_WITHHELD_TEXT } from "@/lib/db/providers/network/netconf/agent-withheld";

const refusal = (text: string) => {
  const reading = readNetconfAgentStatement(text);
  if (reading.ok) throw new Error(`admitted: ${text}`);
  return reading;
};

describe("what is admitted", () => {
  test("the console's read request on every datastore, its path read by the console's parser, its limit kept when written", () => {
    expect(
      readNetconfAgentStatement(
        '{"datastore": "running", "path": "ietf-interfaces:interfaces/interface=ge-0%2F0%2F1"}',
      ),
    ).toEqual({
      ok: true,
      plan: {
        kind: "read",
        datastore: "running",
        path: [
          { module: "ietf-interfaces", name: "interfaces" },
          { name: "interface", keys: ["ge-0/0/1"] },
        ],
      },
    });
    for (const datastore of ["candidate", "startup", "operational", "intended"] as const) {
      const reading = readNetconfAgentStatement(JSON.stringify({ datastore, path: "m:n", limit: 7 }));
      expect(reading).toEqual({
        ok: true,
        plan: { kind: "read", datastore, path: [{ module: "m", name: "n" }], limit: 7 },
      });
    }
  });

  test("a schema request naming one module", () => {
    expect(readNetconfAgentStatement('{"schema": "ietf-interfaces"}')).toEqual({
      ok: true,
      plan: { kind: "schema", module: "ietf-interfaces" },
    });
  });
});

describe("what is refused before anything is sent, in agent mode's words with the list of reads", () => {
  test("anything that is not one of the two shapes", () => {
    for (const text of [
      "get-config running",
      "[1]",
      "null",
      '"x"',
      "{}",
      '{"operation": "edit-config"}',
      '{"rpc": "<edit-config/>"}',
    ]) {
      const reading = refusal(text);
      expect(reading.code).toBe("request");
      expect(reading.message).toEndWith(`${NETCONF_AGENT_SENTENCES.reads} Nothing was sent.`);
    }
    expect(refusal("not json").message).toStartWith("The request is not JSON.");
  });

  test("a field neither shape names: a filter, an operation, a with-defaults or a second module", () => {
    expect(refusal('{"datastore": "running", "path": "m:n", "filter": "<x/>"}').message).toStartWith(
      "The read request holds a field agent mode does not read (filter).",
    );
    expect(
      refusal('{"datastore": "running", "path": "m:n", "operation": "edit-config", "with-defaults": "report-all"}')
        .message,
    ).toContain("(operation, with-defaults)");
    expect(refusal('{"schema": "a", "datastore": "running"}').message).toStartWith(
      "A schema request names one module and nothing else",
    );
    expect(refusal('{"schema": 1}').code).toBe("request");
  });

  test("the console parser's own refusals, a datastore NETCONF has none of, and a path without its module", () => {
    expect(refusal('{"datastore": "running"}').message).toStartWith("This read names no path");
    expect(refusal('{"path": "m:n"}').message).toStartWith("This read names no datastore");
    expect(refusal('{"datastore": "running", "path": "m:n", "limit": 0}').message).toStartWith(
      "A limit is a whole number",
    );
    expect(refusal('{"datastore": "secrets", "path": "m:n"}').message).toStartWith(
      "NETCONF has no datastore named secrets.",
    );
    expect(refusal('{"datastore": "running", "path": "interfaces"}').message).toStartWith(
      "A read names its module on its first node",
    );
  });

  test("a node name or module name outside the YANG identifier grammar, which would become element text", () => {
    for (const path of ["m:n><edit-config", "m:a b", "m:<x>", "m%3Ax:y"]) {
      expect(refusal(JSON.stringify({ datastore: "running", path })).code).toBe("request");
    }
    expect(refusal('{"schema": "a><b"}').code).toBe("request");
  });

  test("a key value holding the end-of-message separator", () => {
    expect(refusal(JSON.stringify({ datastore: "running", path: "m:n=a]]>]]>b" })).message).toStartWith(
      "A key value holds ]]>]]>",
    );
  });

  test("a path into, or the schema of, a module withheld whole, at any node", () => {
    for (const text of [
      '{"datastore": "running", "path": "ietf-keystore:keystore"}',
      '{"datastore": "operational", "path": "ietf-interfaces:interfaces/ietf-netconf-acm:nacm"}',
      '{"schema": "ietf-netconf-acm"}',
      '{"schema": "ietf-keystore"}',
    ]) {
      const reading = refusal(text);
      expect(reading.code).toBe("withheld");
      expect(reading.message).toContain("is withheld from agent mode whole");
    }
  });

  test("the list of reads names both shapes, the five datastores, the refusal past the budget and every withheld kind", () => {
    for (const part of [
      '{"datastore": "running"',
      '{"schema": "ietf-interfaces"}',
      "get-config",
      "get-data",
      "refused rather than cut",
      NETCONF_WITHHELD_TEXT,
    ]) {
      expect(NETCONF_AGENT_SENTENCES.reads).toContain(part);
    }
  });
});
