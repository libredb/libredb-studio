import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import type { QueryEventInput } from "@/lib/query-events/types";

// The sink is replaced, so a recorded event is read here instead of being queued for the governance pool (STU-30).
const recorded: QueryEventInput[] = [];
mock.module("@/lib/query-events/sink", () => ({
  recordQueryEvent: (input: QueryEventInput) => {
    recorded.push(input);
  },
}));

const {
  claimTransaction,
  endOwnerTransactions,
  OWNERSHIP_IDLE_MS,
  recordTimedOut,
  releaseIfProviderChanged,
  releaseTransaction,
  TRANSACTION_TIMEOUT_CHECK_MS,
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
// the credential of the owner's grant level (spec 9.4). The record keeps that key, so a later request that resolves
// another key, because the grant level or the credential changed, is told the transaction no longer belongs to the
// provider it is answered on.
const GOVERNED = transactionKey("seed:orders", undefined, "alice-subject");
const SHARED = transactionKey("orders");

afterEach(() => {
  releaseTransaction(GOVERNED);
  releaseTransaction(SHARED);
  recorded.length = 0;
});

describe("transaction ownership records (spec 9.4)", () => {
  test("the record keeps the provider cache key its begin resolved", () => {
    claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "provider-key-of-the-write-credential");

    expect(transactionOwner(GOVERNED)).toMatchObject({
      username: "alice@example.com",
      subject: "alice-subject",
      providerKey: "provider-key-of-the-write-credential",
    });

    // Without governance a record names neither a subject nor a provider key, as before owners existed.
    claimTransaction(SHARED, "alice");
    const shared = transactionOwner(SHARED);
    expect(shared?.username).toBe("alice");
    expect(shared?.subject).toBeUndefined();
    expect(shared?.providerKey).toBeUndefined();
  });

  test("a request that resolves another provider key releases the record and learns the key it was opened on", () => {
    claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "provider-key-of-the-write-credential");

    // The key the begin resolved: the record stays, so the owner keeps its transaction.
    expect(releaseIfProviderChanged(GOVERNED, "provider-key-of-the-write-credential")).toBeNull();
    expect(transactionOwner(GOVERNED)).not.toBeNull();

    // Another key: the record is released at once, and the caller is handed the key of the provider that holds it.
    expect(releaseIfProviderChanged(GOVERNED, "provider-key-of-the-read-credential")?.providerKey).toBe(
      "provider-key-of-the-write-credential",
    );
    expect(transactionOwner(GOVERNED)).toBeNull();
    // Released once: a second request finds nothing left to release.
    expect(releaseIfProviderChanged(GOVERNED, "provider-key-of-the-read-credential")).toBeNull();
  });

  test("a record that names no provider key is never compared, so a record without governance is left alone", () => {
    claimTransaction(SHARED, "alice");

    expect(releaseIfProviderChanged(SHARED, "provider-key-of-the-read-credential")).toBeNull();
    expect(transactionOwner(SHARED)?.username).toBe("alice");
  });
});

describe("transaction events (spec 7.9)", () => {
  test("a provider that rolled back on its own timer yields exactly one timed-out event", () => {
    jest.useFakeTimers();
    try {
      let open = true;
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      watchTransactionTimeout(GOVERNED, owner, () => open);

      // The provider's TX_TIMEOUT_MS rolls the transaction back five minutes after BEGIN, with no session behind it.
      open = false;
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS - 1);
      expect(recorded).toEqual([]);
      jest.advanceTimersByTime(1);

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
      recordTimedOut(owner);
      expect(recorded).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the reconcile seeing the expiry first leaves the timer nothing to record", () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      watchTransactionTimeout(GOVERNED, owner, () => false);
      // The route's reconcile: the provider holds no transaction, so the record is released and the end recorded.
      releaseTransaction(GOVERNED);
      recordTimedOut(owner);
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
      expect(recorded.map((event) => event.transactionOutcome)).toEqual(["timed-out"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a lease that lapses first records the timeout, and the timer then records nothing", () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      watchTransactionTimeout(GOVERNED, owner, () => false);
      jest.advanceTimersByTime(OWNERSHIP_IDLE_MS);
      expect(transactionOwner(GOVERNED)).toBeNull();
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
      expect(recorded.map((event) => event.transactionOutcome)).toEqual(["timed-out"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the timer records nothing for a transaction still open or one that another replaced", () => {
    jest.useFakeTimers();
    try {
      const first = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      watchTransactionTimeout(GOVERNED, first, () => false);
      // Committed and begun again: the new record carries another transaction id.
      const second = claimTransaction(GOVERNED, "alice@example.com", "alice-subject", "key", SCOPE);
      expect(second.transactionId).not.toBe(first.transactionId);
      watchTransactionTimeout(GOVERNED, second, () => true);
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
      expect(recorded).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("without governance a record carries a transaction id and records no event", () => {
    jest.useFakeTimers();
    try {
      const owner = claimTransaction(SHARED, "alice");
      expect(owner.transactionId).toMatch(/^[0-9a-f-]{36}$/);
      watchTransactionTimeout(SHARED, owner, () => false);
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS);
      recordTimedOut(owner);
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
