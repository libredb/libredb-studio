/**
 * One session per connection, and nothing left behind (#1677 O-S6).
 *
 * A SERVER'S SESSION TABLE IS SHARED WITH THE PLANT'S OWN CLIENTS. Measured: OPC PLC allows 100 and
 * the in-process server 10, so a provider opening one session per request would compete with the
 * SCADA systems the plant runs on. These tests assert the pooling and the closing, which is the
 * half of O-S6 a unit test can reach; the before-and-after session count belongs to the live check.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { isStaleSession, OpcuaUnansweredError } from "@/lib/db/providers/industrial/opcua/errors";
import type { OpcuaReadOnlyClient } from "@/lib/db/providers/industrial/opcua/client";
import { OpcuaSessionPool } from "@/lib/db/providers/industrial/opcua/session-pool";

function fakeClient(record: { opened: number; closed: number }, failClose = false): OpcuaReadOnlyClient {
  record.opened += 1;
  return {
    endpoints: async () => [],
    limits: async () => ({}),
    browse: async () => [],
    browseNext: async () => [],
    releaseBrowseContinuationPoints: async () => {},
    read: async () => [],
    historyRead: async () => ({ nodeId: "", values: [], statusCode: "Good" }),
    historyReadNext: async () => ({
      nodeId: "",
      values: [],
      statusCode: "Good",
    }),
    releaseHistoryContinuationPoint: async () => {},
    close: async () => {
      record.closed += 1;
      if (failClose)
        throw Object.assign(new Error("close refused"), {
          request: { userName: "okuyucu" },
        });
    },
  };
}

describe("one session, reused", () => {
  test("many reads share one session", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    // oxlint-disable-next-line no-await-in-loop -- the point is that two acquires in turn share one session.
    for (let at = 0; at < 200; at += 1) await pool.acquire();
    expect(record.opened).toBe(1);
  });

  /** Two reads arriving together is the case that fills a server's table fastest. */
  test("reads arriving together share one session rather than racing to open two", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fakeClient(record);
    });
    await Promise.all(Array.from({ length: 20 }, () => pool.acquire()));
    expect(record.opened).toBe(1);
  });

  test("a failed open does not poison the pool", async () => {
    const record = { opened: 0, closed: 0 };
    let first = true;
    const pool = new OpcuaSessionPool(async () => {
      if (first) {
        first = false;
        throw new Error("refused");
      }
      return fakeClient(record);
    });
    await expect(pool.acquire()).rejects.toThrow("refused");
    await expect(pool.acquire()).resolves.toBeDefined();
    expect(record.opened).toBe(1);
  });
});

describe("nothing is left behind", () => {
  test("close closes the session", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    await pool.acquire();
    await pool.close();
    expect(record.closed).toBe(1);
    expect(pool.isOpen()).toBe(false);
  });

  test("closing twice closes once", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    await pool.acquire();
    await pool.close();
    await pool.close();
    expect(record.closed).toBe(1);
  });

  test("closing before anything opened is not an error", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    expect(await pool.close()).toBeUndefined();
    expect(record.closed).toBe(0);
  });

  /**
   * The race that leaves a session behind: a connection closed while its session was still opening.
   * The session arrives after the close, and has to be closed rather than held.
   */
  test("a session that arrives after the close is closed, not kept", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return fakeClient(record);
    });
    const opening = pool.acquire();
    await pool.close();
    await expect(opening).rejects.toThrow(/closed while its session was opening/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(record.closed).toBe(1);
    expect(pool.isOpen()).toBe(false);
  });

  /** A close that threw would leave the caller unable to finish disconnecting. */
  test("a close that fails reports the message and still closes the pool", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record, true));
    await pool.acquire();
    const message = await pool.close();
    expect(message).toBe("close refused");
    expect(pool.isOpen()).toBe(false);
  });

  /** O-S8: only the message, because the error object carries the request that produced it. */
  test("a failed close reports the message and not the request it carried", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record, true));
    await pool.acquire();
    const message = await pool.close();
    expect(message).not.toContain("okuyucu");
  });

  /**
   * THE REFUSAL IS ASSERTED BY WHAT IT PREVENTS, not only by its words. `toThrow(/closed/)` also
   * matches the OTHER refusal this pool writes, so removing the guard in `acquire` passed this test
   * while opening a second real session on a closed connection - the session-table leak the file
   * exists to prevent. The count is what catches it, and the type is what keeps it a 400.
   */
  test("acquiring after a close is refused, and opens nothing", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    await pool.acquire();
    expect(record.opened).toBe(1);
    await pool.close();
    await expect(pool.acquire()).rejects.toThrow(/This OPC UA connection is closed/);
    await expect(pool.acquire()).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(record.opened).toBe(1);
    expect(pool.isOpen()).toBe(false);
  });
});

