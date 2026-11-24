/**
 * `proxyListener` (tests/helpers/node-transport-fixtures.ts), the proxy that the proxy variables of the node-transport
 * tests name: it counts the HTTP request lines it receives, not every connection to its port, so a local client of
 * some other process that lands on a recycled port and sends something else, or nothing, is never a proxied request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { closeAll, eventually, proxyListener } from "../helpers/node-transport-fixtures";

afterEach(closeAll);

/** Connects to `port`, writes `bytes` unless it is null, and resolves once the listener has closed the socket. */
function send(port: number, bytes: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, "127.0.0.1", () => {
      if (bytes !== null) socket.write(bytes);
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve());
    socket.on("timeout", () => reject(new Error("The listener never closed the socket")));
    socket.setTimeout(5000);
  });
}

describe("proxyListener", () => {
  test("a GET in absolute form is a proxied request, recorded by its request line", async () => {
    const proxy = await proxyListener();
    await send(proxy.port, "GET http://127.0.0.1:1/control HTTP/1.1\r\nhost: 127.0.0.1:1\r\n\r\n");
    await eventually(() => proxy.requests.length === 1, "the request line");
    expect(proxy.requests).toEqual(["GET http://127.0.0.1:1/control HTTP/1.1"]);
    expect(proxy.strays).toEqual([]);
    expect(proxy.accepted()).toBe(1);
  });

  test("a CONNECT is a proxied request too", async () => {
    const proxy = await proxyListener();
    await send(proxy.port, "CONNECT 127.0.0.1:1 HTTP/1.1\r\n\r\n");
    await eventually(() => proxy.requests.length === 1, "the request line");
    expect(proxy.requests).toEqual(["CONNECT 127.0.0.1:1 HTTP/1.1"]);
  });

  test("a connection that sends RESP is recorded apart and never counted as a request", async () => {
    const proxy = await proxyListener();
    await send(proxy.port, "*1\r\n$4\r\nPING\r\n");
    await eventually(() => proxy.strays.length === 1, "the stray connection");
    expect(proxy.requests).toEqual([]);
    expect(proxy.strays[0]).toStartWith("*1\r\n");
    expect(proxy.accepted()).toBe(1);
  });

  test("a connection that sends nothing within the bound is closed and never counted as a request", async () => {
    const proxy = await proxyListener({ silenceMs: 50 });
    await send(proxy.port, null);
    expect(proxy.strays).toEqual([""]);
    expect(proxy.requests).toEqual([]);
    expect(proxy.accepted()).toBe(1);
  });

  test("a first line longer than the byte bound is decided without waiting for its end", async () => {
    const proxy = await proxyListener({ maxLineBytes: 16 });
    await send(proxy.port, `GET http://127.0.0.1:1/${"a".repeat(64)}`);
    expect(proxy.strays).toEqual(["GET http://127.0"]);
    expect(proxy.requests).toEqual([]);
  });
});
