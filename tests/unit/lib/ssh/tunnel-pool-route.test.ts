import "../../../setup";
import { mock, describe, test, expect, afterEach } from "bun:test";
import { EventEmitter } from "events";
import type { SSHTunnelConfig } from "@/lib/types";

/**
 * THE POOL'S THIRD KEY DIMENSION: the bastion the forward goes through (D86).
 *
 * The entry's defect statement named three things the pool ignored - `remoteHost`, `remotePort`
 * AND the bastion config - and keying on the first two left the third measurable end to end. With
 * the route out of the key, a record edited to name a bastion that does not resolve was handed the
 * forward already open through the real one: MEASURED 2026-09-15 against the live `p3fix-bastion`,
 * the provider dialled the existing forward, answered `libredb_dev` at `172.23.0.2`, and its seal
 * agreed with the route digest the edit-plan route recomputes, so a plan verified for a bastion the
 * statement never traversed. The control that made the reading non-vacuous is the last test here:
 * the same unreachable bastion on a connection id nothing is pooled under gets no forward at all.
 *
 * This file mocks `ssh2` and `net` only, so what it drives is the real pool.
 */

/** Every bastion a client actually dialled, in order, as `user@host:port`. */
const dialled: string[] = [];

class MockDuplexStream extends EventEmitter {
  pipe() {
    return this;
  }
}

class MockSSHClient extends EventEmitter {
  ended = false;

  connect(opts: Record<string, unknown>) {
    dialled.push(`${String(opts.username)}@${String(opts.host)}:${String(opts.port)}`);
    setTimeout(() => this.emit("ready"), 0);
  }

  forwardOut(
    _bindAddr: string,
    _bindPort: number,
    _host: string,
    _port: number,
    cb: (err: Error | null, stream: unknown) => void,
  ) {
    cb(null, new MockDuplexStream());
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

/** A distinct local port per forward, so two pooled entries are also distinguishable by address. */
let nextLocalPort = 45001;

class MockServer extends EventEmitter {
  closed = false;
  private readonly port = nextLocalPort++;

  listen(_port: number, _host: string, cb: () => void) {
    setTimeout(cb, 0);
  }

  address() {
    return { address: "127.0.0.1", family: "IPv4", port: this.port };
  }

  close() {
    this.closed = true;
  }
}

const createServer = () => new MockServer();

mock.module("net", () => ({ default: { createServer }, createServer }));

const { createSSHTunnel, closeSSHTunnel, hasTunnel, getTunnelInfo } = await import("@/lib/ssh/tunnel");

const BASTION_A: SSHTunnelConfig = {
  enabled: true,
  host: "bastion-a.example.com",
  port: 22,
  username: "admin",
  authMethod: "password",
  password: "pass",
};
const BASTION_B: SSHTunnelConfig = { ...BASTION_A, host: "bastion-b.example.com", username: "mallory" };
const BASTION_C: SSHTunnelConfig = { ...BASTION_A, host: "bastion-c.example.com" };

const FAR_END = { host: "db.internal", port: 5432 };

let openIds: string[] = [];

const open = async (connectionId: string, ssh: SSHTunnelConfig) => {
  openIds.push(connectionId);
  return createSSHTunnel(connectionId, ssh, FAR_END.host, FAR_END.port);
};

describe("the SSH tunnel pool keys on the bastion route as well as the far end", () => {
  afterEach(async () => {
    for (const id of openIds) await closeSSHTunnel(id);
    openIds = [];
    dialled.length = 0;
  });

  test("a forward opened through one bastion is not served to a caller naming another", async () => {
    const connId = "d86-route-" + Date.now();

    const first = await open(connId, BASTION_A);
    const second = await open(connId, BASTION_B);

    expect(second).not.toBe(first);
    expect(second.localPort).not.toBe(first.localPort);
    // Both bastions were dialled, in order, so the second call opened its own SSH session
    // rather than being handed the first one's.
    expect(dialled).toEqual(["admin@bastion-a.example.com:22", "mallory@bastion-b.example.com:22"]);
  });

  test("the same route asks for the same forward, so the honest population still reuses one", async () => {
    const connId = "d86-route-same-" + Date.now();

    const first = await open(connId, BASTION_A);
    const again = await open(connId, { ...BASTION_A });

    expect(again).toBe(first);
    expect(dialled).toEqual(["admin@bastion-a.example.com:22"]);
  });

  test("each route's forward answers its own lookup, and a route nothing was opened through answers none", async () => {
    const connId = "d86-route-lookup-" + Date.now();

    const first = await open(connId, BASTION_A);
    const second = await open(connId, BASTION_B);

    expect(getTunnelInfo(connId, { ssh: BASTION_A, farEnd: FAR_END })).toBe(first);
    expect(getTunnelInfo(connId, { ssh: BASTION_B, farEnd: FAR_END })).toBe(second);
    expect(hasTunnel(connId, { ssh: BASTION_A, farEnd: FAR_END })).toBe(true);
    // The control the negative needs: a third bastion, nothing pooled, same id and far end.
    expect(hasTunnel(connId, { ssh: BASTION_C, farEnd: FAR_END })).toBe(false);
    expect(getTunnelInfo(connId, { ssh: BASTION_C, farEnd: FAR_END })).toBeUndefined();
    // And the far end still separates two forwards through the SAME bastion.
    expect(hasTunnel(connId, { ssh: BASTION_A, farEnd: { host: "other-db.internal", port: 5432 } })).toBe(false);
  });

  test("a rotated bastion credential is the same route and reuses the forward", async () => {
    // The key frames exactly the four addressing values `connectionFingerprint` frames, so the
    // pool cannot share a forward between two records the seal calls two different servers, and
    // does not split one over a value that changes who may reach the bastion rather than which
    // machine it is. Rotating the password must not strand the live forward behind a second one.
    const connId = "d86-route-secret-" + Date.now();

    const first = await open(connId, BASTION_A);
    const rotated = await open(connId, { ...BASTION_A, password: "rotated", hostKeyFingerprint: "SHA256:aa" });

    expect(rotated).toBe(first);
    expect(dialled).toEqual(["admin@bastion-a.example.com:22"]);
  });

  test("closing the connection id closes every route pooled under it", async () => {
    const connId = "d86-route-close-" + Date.now();

    await open(connId, BASTION_A);
    await open(connId, BASTION_B);

    await closeSSHTunnel(connId);

    expect(hasTunnel(connId)).toBe(false);
    expect(hasTunnel(connId, { ssh: BASTION_A, farEnd: FAR_END })).toBe(false);
    expect(hasTunnel(connId, { ssh: BASTION_B, farEnd: FAR_END })).toBe(false);
  });
});
