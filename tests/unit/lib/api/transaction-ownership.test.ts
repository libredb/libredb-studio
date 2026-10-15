import { afterEach, describe, expect, test } from "bun:test";
import {
  claimTransaction,
  releaseIfProviderChanged,
  releaseTransaction,
  transactionKey,
  transactionOwner,
} from "@/lib/api/transaction-ownership";

// Under governance a transaction runs on the provider its owner's begin resolved, and that provider's cache key frames
// the credential of the owner's grant level (spec 9.4). The record keeps that key, so a later request that resolves
// another key, because the grant level or the credential changed, is told the transaction no longer belongs to the
// provider it is answered on.
const GOVERNED = transactionKey("seed:orders", undefined, "alice-subject");
const SHARED = transactionKey("orders");

afterEach(() => {
  releaseTransaction(GOVERNED);
  releaseTransaction(SHARED);
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
    expect(releaseIfProviderChanged(GOVERNED, "provider-key-of-the-read-credential")).toBe(
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
