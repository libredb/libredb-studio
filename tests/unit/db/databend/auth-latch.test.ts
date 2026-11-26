/**
 * The sign-in latch of design 3.5: the key (scheme, far end in one spelling, bastion route, user and password, framed
 * and hashed, never the local forward [X03]), the signals that set it and the in-body 2215 that does not, a proof that
 * only an answer gives, the 15 minutes on an injected clock, the 256-entry bound that evicts expired entries first,
 * then the oldest proven one, and a latched one last [X30], and single flight per unproven key [X14]. No test waits on
 * a real timer.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  AUTH_LATCH_MAX_ENTRIES,
  AUTH_LATCH_TTL_MS,
  type AuthAttempt,
  type AuthLatchIdentity,
  authLatchKey,
  createAuthLatch,
} from "@/lib/db/providers/sql/databend/auth-latch";
import { latchedError, type SignInAnswer, DATABEND_ERROR_SENTENCES } from "@/lib/db/providers/sql/databend/errors";
import { DatabendError } from "@/lib/db/providers/sql/databend/transport";
import path from "node:path";
import { readFileSync } from "node:fs";

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
const TEST_USER = "reader";
const TEST_PASSWORD = "password";
const START = Date.UTC(2026, 9, 8, 1, 0, 0);
/** An answer read as one, which alone proves a key. */
const OK = "answer";
const WRONG_PASSWORD = { status: 401, code: 5100 } as const;
const LOCKED = { status: 500, code: 2215 } as const;

const IDENTITY: AuthLatchIdentity = {
  scheme: "http",
  host: "databend.test",
  port: 8000,
  route: "",
  user: TEST_USER,
  password: TEST_PASSWORD,
};

function clock(start = START) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const live = () => new AbortController().signal;

/** Ends an attempt as the transport does: an answer proves the key, a refusal is reported, and the attempt is released. */
function end(attempt: AuthAttempt, answer: typeof OK | SignInAnswer): void {
  if (answer === OK) attempt.prove();
  else attempt.refuse(answer);
  attempt.release();
}

/** Settles on the next turns of the event loop, so a promise that is still waiting stays pending. */
async function settled<T>(promise: Promise<T>): Promise<"pending" | "resolved" | "rejected"> {
  let state: "pending" | "resolved" | "rejected" = "pending";
  promise.then(
    () => {
      state = "resolved";
    },
    () => {
      state = "rejected";
    },
  );
  // oxlint-disable-next-line no-await-in-loop -- each await yields one turn, which is the point.
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  return state;
}

/**
 * Settles each key in turn with one answer, moving the clock by `step` after each: the map keeps the order of its
 * writes, so they may not run at once.
 */
async function writeEach(
  latch: ReturnType<typeof createAuthLatch>,
  keys: readonly string[],
  answer: typeof OK | SignInAnswer,
  time?: { readonly advance: (ms: number) => void; readonly step: number },
): Promise<void> {
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- each write must land before the next, in order.
    end(await latch.acquire(key, live()), answer);
    time?.advance(time.step);
  }
}

/** Every key is refused, latched. */
async function allLatched(latch: ReturnType<typeof createAuthLatch>, keys: readonly string[]): Promise<void> {
  const errors = await Promise.all(keys.map((key) => refusal(latch.acquire(key, live()))));
  for (const error of errors) expect(error.category).toBe("auth");
}

async function refusal(promise: Promise<unknown>): Promise<DatabendError> {
  try {
    await promise;
  } catch (error) {
    return error as DatabendError;
  }
  throw new Error("expected a refusal");
}

