/**
 * The Oxia seam (SB1-2) and the provider's constants (SB1-11).
 *
 * `client.ts` is types and two RPC lists: these cases hold the lists to the allowlist of SB1-2.4, show at compile time
 * that `OxiaRpc` refuses a write RPC and that a literal with the six methods is an `OxiaClient`, and load the module.
 * `constants.ts` is pinned name by name and value by value, so a later edit of any number fails here by name.
 */
import { describe, expect, test } from "bun:test";
import {
  OXIA_ALLOWLISTED_RPCS,
  OXIA_HEALTH_RPCS,
  type OxiaClient,
  type OxiaRpc,
  type OxiaSnapshot,
  type OxiaStream,
} from "@/lib/db/providers/keyvalue/oxia/client";
import * as constants from "@/lib/db/providers/keyvalue/oxia/constants";
import { OXIA_TYPE } from "@/lib/db/providers/keyvalue/oxia/constants";

function endedStream<T>(): OxiaStream<T> {
  return {
    next: async () => undefined,
    receivedBytes: 0,
    truncated: false,
    cancel: () => {},
  };
}

describe("the Oxia seam", () => {
  test("the allowlist is the four read RPCs, and Health is Check alone", () => {
    expect([...OXIA_ALLOWLISTED_RPCS]).toEqual(["GetShardAssignments", "Read", "List", "RangeScan"]);
    expect([...OXIA_HEALTH_RPCS]).toEqual(["Check"]);
  });

  test("OxiaRpc is those names and Health/Check", () => {
    const rpcs: readonly OxiaRpc[] = [...OXIA_ALLOWLISTED_RPCS, "Health/Check"];
    expect(rpcs).toHaveLength(5);
    // @ts-expect-error -- a write RPC is not an OxiaRpc.
    const refused: OxiaRpc = "Write";
    expect(refused as string).toBe("Write");
  });

  test("an object with the six methods is an OxiaClient", () => {
    const snapshot: OxiaSnapshot = { namespace: "default", shards: [], readAt: 0 };
    const client: OxiaClient = {
      getSnapshot: async () => snapshot,
      read: async () => [],
      list: () => endedStream<string>(),
      rangeScan: () => endedStream(),
      health: async () => "SERVING",
      close: () => {},
    };
    expect(Object.keys(client).sort()).toEqual(["close", "getSnapshot", "health", "list", "rangeScan", "read"]);
  });

  test("the type-id is oxia", () => {
    expect(OXIA_TYPE as string).toBe("oxia");
  });
});

describe("the provider's constants", () => {
  test("every number of the provider, by name", () => {
    expect({ ...constants } as Record<string, unknown>).toEqual({
      OXIA_TYPE: "oxia",
      OXIA_DEFAULT_PORT: 6648,
      OXIA_ADMIN_PORT: 6651,
      OXIA_DEFAULT_NAMESPACE: "default",
      OXIA_INTERNAL_PREFIX: "__oxia/",
      OXIA_IP_SERVER_NAME: "oxia.invalid",
      OXIA_RECEIVE_CAP_BYTES: 16_777_216,
      OXIA_RUN_BYTE_BUDGET: 8_388_608,
      OXIA_PAGE_STREAM_BYTES: 4_194_304,
      OXIA_PAGE_KEPT_BYTES: 16_777_216,
      OXIA_ORDER_PROBE_BYTES: 8_388_608,
      OXIA_ORDER_SAMPLE_KEYS: 100,
      OXIA_MAX_SHARDS: 1_024,
      OXIA_MAX_SHARD_STREAMS: 8,
      OXIA_MAX_DATA_SERVERS: 64,
      OXIA_LEADER_MAX_BYTES: 300,
      OXIA_NAMESPACE_MAX_BYTES: 300,
      OXIA_READ_BATCH_GETS: 1_000,
      OXIA_CURSOR_KEY_MAX_BYTES: 65_536,
      OXIA_SNAPSHOT_TTL_MS: 5_000,
      OXIA_SURFACE_DEADLINE_MS: 10_000,
      OXIA_HEALTH_DEADLINE_MS: 5_000,
      OXIA_LIMITER_OPTIONS: { perProvider: 4, perEngine: 16, queueDepth: 64 },
      OXIA_DISCOVERY_MAX_ROUNDS: 256,
      OXIA_DISCOVERY_MAX_CALLS: 2_048,
      OXIA_DISCOVERY_DEADLINE_MS: 3_000,
      OXIA_LIST_DEFAULT_LIMIT: 500,
      OXIA_SCAN_DEFAULT_LIMIT: 100,
      OXIA_MAX_LIMIT: 500,
      OXIA_MAX_TEXT_BYTES: 65_536,
      OXIA_ECHO_WORD_CHARS: 40,
      OXIA_CELL_LIMIT: 65_536,
      OXIA_SOURCE_HEX_BYTES: 65_536,
      OXIA_SHOWN_KEY_CHARS: 120,
      OXIA_KEY_SCAN_DEFAULT_COUNT: 500,
      OXIA_KEY_SCAN_MAX_COUNT: 1_000,
    });
  });
});
