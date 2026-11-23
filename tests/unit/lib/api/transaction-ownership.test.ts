import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import type { SessionState } from "@libredb/provider-sdk/errors";
import type { QueryEventInput } from "@/lib/query-events/types";
import { queryEventStart } from "@/lib/query-events/build";

// The sink is replaced, so a recorded event is read here instead of being queued for the governance pool
// (`src/lib/query-events/sink.ts`).
const recorded: QueryEventInput[] = [];
mock.module("@/lib/query-events/sink", () => ({
  recordQueryEvent: (input: QueryEventInput) => {
    recorded.push(input);
  },
}));

const {
  awaitStoppedCall,
  callsRunning,
  claimTransaction,
  endOwnerTransactions,
  endTransactionEvent,
  finishOwnerCall,
  markTransaction,
  OWNERSHIP_IDLE_MS,
  recordEndSeen,
  releaseIfProviderChanged,
  releaseTransaction,
  resolveTransaction,
  settleTransaction,
  startOwnerCall,
  stopOwnerCall,
  stoppedCallRunning,
  TRANSACTION_TIMEOUT_CHECK_MS,
  TRANSACTION_TIMEOUT_RECHECK_MS,
  transactionKey,
  transactionOwner,
  watchTransactionTimeout,
} = await import("@/lib/api/transaction-ownership");

/** The scope a governed begin gives its transaction's events. */
const SCOPE = {
  principal: { subject: "alice-subject", username: "alice@example.com", role: "user" as const },
  connection: { id: "seed:orders", name: "Orders", engine: "postgres" as const, accessLevel: "write" as const },
};

// Under governance a transaction runs on the provider its owner's begin resolved, and that provider's cache key frames
// the credential of the owner's grant level (docs/GOVERNANCE.md#per-user-providers). The record keeps that key, so a
// later request that resolves another key, because the grant level or the credential changed, is told the transaction
// no longer belongs to the provider it is answered on.
const GOVERNED = transactionKey("seed:orders", undefined, "alice-subject");
const SHARED = transactionKey("orders");

/** Core's scrub of the provider a governed begin ran on: the forms of the credential that begin resolved. */
const WRITE_SCRUB = { type: "postgres" as const, forms: [crypto.randomUUID()] };

afterEach(() => {
  releaseTransaction(GOVERNED);
  releaseTransaction(SHARED);
  recorded.length = 0;
});

/**
 * The watch's state read as a double: `state` answers each read, and `settled` resolves once every read the timer
 * started has answered and the microtasks after it ran, so a case waits on the read, never on a timer.
 */
function stateReader(state: () => SessionState) {
  const reader = { reads: 0, answers: [] as Promise<SessionState>[] };
  return {
    get reads() {
      return reader.reads;
    },
    readState: (): Promise<SessionState> => {
      reader.reads += 1;
      const answer = Promise.resolve(state());
      reader.answers.push(answer);
      return answer;
    },
    settled: async (): Promise<void> => {
      await Promise.all(reader.answers);
      // The watch acts on the answer in the reaction after it.
      await Promise.resolve();
    },
  };
}

/**
 * Runs the fake clock to the watch's first look, with the owner acting just before it, so the lease is live and the
 * watch's repeated looks run (they stop once the lease has lapsed).
 */
function firstLookOnLiveLease(owner: { lastActiveAt: number }): void {
  jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS - 1);
  owner.lastActiveAt = Date.now();
  jest.advanceTimersByTime(1);
}