describe("authLatchKey", () => {
  test("is a hex digest keyed per process, holding neither the password nor the user", () => {
    const key = authLatchKey(IDENTITY);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(authLatchKey({ ...IDENTITY })).toBe(key);
    // Keyed: the bare SHA-256 of the same framed fields is not the key, so a key seen outside the process cannot be
    // used to test a guessed password.
    const { scheme, host, port, route, user, password } = IDENTITY;
    const framed = [scheme, host, String(port), route, user, password].map((value) => `${value.length}:${value}`);
    expect(key).not.toBe(createHash("sha256").update(framed.join(""), "utf8").digest("hex"));
    expect(key).not.toContain(TEST_PASSWORD);
    expect(key).not.toContain(TEST_USER);
    expect(key).not.toContain(Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString("hex"));
  });

  test("changes with each framed field: scheme, host, port, bastion route, user and password", () => {
    const base = authLatchKey(IDENTITY);
    const variants: Partial<AuthLatchIdentity>[] = [
      { scheme: "https" },
      { host: "other.test" },
      { port: 8001 },
      { route: "4:true9:bastion.a2:224:jump" },
      { user: "writer" },
      { password: "password2" },
      { password: "" },
    ];
    for (const variant of variants) expect(authLatchKey({ ...IDENTITY, ...variant })).not.toBe(base);
  });

  test("is length-framed, so text cannot slide from one field into the next", () => {
    expect(authLatchKey({ ...IDENTITY, user: "ab", password: "c" })).not.toBe(
      authLatchKey({ ...IDENTITY, user: "a", password: "bc" }),
    );
  });

  test("frames one spelling of a host: an IPv6 literal however it is written, a DNS name without its final dot", () => {
    const keyOf = (host: string) => authLatchKey({ ...IDENTITY, host });
    for (const spellings of [
      ["::1", "0:0:0:0:0:0:0:1", "0::1", "0000:0000:0000:0000:0000:0000:0000:0001"],
      ["2001:db8::1", "2001:db8:0:0:0:0:0:1", "2001:0db8::0001"],
      ["::ffff:127.0.0.1", "::ffff:7f00:1"],
      ["databend.test", "databend.test."],
      ["localhost", "localhost."],
    ]) {
      expect(new Set(spellings.map(keyOf)).size).toBe(1);
    }
    expect(keyOf("::1")).not.toBe(keyOf("::2"));
    expect(keyOf("databend.test")).not.toBe(keyOf("databend.test.example"));
  });
});

describe("the latch", () => {
  test("a refused sign-in latches its key: the next acquire is refused with the dated sentence and nothing is sent", async () => {
    const time = clock();
    const latch = createAuthLatch({ now: time.now });
    const key = authLatchKey(IDENTITY);
    end(await latch.acquire(key, live()), WRONG_PASSWORD);
    time.advance(60_000);
    const error = await refusal(latch.acquire(key, live()));
    expect(error).toBeInstanceOf(DatabendError);
    expect(error.category).toBe("auth");
    expect(error.message).toBe(latchedError(new Date(START), new Date(START + AUTH_LATCH_TTL_MS)).message);
    expect(error.message).toStartWith("Databend refused this sign-in at 2026-10-08 01:00");
    expect(error.message).toContain("again before 2026-10-08 01:15");
  });

  test("a refusal says whether it latched the key", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const attempt = await latch.acquire(authLatchKey(IDENTITY), live());
    expect(attempt.refuse({ status: 503 })).toBe(false);
    expect(attempt.refuse(WRONG_PASSWORD)).toBe(true);
  });

  test("a gateway sign-in refusal over HTTP 200 latches like one over 401 (HASIM-D-3)", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    const gateway = await latch.acquire(key, live());
    expect(gateway.refuse({ status: 200, gatewayKind: "AuthorizationFailed" })).toBe(true);
    gateway.release();
    expect((await refusal(latch.acquire(key, live()))).category).toBe("auth");
  });

  test.each([
    ["a resuming warehouse still refused after its retries", { status: 200, gatewayKind: "ProvisionWarehouseTimeout" }],
    ["a 2215", { status: 200, code: 2215 }],
  ])(
    "only an answer proves a key: %s over HTTP 200 leaves it unproven, so the next attempt flies alone",
    async (_label, answer) => {
      const latch = createAuthLatch({ now: clock().now });
      const key = authLatchKey(IDENTITY);
      end(await latch.acquire(key, live()), answer);
      await latch.acquire(key, live());
      expect(await settled(latch.acquire(key, live()))).toBe("pending");
    },
  );

  test("the latch lifts after 15 minutes on the injected clock, and not a millisecond before", async () => {
    const time = clock();
    const latch = createAuthLatch({ now: time.now });
    const key = authLatchKey(IDENTITY);
    end(await latch.acquire(key, live()), LOCKED);
    time.advance(AUTH_LATCH_TTL_MS - 1);
    expect((await refusal(latch.acquire(key, live()))).category).toBe("auth");
    time.advance(1);
    expect(await settled(latch.acquire(key, live()))).toBe("resolved");
  });

  test("a new password is a new key, which the latch does not hold", async () => {
    const latch = createAuthLatch({ now: clock().now });
    end(await latch.acquire(authLatchKey(IDENTITY), live()), WRONG_PASSWORD);
    expect(await settled(latch.acquire(authLatchKey({ ...IDENTITY, password: "password2" }), live()))).toBe("resolved");
  });

  test("a proven key that is later refused latches", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    end(await latch.acquire(key, live()), OK);
    end(await latch.acquire(key, live()), LOCKED);
    expect((await refusal(latch.acquire(key, live()))).category).toBe("auth");
  });

  test("a refusal reported after the attempt proved its key still latches it, as a page refused mid-statement does", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    const attempt = await latch.acquire(key, live());
    attempt.prove();
    expect(attempt.refuse(WRONG_PASSWORD)).toBe(true);
    attempt.release();
    expect((await refusal(latch.acquire(key, live()))).category).toBe("auth");
  });

  test("a late answer from an attempt acquired before a newer latch does not lift it", async () => {
    const time = clock();
    const latch = createAuthLatch({ now: time.now });
    const key = authLatchKey(IDENTITY);
    end(await latch.acquire(key, live()), OK);
    const stale = await latch.acquire(key, live());
    time.advance(AUTH_LATCH_TTL_MS);
    end(await latch.acquire(key, live()), LOCKED);
    stale.prove();
    expect((await refusal(latch.acquire(key, live()))).category).toBe("auth");
  });
});

