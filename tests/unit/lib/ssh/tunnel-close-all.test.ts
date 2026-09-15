import "../../../setup";
import { mock, describe, test, expect } from "bun:test";
import { EventEmitter } from "events";
import type { SSHTunnelConfig } from "@/lib/types";

/**
 * `closeSSHTunnel` is the teardown for a WHOLE connection, and since D86 a connection may hold
 * more than one forward, so one close that throws must not strand the rest.
 *
 * The three callers - `removeProvider`, the idle sweep and the disconnect path it serves - all
 * swallow what this function throws, so a loop that aborted on the first failure would leave the
 * remaining SSH clients and loopback listeners open with nothing holding a handle and nothing
 * saying so. It reaps every forward and then reports what failed, rather than stopping or
 * pretending the failures did not happen.
 */

class MockSSHClient extends EventEmitter {
  ended = false;

  connect() {
    setTimeout(() => this.emit("ready"), 0);
  }

  forwardOut(_a: string, _b: number, _h: string, _p: number, cb: (e: Error | null, s: unknown) => void) {
    cb(null, new EventEmitter());
  }

  end() {
    this.ended = true;
  }
}

mock.module("ssh2", () => ({
  Client: class {
    constructor() {
      return new MockSSHClient();
    }
  },
}));

/** The far end whose local server refuses to close, set per test. */
let refusingFarEnd: string | null = null;
let nextLocalPort = 46001;
const closedPorts: number[] = [];
/** Which far end the next `net.createServer` belongs to, read from the forward being opened. */
let openingFarEnd = "";

class MockServer extends EventEmitter {
  readonly port = nextLocalPort++;
  private readonly farEnd = openingFarEnd;

  listen(_port: number, _host: string, cb: () => void) {
    setTimeout(cb, 0);
  }

  address() {
    return { address: "127.0.0.1", family: "IPv4", port: this.port };
  }

  close() {
    if (this.farEnd === refusingFarEnd) throw new Error(`cannot close ${this.farEnd}`);
    closedPorts.push(this.port);
  }
}

const createServer = () => new MockServer();

mock.module("net", () => ({ default: { createServer }, createServer }));

const { createSSHTunnel, closeSSHTunnel, hasTunnel } = await import("@/lib/ssh/tunnel");

const BASTION: SSHTunnelConfig = {
  enabled: true,
  host: "bastion.example.com",
  port: 22,
  username: "admin",
  authMethod: "password",
  password: "pass",
};

const open = (connectionId: string, farEnd: string) => {
  openingFarEnd = farEnd;
  return createSSHTunnel(connectionId, BASTION, farEnd, 5432);
};

describe("closeSSHTunnel reaps every forward under the id", () => {
  test("a forward that refuses to close does not strand the ones after it", async () => {
    const connId = "d86-close-isolation-" + Date.now();
    refusingFarEnd = "db-a.internal";
    closedPorts.length = 0;

    const stubborn = await open(connId, "db-a.internal");
    const second = await open(connId, "db-b.internal");
    const third = await open(connId, "db-c.internal");

    await expect(closeSSHTunnel(connId)).rejects.toThrow(`Failed to close 1 SSH tunnel(s) for ${connId}`);

    // The two behind it are closed, not stranded, and nothing is left pooled under the id.
    expect(closedPorts).toEqual([second.localPort, third.localPort]);
    expect(hasTunnel(connId)).toBe(false);
    expect(stubborn.localPort).not.toBe(second.localPort);
    refusingFarEnd = null;
  });

  test("the failure is reported rather than swallowed, and names every forward that failed", async () => {
    const connId = "d86-close-report-" + Date.now();
    refusingFarEnd = "db-a.internal";

    await open(connId, "db-a.internal");
    await open(connId, "db-b.internal");

    const error = (await closeSSHTunnel(connId).catch((e: unknown) => e)) as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(1);
    expect(String(error.errors[0])).toContain("cannot close db-a.internal");
    expect(error.message).toContain(connId);
    refusingFarEnd = null;
  });

  test("the control: when every close succeeds it resolves and the pool is empty", async () => {
    const connId = "d86-close-control-" + Date.now();
    refusingFarEnd = null;
    closedPorts.length = 0;

    const first = await open(connId, "db-a.internal");
    const second = await open(connId, "db-b.internal");

    await closeSSHTunnel(connId);

    expect(closedPorts).toEqual([first.localPort, second.localPort]);
    expect(hasTunnel(connId)).toBe(false);
  });
});
