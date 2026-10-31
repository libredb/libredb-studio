/**
 * The object surface of an agent-mode Firestore handle (`agent-surface.ts`), over the agent's client and a fake
 * Firestore: root collection ids from charged listings up to the id-listing cap, the cap and a caller's bound reported
 * rather than hidden, ids the id rules refuse left out, and nothing sent for a read that carries no allowance.
 */
import { describe, expect, test } from "bun:test";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import { createFirestoreAgentClient } from "@/lib/db/providers/document/firestore/agent-client";
import {
  agentCountObjects,
  agentDescribeObjects,
  agentListObjects,
  FIRESTORE_AGENT_WITHHELD as W,
} from "@/lib/db/providers/document/firestore/agent-surface";
import { LIMITS } from "@/lib/db/providers/document/firestore/constants";
import { FIRESTORE_OBJECT_SENTENCES as O } from "@/lib/db/providers/document/firestore/objects";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import { FAKE_BASE, type FakeHandler, fakeFirestore } from "../../../helpers/firestore-fake-client";

/** A null allowance stands for a read that carries none. */
function surface(handler: FakeHandler, allowance: RunReadAllowance | null = new RunReadAllowance(100)) {
  const fake = fakeFirestore(handler);
  return {
    fake,
    client: createFirestoreAgentClient(fake.client),
    call: { signal: new AbortController().signal, base: FAKE_BASE, allowance: allowance ?? undefined },
  };
}

/** An id listing that always has a next page, so the id-listing cap stops it. */
function endless(): FakeHandler {
  let served = 0;
  return () => {
    served += 1;
    return { collectionIds: [`c${String(served).padStart(3, "0")}`], nextPageToken: `T${served}` };
  };
}

describe("the agent-mode object surface", () => {
  test("the count reads every page, charged, and reports the cap when it stopped the read", async () => {
    const { client, call, fake } = surface(endless());
    expect(await agentCountObjects(client, [], call)).toEqual({
      collection: { count: LIMITS.idListingRequests, sampledFrom: O.sampledFrom },
    });
    expect(fake.sent).toHaveLength(LIMITS.idListingRequests);
    expect(call.allowance?.spent()).toBe(LIMITS.idListingRequests);
  });

  test("ids the id rules refuse are left out, and the rest are in UTF-8 order", async () => {
    const { client, call } = surface(() => ({ collectionIds: ["users", "__x__", "Ａ-col", "orders"] }));
    expect((await agentListObjects(client, [], "collection", call)).map((object) => object.name)).toEqual([
      "orders",
      "users",
      "Ａ-col",
    ]);
  });

  test("the bulk describe answers __name__ alone, and reports a caller's bound and the cap", async () => {
    const listed = surface(() => ({ collectionIds: ["a", "b", "c"] }));
    expect(await agentDescribeObjects(listed.client, [], "collection", 2, listed.call)).toEqual({
      details: ["a", "b"].map((id) => ({
        path: [id],
        columns: [expect.objectContaining({ name: "__name__" })],
        indexes: [],
        foreignKeys: [],
      })),
      truncated: { limit: 2, reason: callerBoundTruncationReason(2) },
    });
    const capped = surface(endless());
    const batch = await agentDescribeObjects(capped.client, [], "collection", undefined, capped.call);
    expect(batch.truncated).toEqual({ limit: LIMITS.idListingRequests, reason: O.idCapReason });
    const whole = surface(() => ({ collectionIds: ["a"] }));
    expect(
      (await agentDescribeObjects(whole.client, [], "collection", undefined, whole.call)).truncated,
    ).toBeUndefined();
  });

  test("a read that carries no allowance sends nothing", async () => {
    const { client, call, fake } = surface(() => ({ collectionIds: ["a"] }), null);
    expect(await agentCountObjects(client, [], call)).toEqual({ collection: { unavailable: W.noAllowance } });
    await expect(agentListObjects(client, [], "collection", call)).rejects.toThrow(W.noAllowance);
    await expect(agentDescribeObjects(client, [], "collection", 5, call)).rejects.toThrow(W.noAllowance);
    expect(fake.sent).toEqual([]);
  });

  test("no withheld sentence names a path, an id or a value", () => {
    for (const sentence of Object.values(W)) {
      expect(sentence.startsWith("Agent mode on Firestore reads metadata only")).toBe(true);
      expect(sentence).not.toMatch(/users\/|alice/);
    }
  });
});