describe("eviction [X30]", () => {
  const keys = Array.from({ length: AUTH_LATCH_MAX_ENTRIES + 1 }, (_, index) =>
    authLatchKey({ ...IDENTITY, user: `user${index}` }),
  );

  test("holds at most 256 entries", () => {
    expect(AUTH_LATCH_MAX_ENTRIES).toBe(256);
  });

  test("entries past their 15 minutes make room before any live entry is evicted", async () => {
    const time = clock();
    const latch = createAuthLatch({ now: time.now });
    await writeEach(latch, keys.slice(0, 10), WRONG_PASSWORD);
    time.advance(AUTH_LATCH_TTL_MS / 2);
    await writeEach(latch, keys.slice(10, AUTH_LATCH_MAX_ENTRIES), WRONG_PASSWORD);
    time.advance(AUTH_LATCH_TTL_MS / 2);
    const fresh = Array.from({ length: 10 }, (_, index) => authLatchKey({ ...IDENTITY, user: `fresh${index}` }));
    await writeEach(latch, fresh, WRONG_PASSWORD);
    await allLatched(latch, [...keys.slice(10, AUTH_LATCH_MAX_ENTRIES), ...fresh]);
  });

  test("an expired entry goes first even when it is not the oldest, as after the wall clock steps back", async () => {
    const time = clock(START + 2 * AUTH_LATCH_TTL_MS);
    const latch = createAuthLatch({ now: time.now });
    // The oldest entry is written at a time the clock then steps back from, so it stays live the longest.
    end(await latch.acquire(keys[0], live()), WRONG_PASSWORD);
    time.advance(-2 * AUTH_LATCH_TTL_MS);
    end(await latch.acquire(keys[1], live()), WRONG_PASSWORD);
    time.advance(1);
    await writeEach(latch, keys.slice(2, AUTH_LATCH_MAX_ENTRIES), WRONG_PASSWORD);
    // Entry 1 alone has expired; entry 0 is the oldest in order and still latched.
    time.advance(AUTH_LATCH_TTL_MS - 1);
    end(await latch.acquire(keys[AUTH_LATCH_MAX_ENTRIES], live()), WRONG_PASSWORD);
    expect((await refusal(latch.acquire(keys[0], live()))).category).toBe("auth");
    expect((await refusal(latch.acquire(keys[2], live()))).category).toBe("auth");
    expect((await refusal(latch.acquire(keys[AUTH_LATCH_MAX_ENTRIES], live()))).category).toBe("auth");
  });

  test("with every entry latched and live, a new refusal evicts the oldest latched one", async () => {
    const time = clock();
    const latch = createAuthLatch({ now: time.now });
    await writeEach(latch, keys.slice(0, AUTH_LATCH_MAX_ENTRIES), WRONG_PASSWORD, { advance: time.advance, step: 1 });
    end(await latch.acquire(keys[AUTH_LATCH_MAX_ENTRIES], live()), WRONG_PASSWORD);
    expect(await settled(latch.acquire(keys[0], live()))).toBe("resolved");
    expect((await refusal(latch.acquire(keys[1], live()))).category).toBe("auth");
    expect((await refusal(latch.acquire(keys[AUTH_LATCH_MAX_ENTRIES], live()))).category).toBe("auth");
  });

  test("a key written again moves to the newest place", async () => {
    const time = clock();
    const latch = createAuthLatch({ now: time.now });
    await writeEach(latch, keys.slice(0, AUTH_LATCH_MAX_ENTRIES), OK, { advance: time.advance, step: 1 });
    end(await latch.acquire(keys[0], live()), WRONG_PASSWORD);
    end(await latch.acquire(keys[AUTH_LATCH_MAX_ENTRIES], live()), OK);
    expect((await refusal(latch.acquire(keys[0], live()))).category).toBe("auth");
  });

  test("256 sign-ins proven on other keys, one second apart, leave a latched key latched (HASIM-D-7)", async () => {
    const time = clock();
    const latch = createAuthLatch({ now: time.now });
    const victim = authLatchKey({ ...IDENTITY, user: "victim" });
    end(await latch.acquire(victim, live()), WRONG_PASSWORD);
    await writeEach(latch, keys.slice(0, AUTH_LATCH_MAX_ENTRIES), OK, { advance: time.advance, step: 1000 });
    expect((await refusal(latch.acquire(victim, live()))).category).toBe("auth");
  });

  test("the oldest proven entry goes before a latched one that is older still", async () => {
    const time = clock();
    const latch = createAuthLatch({ now: time.now });
    const step = { advance: time.advance, step: 1 };
    await writeEach(latch, keys.slice(0, 1), WRONG_PASSWORD, step);
    await writeEach(latch, keys.slice(1, AUTH_LATCH_MAX_ENTRIES), OK, step);
    end(await latch.acquire(keys[AUTH_LATCH_MAX_ENTRIES], live()), WRONG_PASSWORD);
    expect((await refusal(latch.acquire(keys[0], live()))).category).toBe("auth");
    // Entry 1, the oldest proven one, went: an acquire on it holds the flight again, and a second one waits.
    const holder = await latch.acquire(keys[1], live());
    expect(await settled(latch.acquire(keys[1], live()))).toBe("pending");
    holder.release();
    // Entry 2 is still proven, so it never waits.
    await latch.acquire(keys[2], live());
    expect(await settled(latch.acquire(keys[2], live()))).toBe("resolved");
  });

  test("a proof is never kept at the cost of a latched entry: with every entry latched and live, it is not written", async () => {
    const time = clock();
    const latch = createAuthLatch({ now: time.now });
    await writeEach(latch, keys.slice(0, AUTH_LATCH_MAX_ENTRIES), WRONG_PASSWORD, { advance: time.advance, step: 1 });
    end(await latch.acquire(keys[AUTH_LATCH_MAX_ENTRIES], live()), OK);
    await allLatched(latch, keys.slice(0, AUTH_LATCH_MAX_ENTRIES));
    // The proof was not written, so the key is still unproven: one attempt at a time.
    await latch.acquire(keys[AUTH_LATCH_MAX_ENTRIES], live());
    expect(await settled(latch.acquire(keys[AUTH_LATCH_MAX_ENTRIES], live()))).toBe("pending");
  });
});