describe("transaction ownership records", () => {
  test("the record keeps the provider cache key its begin resolved and that provider's scrub", () => {
    claimTransaction(
      GOVERNED,
      "alice@example.com",
      "alice-subject",
      "provider-key-of-the-write-credential",
      undefined,
      WRITE_SCRUB,
    );

    expect(transactionOwner(GOVERNED)).toMatchObject({
      username: "alice@example.com",
      subject: "alice-subject",
      providerKey: "provider-key-of-the-write-credential",
      providerScrub: WRITE_SCRUB,
    });

    // Without governance a record names neither a subject nor a provider key, as before owners existed.
    claimTransaction(SHARED, "alice");
    const shared = transactionOwner(SHARED);
    expect(shared?.username).toBe("alice");
    expect(shared?.subject).toBeUndefined();
    expect(shared?.providerKey).toBeUndefined();
    expect(shared?.providerScrub).toBeUndefined();
  });

  test("a request that resolves another provider key releases the record and learns the key it was opened on", () => {
    claimTransaction(
      GOVERNED,
      "alice@example.com",
      "alice-subject",
      "provider-key-of-the-write-credential",
      undefined,
      WRITE_SCRUB,
    );

    // The key the begin resolved: the record stays, so the owner keeps its transaction.
    expect(releaseIfProviderChanged(GOVERNED, "provider-key-of-the-write-credential")).toBeNull();
    expect(transactionOwner(GOVERNED)).not.toBeNull();

    // Another key: the record is released at once, and the caller is handed the key of the provider that holds it.
    const released = releaseIfProviderChanged(GOVERNED, "provider-key-of-the-read-credential");
    expect(released?.providerKey).toBe("provider-key-of-the-write-credential");
    // And the scrub of that provider's credential, so a failed rollback on it is logged through the right one.
    expect(released?.providerScrub).toBe(WRITE_SCRUB);
    expect(transactionOwner(GOVERNED)).toBeNull();
    // Released once: a second request finds nothing left to release.
    expect(releaseIfProviderChanged(GOVERNED, "provider-key-of-the-read-credential")).toBeNull();
  });

  test("a record that names a provider key without its scrub is refused on release, never released unscrubbed", () => {
    claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "provider-key-of-the-write-credential");

    expect(() => releaseIfProviderChanged(GOVERNED, "provider-key-of-the-read-credential")).toThrow(
      "A transaction record that names a provider key must keep that provider's scrub",
    );
    expect(transactionOwner(GOVERNED)?.providerKey).toBe("provider-key-of-the-write-credential");
  });

  test("a record that names no provider key is never compared, so a record without governance is left alone", () => {
    claimTransaction(SHARED, "alice");

    expect(releaseIfProviderChanged(SHARED, "provider-key-of-the-read-credential")).toBeNull();
    expect(transactionOwner(SHARED)?.username).toBe("alice");
  });
});