/**
 * A SESSION THE SERVER HAS FORGOTTEN IS REPLACED, ONCE, which is the promise `errors.ts` makes for
 * BadSessionIdInvalid ("reading again opens a new one"). Measured before the pool could do it:
 * three reads in a row answered the same code, `isOpen()` kept saying true, and the connection was
 * unusable until Studio restarted.
 */
describe("a session the server no longer has", () => {
  test("a read that fails on a stale session runs again on a new one", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    let attempts = 0;
    const answer = await pool.withSession(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("BadSessionIdInvalid");
      return "read";
    });
    expect(answer).toBe("read");
    expect(attempts).toBe(2);
    // One new session, and the dead one closed rather than left in the server's table.
    expect(record.opened).toBe(2);
    expect(record.closed).toBe(1);
  });

  test("a second stale answer is reported rather than retried for ever", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    let attempts = 0;
    await expect(
      pool.withSession(async () => {
        attempts += 1;
        throw new Error("BadSessionIdInvalid");
      }),
    ).rejects.toThrow(/BadSessionIdInvalid/);
    expect(attempts).toBe(2);
    expect(record.opened).toBe(2);
  });

  /** Every other failure is the read's own, and spending a session on it would be a leak. */
  test("a failure that is not about the session keeps the session", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    let attempts = 0;
    await expect(
      pool.withSession(async () => {
        attempts += 1;
        throw new Error("BadNodeIdUnknown");
      }),
    ).rejects.toThrow(/BadNodeIdUnknown/);
    expect(attempts).toBe(1);
    expect(record.opened).toBe(1);
    expect(record.closed).toBe(0);
  });

  /** A timeout is the same session being slow: reopening on one would spend a session per slow read. */
  test("a timeout is not a stale session", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    await expect(
      pool.withSession(async () => {
        throw new Error("The server answered BadTimeout: the server did not answer in time.");
      }),
    ).rejects.toThrow(/BadTimeout/);
    expect(record.opened).toBe(1);
  });

  /**
   * TWO READS FAILING ON THE SAME STALE SESSION MUST NOT DROP THE FRESH ONE. The second caller's
   * `invalidate` names the client it held, and the pool has moved on, so it drops nothing: without
   * that, the fix for one defect would open a session per concurrent read.
   */
  test("the second of two readers does not drop the session the first just opened", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    const stale = await pool.acquire();
    const both = await Promise.all([
      pool.withSession(async (client) => {
        if (client === stale) throw new Error("BadSessionIdInvalid");
        return "one";
      }),
      pool.withSession(async (client) => {
        if (client === stale) throw new Error("BadSessionIdInvalid");
        return "two";
      }),
    ]);
    expect(both).toEqual(["one", "two"]);
    // One replacement, not two: the first invalidation is the one that counted.
    expect(record.opened).toBe(2);
    expect(record.closed).toBe(1);
    expect(pool.isOpen()).toBe(true);
  });

  test("the sentence a server really sends is recognised, code and all", async () => {
    for (const message of [
      "The server answered BadSessionIdInvalid: the session is no longer valid.",
      "BadSessionClosed",
      "BadConnectionClosed",
      "BadServerNotConnected",
    ]) {
      expect(isStaleSession(new Error(message))).toBe(true);
    }
    for (const message of ["BadTimeout", "BadNodeIdUnknown", "socket hang up"]) {
      expect(isStaleSession(new Error(message))).toBe(false);
    }
  });

  /**
   * A CODE THE READER TYPED IS NOT THE SERVER REPORTING ONE, and a substring match cannot tell the
   * difference. Every refusal this provider writes quotes what was asked for, so a node id travels
   * back inside the message: asked for `s=BadSessionIdInvalid`, the answer says so - and dropping a
   * HEALTHY session on that is a side effect the reader caused by naming a node. A code counts only
   * where a server can have put it: at the start of the message, or straight after this provider's
   * own "The server answered ".
   */
  /**
   * THE CONNECTION STAYS OPEN WHILE ITS SESSION IS REPLACED, and that is not cosmetic.
   * `isConnected()` is derived from this, and `getOrCreateProvider` reads `isConnected()` to decide
   * whether to reuse a provider: measured with the window visible, a second request arriving during
   * the swap was handed a SECOND provider, which opened a second session, and the first provider
   * was dropped from the cache with its own fresh session still up - a leak on the server's session
   * table, which is the one thing O-S6 exists to prevent.
   */
  test("the pool reads as open while a stale session is being replaced", async () => {
    const record = { opened: 0, closed: 0 };
    let release: (value: unknown) => void = () => {};
    let asked = 0;
    const pool = new OpcuaSessionPool(async () => {
      asked += 1;
      // The replacement blocks until this test lets it through, which is the window. `fakeClient`
      // counts the opens itself, so the gate counts the ASKS - two different numbers on purpose.
      if (asked === 2) await new Promise((resolve) => (release = resolve));
      return fakeClient(record);
    });
    const first = await pool.acquire();
    expect(pool.isOpen()).toBe(true);

    const read = pool.withSession(async (client) => {
      if (client === first) throw new Error("BadSessionIdInvalid");
      return "row";
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Mid-swap: the stale session is CLOSED and the replacement has been asked for and not yet
    // handed over, so the pool holds no session at all - and still reads as open, because the
    // connection IS open: it is between two sessions, not between two states.
    expect(asked).toBe(2);
    expect(record.opened).toBe(1);
    expect(record.closed).toBe(1);
    expect(pool.isOpen()).toBe(true);

    release(undefined);
    expect(await read).toBe("row");
    expect(pool.isOpen()).toBe(true);
    expect(record.opened).toBe(2);
  });

  test("a stale code the reader's own text contains does not drop the session", () => {
    for (const message of [
      "A read failed: the node s=BadSessionIdInvalid does not exist",
      'A read request is JSON, and this did not parse: {"read":["s=BadConnectionClosed"]}',
      "No node named BadSessionClosed under Objects. The address space may have changed.",
      "A browse failed: BadServerNotConnected",
    ]) {
      expect(isStaleSession(new Error(message))).toBe(false);
    }
    // And the two shapes that ARE the server reporting one still are, which is the control.
    expect(isStaleSession(new Error("BadSessionIdInvalid: the session is no longer valid"))).toBe(true);
    expect(isStaleSession(new Error("The server answered BadConnectionClosed: the connection closed."))).toBe(true);
  });
});