describe("single flight [X14]", () => {
  test("a second acquire on an unproven key waits, then is refused unsent once the first latches and is released", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    const first = await latch.acquire(key, live());
    const second = latch.acquire(key, live());
    const third = latch.acquire(key, live());
    expect(await settled(second)).toBe("pending");
    first.refuse(WRONG_PASSWORD);
    first.release();
    expect((await refusal(second)).message).toBe(
      latchedError(new Date(START), new Date(START + AUTH_LATCH_TTL_MS)).message,
    );
    expect((await refusal(third)).category).toBe("auth");
  });

  test("a refusal holds the flight until its attempt is released, so a waiter goes only after the closes (HASIM-D-1)", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    const first = await latch.acquire(key, live());
    const second = latch.acquire(key, live());
    // The POST's 502 latches nothing, and the kill the run then sends is refused as a sign-in.
    first.refuse({ status: 502 });
    expect(await settled(second)).toBe("pending");
    first.refuse(WRONG_PASSWORD);
    expect(await settled(second)).toBe("pending");
    first.release();
    expect((await refusal(second)).category).toBe("auth");
  });

  test("a waiting acquire proceeds once the first proves the key, as does every other waiter", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    const first = await latch.acquire(key, live());
    const second = latch.acquire(key, live());
    const third = latch.acquire(key, live());
    first.prove();
    expect(await settled(second)).toBe("resolved");
    expect(await settled(third)).toBe("resolved");
  });

  test("a waiting acquire times out unsent when its own deadline fires first, with the signal's reason", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    await latch.acquire(key, live());
    const deadline = new AbortController();
    const second = latch.acquire(key, deadline.signal);
    const reason = new Error("deadline");
    deadline.abort(reason);
    expect(await refusal(second)).toBe(reason as DatabendError);
  });

  test("an acquire whose signal has already fired is refused before it waits", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    await latch.acquire(key, live());
    const reason = new Error("cancelled");
    expect(await refusal(latch.acquire(key, AbortSignal.abort(reason)))).toBe(reason as DatabendError);
  });

  test("a timed-out waiter leaves the queue: the next release goes to the waiter behind it", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    const first = await latch.acquire(key, live());
    const deadline = new AbortController();
    const second = latch.acquire(key, deadline.signal);
    const third = latch.acquire(key, live());
    deadline.abort(new Error("deadline"));
    await refusal(second);
    first.release();
    expect(await settled(third)).toBe("resolved");
  });

  test("an attempt released with neither a proof nor a latch hands the flight to one waiter, and the next keeps waiting", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    const first = await latch.acquire(key, live());
    const second = latch.acquire(key, live());
    const third = latch.acquire(key, live());
    first.refuse({ status: 503 });
    first.release();
    expect(await settled(second)).toBe("resolved");
    expect(await settled(third)).toBe("pending");
    (await second).release();
    expect(await settled(third)).toBe("resolved");
    (await third).release();
    // The flight is free again: the next acquire does not wait.
    expect(await settled(latch.acquire(key, live()))).toBe("resolved");
  });

  test("releasing an attempt twice hands the flight on once", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    const first = await latch.acquire(key, live());
    const second = latch.acquire(key, live());
    const third = latch.acquire(key, live());
    first.release();
    first.release();
    expect(await settled(second)).toBe("resolved");
    expect(await settled(third)).toBe("pending");
  });

  test("a proven key never waits", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    end(await latch.acquire(key, live()), OK);
    const first = latch.acquire(key, live());
    const second = latch.acquire(key, live());
    expect(await settled(first)).toBe("resolved");
    expect(await settled(second)).toBe("resolved");
  });

  test("an attempt on a proven key releases nothing when it ends with no answer", async () => {
    const latch = createAuthLatch({ now: clock().now });
    const key = authLatchKey(IDENTITY);
    end(await latch.acquire(key, live()), OK);
    (await latch.acquire(key, live())).release();
    expect(await settled(latch.acquire(key, live()))).toBe("resolved");
  });

  test("two keys fly independently", async () => {
    const latch = createAuthLatch({ now: clock().now });
    await latch.acquire(authLatchKey(IDENTITY), live());
    expect(await settled(latch.acquire(authLatchKey({ ...IDENTITY, user: "writer" }), live()))).toBe("resolved");
  });
});

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

describe("the latch's promise", () => {
  test("the sign-in latch is promised for one Studio process, wherever it is promised", () => {
    // The sentence a latched run reads makes the same promise, for the one server that latched (RI-6).
    const latched = DATABEND_ERROR_SENTENCES.latched("[time]", "[until]");
    expect(latched).toContain("so this Studio server will not send this password again");
    expect(read("docs/DATABASE_PROVIDERS.md")).toContain(
      "auth-latch.ts   #   A refused sign-in is not sent again by this process for 15 minutes",
    );
    const features = read("docs/FEATURES.md")
      .split("\n")
      .find((line) => line.includes("**Databend:**"));
    expect(features).toContain("Each Studio process sends a sign-in Databend refused at most once per 15 minutes");
  });
});