// The query events of a governed transaction (docs/GOVERNANCE.md#query-events).
describe("transaction events", () => {
  test("a provider that rolled back on its own timer yields exactly one timed-out event", async () => {
    jest.useFakeTimers();
    try {
      let open = true;
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      const read = stateReader(() => (open ? "in-transaction" : "not-in-transaction"));
      watchTransactionTimeout(GOVERNED, owner, read.readState);

      // The provider's TX_TIMEOUT_MS rolls the transaction back five minutes after BEGIN, with no session behind it.
      open = false;
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS - 1);
      expect(read.reads).toBe(0);
      jest.advanceTimersByTime(1);
      await read.settled();

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        source: "transaction",
        ...SCOPE,
        statement: null,
        status: "cancelled",
        transactionId: owner.transactionId,
        transactionOutcome: "timed-out",
      });
      // The lease, measured from BEGIN here, lapsed with it, and its expiry sees the same end and records nothing more;
      // neither does the route's reconcile.
      expect(transactionOwner(GOVERNED)).toBeNull();
      recordEndSeen(owner);
      expect(recorded).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the reconcile seeing the expiry first leaves the timer nothing to record", async () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      const read = stateReader(() => "not-in-transaction");
      watchTransactionTimeout(GOVERNED, owner, read.readState);
      // The route's reconcile: the provider holds no transaction, so the record is released and the end recorded.
      resolveTransaction(GOVERNED, owner, "not-in-transaction", markTransaction(GOVERNED));
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
      await read.settled();
      expect(recorded.map((event) => event.transactionOutcome)).toEqual(["timed-out"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a lease that lapses first records the timeout, and the timer then records nothing", async () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      const read = stateReader(() => "not-in-transaction");
      watchTransactionTimeout(GOVERNED, owner, read.readState);
      jest.advanceTimersByTime(OWNERSHIP_IDLE_MS);
      expect(transactionOwner(GOVERNED)).toBeNull();
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
      await read.settled();
      expect(recorded.map((event) => event.transactionOutcome)).toEqual(["timed-out"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the timer records nothing for a transaction still open or one that another replaced", async () => {
    jest.useFakeTimers();
    try {
      const first = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      const firstRead = stateReader(() => "not-in-transaction");
      watchTransactionTimeout(GOVERNED, first, firstRead.readState);
      // Committed and begun again: the new record carries another transaction id.
      endTransactionEvent(first, "committed", { statement: "COMMIT", status: "success", started: queryEventStart() });
      const second = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      expect(second.transactionId).not.toBe(first.transactionId);
      const secondRead = stateReader(() => "in-transaction");
      watchTransactionTimeout(GOVERNED, second, secondRead.readState);
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
      await Promise.all([firstRead.settled(), secondRead.settled()]);
      // Only the COMMIT's own end: neither timer records one.
      expect(recorded.map((event) => event.transactionOutcome)).toEqual(["committed"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("without governance a record carries a transaction id and records no event", () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(SHARED, "alice");
      expect(owner.transactionId).toMatch(/^[0-9a-f-]{36}$/);
      const read = stateReader(() => "not-in-transaction");
      watchTransactionTimeout(SHARED, owner, read.readState);
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
      // Without governance no timer is armed, so the state is never read.
      expect(read.reads).toBe(0);
      recordEndSeen(owner);
      expect(recorded).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a teardown records rolled-back once for each open transaction of the pair, in every database", () => {
    const shop = transactionKey("seed:orders", "shop", "alice-subject");
    const other = transactionKey("seed:orders", undefined, "bob-subject");
    try {
      const own = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      const inShop = claimTransaction(shop, "alice@example.com", "alice-subject", "key", SCOPE);
      claimTransaction(other, "bob@example.com", "bob-subject", "key", {
        ...SCOPE,
        principal: { ...SCOPE.principal, subject: "bob-subject" },
      });

      endOwnerTransactions("seed:orders", "alice-subject");
      endOwnerTransactions("seed:orders", "alice-subject");
      endOwnerTransactions("seed:billing", "alice-subject");

      expect(recorded.map((event) => [event.transactionId, event.transactionOutcome, event.statement])).toEqual([
        [own.transactionId, "rolled-back", "ROLLBACK"],
        [inShop.transactionId, "rolled-back", "ROLLBACK"],
      ]);
      // The records stay, so the owner's next request still learns what happened.
      expect(transactionOwner(GOVERNED)).toBe(own);
    } finally {
      releaseTransaction(shop);
      releaseTransaction(other);
    }
  });
});

// The record while the session state is unknown (docs/providers/CONTRACT.md, clause C-58).
describe("a record whose session state is unknown", () => {
  const outcomes = () => recorded.map((event) => [event.transactionOutcome, event.statement, event.status]);

  test("the owner's own call settles the record by the state it answered", () => {
    const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    expect(owner.unresolved).toBe(false);
    const claimedAt = owner.lastActiveAt;
    owner.lastActiveAt = claimedAt - 1_000;

    settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
    expect(transactionOwner(GOVERNED)).toBe(owner);
    expect(owner.unresolved).toBe(true);
    expect(owner.lastActiveAt).toBe(claimedAt - 1_000);

    settleTransaction(GOVERNED, "in-transaction", markTransaction(GOVERNED));
    expect(owner.unresolved).toBe(false);
    expect(owner.lastActiveAt).toBeGreaterThanOrEqual(claimedAt);

    settleTransaction(GOVERNED, "not-in-transaction", markTransaction(GOVERNED));
    expect(transactionOwner(GOVERNED)).toBeNull();
    // Settling releases and records nothing: the call that ended the transaction records its own end.
    expect(recorded).toEqual([]);
    // No record: nothing to settle.
    settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
    expect(transactionOwner(GOVERNED)).toBeNull();
  });

  test("the reconcile resolves a record by the state it read, and an end seen on an unknown state is recorded unknown", () => {
    const resolved = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    resolveTransaction(GOVERNED, resolved, "not-in-transaction", markTransaction(GOVERNED));
    expect(transactionOwner(GOVERNED)).toBeNull();

    const unresolved = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
    const lastActive = unresolved.lastActiveAt - 1_000;
    unresolved.lastActiveAt = lastActive;
    resolveTransaction(GOVERNED, unresolved, "unknown", markTransaction(GOVERNED));
    expect(transactionOwner(GOVERNED)).toBe(unresolved);
    expect(unresolved.unresolved).toBe(true);
    resolveTransaction(GOVERNED, unresolved, "in-transaction", markTransaction(GOVERNED));
    expect(unresolved.unresolved).toBe(false);
    // Another session's status read must not extend the owner's lease.
    expect(unresolved.lastActiveAt).toBe(lastActive);

    settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
    resolveTransaction(GOVERNED, unresolved, "not-in-transaction", markTransaction(GOVERNED));
    expect(transactionOwner(GOVERNED)).toBeNull();

    expect(outcomes()).toEqual([
      ["timed-out", null, "cancelled"],
      ["unknown", null, "cancelled"],
    ]);
  });

  test("a call Studio stopped waiting for keeps the record unresolved until it settles, whatever a read or answer finds open", async () => {
    const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    expect(stoppedCallRunning(owner)).toBe(false);
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
    awaitStoppedCall(GOVERNED, first.promise);
    awaitStoppedCall(GOVERNED, second.promise);
    expect(stoppedCallRunning(owner)).toBe(true);

    // The provider still reports the transaction open while the stopped call runs: that is no evidence of its end.
    resolveTransaction(GOVERNED, owner, "in-transaction", markTransaction(GOVERNED));
    settleTransaction(GOVERNED, "in-transaction", markTransaction(GOVERNED));
    expect(owner.unresolved).toBe(true);

    first.resolve();
    await first.promise;
    expect(stoppedCallRunning(owner)).toBe(true);
    resolveTransaction(GOVERNED, owner, "in-transaction", markTransaction(GOVERNED));
    expect(owner.unresolved).toBe(true);

    second.resolve();
    await second.promise;
    expect(stoppedCallRunning(owner)).toBe(false);
    resolveTransaction(GOVERNED, owner, "in-transaction", markTransaction(GOVERNED));
    expect(owner.unresolved).toBe(false);

    settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
    awaitStoppedCall(GOVERNED, Promise.resolve());
    await Promise.resolve();
    settleTransaction(GOVERNED, "in-transaction", markTransaction(GOVERNED));
    expect(owner.unresolved).toBe(false);

    // No record: nothing to hold.
    releaseTransaction(GOVERNED);
    const orphan = Promise.withResolvers<void>();
    awaitStoppedCall(GOVERNED, orphan.promise);
    expect(transactionOwner(GOVERNED)).toBeNull();
    orphan.resolve();
    expect(recorded).toEqual([]);
  });

  test("a read that finds no transaction while a call Studio stopped waiting for still runs keeps the record unresolved, and one after it settled releases it", async () => {
    const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    const stopped = Promise.withResolvers<void>();
    settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
    awaitStoppedCall(GOVERNED, stopped.promise);

    // A stopped BEGIN may not have opened the transaction yet: a read that finds none says nothing of how it ends.
    expect(resolveTransaction(GOVERNED, owner, "not-in-transaction", markTransaction(GOVERNED))).toBe(owner);
    expect(transactionOwner(GOVERNED)).toBe(owner);
    expect(owner.unresolved).toBe(true);
    expect(resolveTransaction(GOVERNED, owner, "unknown", markTransaction(GOVERNED))).toBe(owner);
    expect(resolveTransaction(GOVERNED, owner, "in-transaction", markTransaction(GOVERNED))).toBe(owner);
    expect(owner.unresolved).toBe(true);
    expect(recorded).toEqual([]);

    stopped.resolve();
    await stopped.promise;
    expect(resolveTransaction(GOVERNED, owner, "not-in-transaction", markTransaction(GOVERNED))).toBeNull();
    expect(transactionOwner(GOVERNED)).toBeNull();
    expect(outcomes()).toEqual([["unknown", null, "cancelled"]]);
  });

  test("a state read taken before the record was claimed, changed or ended neither settles nor resolves it", async () => {
    // Taken while no record held the key, and answered after a newer BEGIN claimed one.
    const beforeClaim = markTransaction(GOVERNED);
    const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    settleTransaction(GOVERNED, "not-in-transaction", beforeClaim);
    expect(resolveTransaction(GOVERNED, owner, "not-in-transaction", beforeClaim)).toBe(owner);
    expect(transactionOwner(GOVERNED)).toBe(owner);

    // Taken before a call of the owner's answered an unknown state.
    const beforeUnknown = markTransaction(GOVERNED);
    settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
    expect(resolveTransaction(GOVERNED, owner, "in-transaction", beforeUnknown)).toBe(owner);
    settleTransaction(GOVERNED, "in-transaction", beforeUnknown);
    expect(owner.unresolved).toBe(true);

    // Taken before a call was stopped, or before the stopped call settled: both change the record.
    const beforeStop = markTransaction(GOVERNED);
    const stopped = Promise.withResolvers<void>();
    awaitStoppedCall(GOVERNED, stopped.promise);
    const whileStopped = markTransaction(GOVERNED);
    stopped.resolve();
    await stopped.promise;
    for (const stale of [beforeStop, whileStopped]) {
      resolveTransaction(GOVERNED, owner, "in-transaction", stale);
      settleTransaction(GOVERNED, "not-in-transaction", stale);
    }
    expect(transactionOwner(GOVERNED)).toBe(owner);
    expect(owner.unresolved).toBe(true);

    // Taken before its end was recorded.
    const beforeEnd = markTransaction(GOVERNED);
    endTransactionEvent(owner, "unknown", { statement: null, status: "cancelled", started: queryEventStart() });
    settleTransaction(GOVERNED, "not-in-transaction", beforeEnd);
    expect(transactionOwner(GOVERNED)).toBe(owner);

    // A read taken after every change acts on the record.
    settleTransaction(GOVERNED, "in-transaction", markTransaction(GOVERNED));
    expect(owner.unresolved).toBe(false);
    settleTransaction(GOVERNED, "not-in-transaction", markTransaction(GOVERNED));
    expect(transactionOwner(GOVERNED)).toBeNull();
  });

  test("a lease that lapses on an unknown state records unknown, never timed-out", () => {
    jest.useFakeTimers();
    try {
      claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
      jest.advanceTimersByTime(OWNERSHIP_IDLE_MS);
      expect(transactionOwner(GOVERNED)).toBeNull();
      expect(outcomes()).toEqual([["unknown", null, "cancelled"]]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the watch records unknown for an unresolved record its read finds closed, and nothing for an open or unknown one", async () => {
    jest.useFakeTimers();
    try {
      const shop = transactionKey("seed:orders", "shop", "alice-subject");
      const billing = transactionKey("seed:orders", "billing", "alice-subject");
      try {
        const closed = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
        settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
        const closedRead = stateReader(() => "not-in-transaction");
        watchTransactionTimeout(GOVERNED, closed, closedRead.readState);
        const open = claimTransaction(shop, "alice@example.com", "alice-subject", "key", SCOPE);
        const openRead = stateReader(() => "in-transaction");
        watchTransactionTimeout(shop, open, openRead.readState);
        const unknown = claimTransaction(billing, "alice@example.com", "alice-subject", "key", SCOPE);
        const unknownRead = stateReader(() => "unknown");
        watchTransactionTimeout(billing, unknown, unknownRead.readState);

        jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
        await Promise.all([closedRead.settled(), openRead.settled(), unknownRead.settled()]);

        expect(recorded.map((event) => [event.transactionId, event.transactionOutcome])).toEqual([
          [closed.transactionId, "unknown"],
        ]);
        expect(unknown.unresolved).toBe(false);
      } finally {
        releaseTransaction(shop);
        releaseTransaction(billing);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test("the watch records nothing while a call Studio stopped waiting for still runs, and looks again until it has settled", async () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
      const stopped = Promise.withResolvers<void>();
      awaitStoppedCall(GOVERNED, stopped.promise);
      const read = stateReader(() => "not-in-transaction");
      watchTransactionTimeout(GOVERNED, owner, read.readState);

      // The tick finds the stopped call running: it reads nothing, records nothing, and looks again later.
      firstLookOnLiveLease(owner);
      await read.settled();
      expect([read.reads, recorded.length]).toEqual([0, 0]);
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_RECHECK_MS);
      await read.settled();
      expect([read.reads, recorded.length]).toEqual([0, 0]);

      stopped.resolve();
      await stopped.promise;
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_RECHECK_MS);
      await read.settled();
      expect(read.reads).toBe(1);
      expect(outcomes()).toEqual([["unknown", null, "cancelled"]]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the watch records nothing for a read a call Studio stopped waiting for began during, and looks again", async () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      const answer = Promise.withResolvers<SessionState>();
      let reads = 0;
      watchTransactionTimeout(GOVERNED, owner, () => {
        reads += 1;
        return reads === 1 ? answer.promise : Promise.resolve("not-in-transaction");
      });
      firstLookOnLiveLease(owner);
      expect(reads).toBe(1);

      // A call of the owner's is stopped while the read is in flight, and the read answers after it.
      settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));
      const stopped = Promise.withResolvers<void>();
      awaitStoppedCall(GOVERNED, stopped.promise);
      answer.resolve("not-in-transaction");
      await answer.promise;
      await Promise.resolve();
      expect(recorded).toEqual([]);

      stopped.resolve();
      await stopped.promise;
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_RECHECK_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(reads).toBe(2);
      expect(outcomes()).toEqual([["unknown", null, "cancelled"]]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a call of the owner's in flight keeps every read from acting on the record, and its own answer settles it", () => {
    const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    const beforeCall = markTransaction(GOVERNED);
    const call = startOwnerCall(GOVERNED);
    expect(call.counted).toBe(owner);
    expect(callsRunning(owner)).toBe(true);
    expect(stoppedCallRunning(owner)).toBe(false);

    // Another request's read, its mark taken after the call was sent: the call may have ended the transaction.
    expect(resolveTransaction(GOVERNED, owner, "not-in-transaction", markTransaction(GOVERNED))).toBe(owner);
    settleTransaction(GOVERNED, "not-in-transaction", beforeCall);
    expect(transactionOwner(GOVERNED)).toBe(owner);
    expect(recorded).toEqual([]);

    // The call's own answer, its mark taken after its own count, settles the record.
    settleTransaction(GOVERNED, "not-in-transaction", call.mark);
    expect(transactionOwner(GOVERNED)).toBeNull();
    finishOwnerCall(call);
    finishOwnerCall(call);
    expect(callsRunning(owner)).toBe(false);

    // A call Studio stops waiting for moves from in flight to unsettled.
    const second = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    const stoppedCall = startOwnerCall(GOVERNED);
    const settled = Promise.withResolvers<void>();
    stopOwnerCall(GOVERNED, stoppedCall, settled.promise);
    finishOwnerCall(stoppedCall);
    expect([second.inFlight, second.unsettled]).toEqual([0, 1]);

    // No record: nothing is counted.
    releaseTransaction(GOVERNED);
    const unowned = startOwnerCall(GOVERNED);
    expect(unowned.counted).toBeUndefined();
    finishOwnerCall(unowned);
    stopOwnerCall(GOVERNED, unowned, Promise.resolve());
  });

  test("the watch looks again and records nothing while a call of the owner's is in flight, and once it answered a read that finds no transaction records timed-out once", async () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      const call = startOwnerCall(GOVERNED);
      const read = stateReader(() => "not-in-transaction");
      watchTransactionTimeout(GOVERNED, owner, read.readState);

      firstLookOnLiveLease(owner);
      await read.settled();
      expect([read.reads, recorded.length]).toEqual([0, 0]);
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_RECHECK_MS);
      await read.settled();
      expect([read.reads, recorded.length]).toEqual([0, 0]);

      finishOwnerCall(call);
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_RECHECK_MS);
      await read.settled();
      expect(read.reads).toBe(1);
      expect(outcomes()).toEqual([["timed-out", null, "cancelled"]]);
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_RECHECK_MS * 3);
      await read.settled();
      expect([read.reads, recorded.length]).toEqual([1, 1]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the watch records nothing for a read the record changed during, and looks again", async () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      const answer = Promise.withResolvers<SessionState>();
      let reads = 0;
      watchTransactionTimeout(GOVERNED, owner, () => {
        reads += 1;
        return reads === 1 ? answer.promise : Promise.resolve("not-in-transaction");
      });
      firstLookOnLiveLease(owner);
      expect(reads).toBe(1);

      // The owner's own call answers while the read is in flight: the read is not about the record as it is now.
      settleTransaction(GOVERNED, "in-transaction", markTransaction(GOVERNED));
      answer.resolve("not-in-transaction");
      await answer.promise;
      await Promise.resolve();
      expect(recorded).toEqual([]);

      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_RECHECK_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(reads).toBe(2);
      expect(outcomes()).toEqual([["timed-out", null, "cancelled"]]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the watch's repeated looks stop once the record's lease has lapsed", async () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      const call = startOwnerCall(GOVERNED);
      const read = stateReader(() => "not-in-transaction");
      watchTransactionTimeout(GOVERNED, owner, read.readState);

      // The first look comes after the lease lapsed (the owner has not acted since BEGIN) and still looks again.
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
      await read.settled();
      expect(read.reads).toBe(0);
      finishOwnerCall(call);
      // The repeated look finds the lease lapsed and stops: the record is left to the next request.
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_RECHECK_MS * 5);
      await read.settled();
      expect([read.reads, recorded.length]).toEqual([0, 0]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a claim over a record whose end was not recorded records that end unknown, once", () => {
    const first = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    const second = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    // A record whose end was recorded is replaced with nothing more recorded.
    endTransactionEvent(second, "committed", { statement: "COMMIT", status: "success", started: queryEventStart() });
    claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);

    expect(recorded.map((event) => [event.transactionId, event.transactionOutcome, event.statement])).toEqual([
      [first.transactionId, "unknown", null],
      [second.transactionId, "committed", "COMMIT"],
    ]);
  });

  test("a reload that takes the grant away records unknown while a call of the owner's is in flight or stopped", () => {
    const shop = transactionKey("seed:orders", "shop", "alice-subject");
    try {
      const inFlight = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      startOwnerCall(GOVERNED);
      const stopped = claimTransaction(shop, "alice@example.com", "alice-subject", "key", SCOPE);
      // A stopped BEGIN on the owner's own record leaves it resolved, with the call still running.
      stopOwnerCall(shop, startOwnerCall(shop), Promise.withResolvers<void>().promise);
      expect(stopped.unresolved).toBe(false);

      endOwnerTransactions("seed:orders", "alice-subject");

      expect(recorded.map((event) => [event.transactionId, event.transactionOutcome, event.statement])).toEqual([
        [inFlight.transactionId, "unknown", "ROLLBACK"],
        [stopped.transactionId, "unknown", "ROLLBACK"],
      ]);
    } finally {
      releaseTransaction(shop);
    }
  });

  test("a reload that takes the grant away records unknown for a record whose state is unknown", () => {
    const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
    settleTransaction(GOVERNED, "unknown", markTransaction(GOVERNED));

    endOwnerTransactions("seed:orders", "alice-subject");

    expect(recorded.map((event) => [event.transactionId, event.transactionOutcome, event.statement])).toEqual([
      [owner.transactionId, "unknown", "ROLLBACK"],
    ]);
  });
});
