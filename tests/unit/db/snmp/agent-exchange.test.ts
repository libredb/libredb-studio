/**
 * Each agent read's exchange is closed when the read ends, answered, refused by the agent or past its time budget, so
 * no socket, request id or pending answer of one read reaches the next; and the agent's client checks a GetBulk's
 * max-repetitions before anything is sent. Its own file, because the exchange is replaced for the whole process here
 * (`mock.module`), and the runner gives each file a process of its own.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Exchange, ExchangeOptions } from "@/lib/db/providers/network/snmp/client";
import { StatementError } from "@/lib/db/providers/network/snmp/statement";
import type { DatabaseConnection } from "@/lib/types";
import { type FakeAgent, startFakeAgent, text } from "../../../helpers/snmp-fake-agent";

const real = await import("@/lib/db/providers/network/snmp/client");
const realOpen = real.openExchange;
let opened = 0;
let closed = 0;
mock.module("@/lib/db/providers/network/snmp/client", () => ({
  ...real,
  openExchange: async (options: ExchangeOptions): Promise<Exchange> => {
    const exchange = await realOpen(options);
    opened += 1;
    return {
      send: exchange.send,
      close: () => {
        closed += 1;
        exchange.close();
      },
    };
  },
}));
const { SnmpProvider } = await import("@/lib/db/providers/network/snmp");
const { createSnmpAgentClient } = await import("@/lib/db/providers/network/snmp/agent-client");

const BUDGET = { statementTimeoutMs: 300, maxResultRows: 5, maxResultBytes: 10_000 };
let agent: FakeAgent | undefined;

afterEach(() => {
  agent?.close();
  agent = undefined;
});

const connection = (port: number): DatabaseConnection =>
  ({
    id: "agent",
    name: "agent",
    type: "snmp",
    host: "127.0.0.1",
    port,
    password: "not-a-real-community",
    createdAt: new Date(),
  }) as unknown as DatabaseConnection;

describe("each agent read closes the exchange it opened", () => {
  test("after an answer, an agent's refusal and the time budget, every exchange opened for a read is closed", async () => {
    agent = await startFakeAgent(new Map([["1.3.6.1.2.1.1.1.0", text("a test agent")]]), {
      errorStatus: (request) => (request === 3 ? 5 : 0),
      silentOn: (request) => request === 4,
    });
    const provider = new SnmpProvider(
      connection(agent.port),
      { queryTimeout: 1_000 },
      { readOnly: true, sendsStatements: true },
    );
    await provider.connect();
    const before = { opened, closed };
    expect((await provider.queryReadOnly("get sysDescr.0", BUDGET)).rowCount).toBe(1);
    await expect(provider.queryReadOnly("get sysDescr.0", BUDGET)).rejects.toThrow("error-status 5");
    await expect(provider.queryReadOnly("get sysDescr.0", BUDGET)).rejects.toThrow("time budget");
    expect({ opened: opened - before.opened, closed: closed - before.closed }).toEqual({ opened: 3, closed: 3 });
    await provider.disconnect();
  });
});

describe("the agent's client", () => {
  test("refuses a GetBulk past the max-repetitions cap before anything is sent, and sends one within it", async () => {
    const sent: unknown[][] = [];
    const exchange: Exchange = {
      send: async (...args) => {
        sent.push(args.slice(2));
        return { requestId: 1, errorStatus: 0, errorIndex: 0, varbinds: [] };
      },
      close: () => undefined,
    };
    const client = createSnmpAgentClient(exchange);
    expect(() => client.getBulk([1, 3, 6, 1], 51)).toThrow(StatementError);
    expect(sent).toEqual([]);
    await client.getBulk([1, 3, 6, 1], 50);
    expect(sent).toEqual([[[[1, 3, 6, 1]], { nonRepeaters: 0, maxRepetitions: 50 }]]);
  });
});