/**
 * A SESSION WHOSE CHANNEL BROKE IS REPLACED. A channel that left a request unanswered cannot be trusted with the next
 * one, and the request that went unanswered is the only sign that reaches the pool, so that is what it acts on: the
 * session is dropped and a new one opened before the failure is reported, and the request itself is not run again.
 */
describe("a request the server never answered", () => {
  const unanswered = () =>
    new OpcuaUnansweredError("A read got no answer from the server: Transaction has timed out ( timeout = 15000 ms ).");

  test("the session is replaced, and the request reports its own failure rather than running again", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    const first = await pool.acquire();
    let attempts = 0;
    const failure = await pool
      .withSession(async () => {
        attempts += 1;
        throw unanswered();
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OpcuaUnansweredError);
    expect(attempts).toBe(1);
    // The unanswered session closed, its replacement already open, and the connection open throughout.
    expect(record.closed).toBe(1);
    expect(record.opened).toBe(2);
    expect(pool.isOpen()).toBe(true);
    const next = await pool.withSession(async (client) => client);
    expect(next).not.toBe(first);
    expect(record.opened).toBe(2);
  });

  test("two requests unanswered on one session replace it once", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    const broken = await pool.acquire();
    const failures = await Promise.all(
      [1, 2].map(() =>
        pool
          .withSession(async (client) => {
            if (client === broken) throw unanswered();
            return "row";
          })
          .then(
            () => undefined,
            (error: unknown) => error,
          ),
      ),
    );
    expect(failures.every((error) => error instanceof OpcuaUnansweredError)).toBe(true);
    expect(record.closed).toBe(1);
    expect(record.opened).toBe(2);
    expect(await pool.withSession(async () => "row")).toBe("row");
  });

  test("a request unanswered on the session that replaced a stale one replaces that one too", async () => {
    const record = { opened: 0, closed: 0 };
    const pool = new OpcuaSessionPool(async () => fakeClient(record));
    let attempts = 0;
    const failure = await pool
      .withSession(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("BadSessionIdInvalid");
        throw unanswered();
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OpcuaUnansweredError);
    expect(attempts).toBe(2);
    // The stale session and the unanswered one both closed, and a third open for the next request.
    expect(record.closed).toBe(2);
    expect(record.opened).toBe(3);
    expect(pool.isOpen()).toBe(true);
  });

  test("a replacement that cannot be opened is reported, and the connection then reads as closed", async () => {
    const record = { opened: 0, closed: 0 };
    let refuse = false;
    const pool = new OpcuaSessionPool(async () => {
      if (refuse) throw new Error("This connection could not be opened to opc.tcp://plant:4840: ECONNREFUSED");
      return fakeClient(record);
    });
    await pool.acquire();
    refuse = true;
    const failure = await pool
      .withSession(async () => {
        throw unanswered();
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(String((failure as Error).message)).toMatch(/could not be opened/);
    expect(record.closed).toBe(1);
    expect(pool.isOpen()).toBe(false);
  });

  test("a replacement refused with a stale-session code is reported as it is, and the request is not run again", async () => {
    const record = { opened: 0, closed: 0 };
    let refuse = false;
    let asked = 0;
    const pool = new OpcuaSessionPool(async () => {
      asked += 1;
      if (refuse) throw new Error("The server answered BadServerNotConnected: the server is not connected.");
      return fakeClient(record);
    });
    await pool.acquire();
    refuse = true;
    let attempts = 0;
    const failure = await pool
      .withSession(async () => {
        attempts += 1;
        throw unanswered();
      })
      .then(
        () => "resolved",
        (error: unknown) => error,
      );
    expect(String((failure as Error).message)).toBe(
      "The server answered BadServerNotConnected: the server is not connected.",
    );
    // One run, and one replacement asked for: the refusal is not read as a stale session to open a third for.
    expect(attempts).toBe(1);
    expect(asked).toBe(2);
    expect(record.closed).toBe(1);
    expect(pool.isOpen()).toBe(false);
  });

  /** Open throughout, as in the stale-session swap: `isConnected()` is derived from it, and the factory reads that. */
  test("the pool reads as open while an unanswered session is being replaced", async () => {
    const record = { opened: 0, closed: 0 };
    let release: (value: unknown) => void = () => {};
    let reached: (value: unknown) => void = () => {};
    const inWindow = new Promise((resolve) => (reached = resolve));
    let asked = 0;
    const pool = new OpcuaSessionPool(async () => {
      asked += 1;
      if (asked === 2) {
        reached(undefined);
        await new Promise((resolve) => (release = resolve));
      }
      return fakeClient(record);
    });
    await pool.acquire();
    const read = pool
      .withSession(async () => {
        throw unanswered();
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await inWindow;
    // Mid-swap: the unanswered session is closed and its replacement asked for and not yet handed over.
    expect(record.closed).toBe(1);
    expect(record.opened).toBe(1);
    expect(pool.isOpen()).toBe(true);

    release(undefined);
    expect(await read).toBeInstanceOf(OpcuaUnansweredError);
    expect(record.opened).toBe(2);
    expect(pool.isOpen()).toBe(true);
  });
});
