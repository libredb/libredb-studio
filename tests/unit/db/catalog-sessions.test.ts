/**
 * The bounded per-catalog session set a server-level connection keeps (#1530).
 */

import { describe, test, expect } from "bun:test";
import { CatalogSessions, type CatalogSessionHost } from "@/lib/db/utils/catalog-sessions";

interface FakeSession {
  readonly name: string;
  busy: boolean;
  closed: boolean;
}

function harness(limit = 2, leaseGraceMs = 100) {
  let clock = 0;
  const opened: string[] = [];
  const closed: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const host: CatalogSessionHost<FakeSession> = {
    open: async (name) => {
      await gates.get(name);
      if (name === "refused") throw new Error(`cannot open ${name}`);
      opened.push(name);
      return { name, busy: false, closed: false };
    },
    close: async (session) => {
      session.closed = true;
      closed.push(session.name);
    },
    isBusy: (session) => session.busy,
    exhausted: (open) => new Error(`all busy: ${open.join(", ")}`),
  };
  const sessions = new CatalogSessions(host, { limit, leaseGraceMs }, () => clock);
  return {
    sessions,
    opened,
    closed,
    gates,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("CatalogSessions", () => {
  test("opens a session once and hands the same one out again", async () => {
    const { sessions, opened } = harness();
    const first = await sessions.acquire("a");
    expect(await sessions.acquire("a")).toBe(first);
    expect(opened).toEqual(["a"]);
  });

  test("two requests for a session still opening share the one open", async () => {
    const { sessions, opened, gates } = harness();
    let release!: () => void;
    gates.set("a", new Promise<void>((resolve) => (release = resolve)));
    const pending = [sessions.acquire("a"), sessions.acquire("a")];
    release();
    const [first, second] = await Promise.all(pending);
    expect(first).toBe(second);
    expect(opened).toEqual(["a"]);
  });

  test("at the limit, the idle session used least recently is closed to make room", async () => {
    const { sessions, closed, advance } = harness(2);
    await sessions.acquire("a");
    advance(10);
    await sessions.acquire("b");
    advance(10);
    // Used again, so `b` is now the least recent.
    await sessions.acquire("a");
    advance(1000);
    await sessions.acquire("c");
    expect(closed).toEqual(["b"]);
    expect(sessions.find((session) => session.name === "b")).toBeUndefined();
    expect(sessions.find((session) => session.name === "c")?.name).toBe("c");
  });

  test("a session in use, or handed out within the grace window, is never closed", async () => {
    const { sessions, closed, advance } = harness(2, 100);
    const a = await sessions.acquire("a");
    await sessions.acquire("b");
    await expect(sessions.acquire("c")).rejects.toThrow("all busy: a, b");
    advance(1000);
    a.busy = true;
    await sessions.acquire("c");
    expect(closed).toEqual(["b"]);
  });

  test("a session still opening counts toward the limit", async () => {
    const { sessions, gates } = harness(1);
    let release!: () => void;
    gates.set("a", new Promise<void>((resolve) => (release = resolve)));
    const pending = sessions.acquire("a");
    await expect(sessions.acquire("b")).rejects.toThrow("all busy: a");
    release();
    await pending;
  });

  test("a refused open leaves nothing behind, and the name can be asked for again", async () => {
    const { sessions } = harness();
    await expect(sessions.acquire("refused")).rejects.toThrow("cannot open refused");
    await expect(sessions.acquire("refused")).rejects.toThrow("cannot open refused");
  });

  test("closing all closes the open ones and the ones still opening", async () => {
    const { sessions, closed, gates } = harness(3);
    await sessions.acquire("a");
    let release!: () => void;
    gates.set("b", new Promise<void>((resolve) => (release = resolve)));
    const pending = sessions.acquire("b");
    const closing = sessions.closeAll();
    release();
    await pending;
    await closing;
    expect(closed.sort()).toEqual(["a", "b"]);
    expect(sessions.find(() => true)).toBeUndefined();
  });
});
