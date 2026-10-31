/**
 * What an agent's Oxia read answers: each operation's projection pinned whole, the declaration the capability states,
 * the budgets refused rather than cut, and every failure worded by its category with no Oxia words.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  OXIA_AGENT_COUNT_SENTENCES,
  OXIA_AGENT_FAILURE_SENTENCES,
  OXIA_METADATA_ONLY,
  oxiaAgentFailure,
  oxiaAgentResult,
} from "@/lib/db/providers/keyvalue/oxia/agent-metadata-read";
import type { OxiaRecordView, OxiaSnapshot } from "@/lib/db/providers/keyvalue/oxia/client";
import { OxiaError } from "@/lib/db/providers/keyvalue/oxia/errors";
import { BYTE_BUDGET_PREFIX, ROW_BUDGET_PREFIX, TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import { MetadataProjectionError } from "@/lib/db/redaction/metadata-only";

const BUDGET = { maxResultRows: 200, maxResultBytes: 64 * 1024, statementTimeoutMs: 10_000 };

const leader = (address: string) => {
  const [host, port] = address.split(":");
  return { host: host as string, port: Number(port), address, bootstrap: false };
};

const SNAPSHOT: OxiaSnapshot = {
  namespace: "default",
  shards: [
    { id: "0", minHash: 0, maxHash: 99, leader: leader("oxia-0:6648") },
    { id: "1", minHash: 100, maxHash: 199, leader: leader("oxia-1:6648") },
    { id: "2", minHash: 200, maxHash: 4294967295, leader: leader("oxia-0:6648") },
  ],
  readAt: 0,
};

/** A captured version: 0.18.0 answers epoch milliseconds as decimal strings (open.json). */
const RECORD: OxiaRecordView = {
  key: "/admin/policies/tenant-secret-marker",
  value: new TextEncoder().encode("value-secret-marker"),
  version: {
    versionId: "7",
    modificationsCount: "2",
    createdTimestamp: "1793392798920",
    modifiedTimestamp: "1793392798945",
  },
  shard: "1",
};

const EPHEMERAL: OxiaRecordView = {
  ...RECORD,
  version: { ...RECORD.version, sessionId: "41", clientIdentity: "identity-secret-marker" },
};

describe("the declaration", () => {
  test("states every operation's columns and their kinds, and no key or value column", () => {
    expect(OXIA_METADATA_ONLY).toEqual({
      shards: [
        { column: "namespace", kind: "name" },
        { column: "shards", kind: "count" },
        { column: "leaders", kind: "count" },
      ],
      "key metadata": [
        { column: "exists", kind: "flag" },
        { column: "version_id", kind: "count" },
        { column: "modifications", kind: "count" },
        { column: "created", kind: "name" },
        { column: "modified", kind: "name" },
        { column: "value_bytes", kind: "count" },
        { column: "ephemeral", kind: "flag" },
      ],
      "key count": [{ column: "keys", kind: "count" }],
    });
  });
});

describe("the answers", () => {
  test("the shard map is its namespace, its shard count and its distinct leaders, no address", () => {
    const result = oxiaAgentResult({ op: "shards", snapshot: SNAPSHOT }, BUDGET, "shards", 3);
    expect(result).toEqual({
      fields: ["namespace", "shards", "leaders"],
      rows: [{ namespace: "default", shards: 3, leaders: 2 }],
      rowCount: 1,
      executionTime: 3,
    });
    expect(JSON.stringify(result)).not.toContain("oxia-0");
  });

  test("a key is its existence, version, times, value size and ephemeral flag, never its name, value or session", () => {
    const result = oxiaAgentResult({ op: "key metadata", record: EPHEMERAL }, BUDGET, "get x", 1);
    expect(result.rows).toEqual([
      {
        exists: true,
        version_id: 7,
        modifications: 2,
        created: "2026-10-30T20:39:58.920Z",
        modified: "2026-10-30T20:39:58.945Z",
        value_bytes: 19,
        ephemeral: true,
      },
    ]);
    const text = JSON.stringify(result);
    for (const secret of ["tenant-secret-marker", "value-secret-marker", "identity-secret-marker", '"41"']) {
      expect({ secret, leaked: text.includes(secret) }).toEqual({ secret, leaked: false });
    }
    expect(oxiaAgentResult({ op: "key metadata", record: RECORD }, BUDGET, "get x", 1).rows[0]?.ephemeral).toBe(false);
  });

  test("a missing key answers that it does not exist, every other column null", () => {
    expect(oxiaAgentResult({ op: "key metadata", record: undefined }, BUDGET, "get x", 1).rows).toEqual([
      {
        exists: false,
        version_id: null,
        modifications: null,
        created: null,
        modified: null,
        value_bytes: null,
        ephemeral: null,
      },
    ]);
  });

  test("a value withheld at the receive cap has no size, and an empty value is zero bytes", () => {
    const withheld: OxiaRecordView = { ...RECORD, value: undefined, withheld: true };
    expect(
      oxiaAgentResult({ op: "key metadata", record: withheld }, BUDGET, "get x", 1).rows[0]?.value_bytes,
    ).toBeNull();
    const empty: OxiaRecordView = { ...RECORD, value: new Uint8Array(0) };
    expect(oxiaAgentResult({ op: "key metadata", record: empty }, BUDGET, "get x", 1).rows[0]?.value_bytes).toBe(0);
  });

  test("a count is one number", () => {
    expect(oxiaAgentResult({ op: "key count", count: 42 }, BUDGET, "list", 1).rows).toEqual([{ keys: 42 }]);
  });

  test("a version or a time that is no number refuses the whole answer, naming the column", () => {
    const smuggled: OxiaRecordView = { ...RECORD, version: { ...RECORD.version, versionId: "value-secret-marker" } };
    expect(() => oxiaAgentResult({ op: "key metadata", record: smuggled }, BUDGET, "get x", 1)).toThrow(
      MetadataProjectionError,
    );
    const badTime: OxiaRecordView = { ...RECORD, version: { ...RECORD.version, createdTimestamp: "soon" } };
    expect(() => oxiaAgentResult({ op: "key metadata", record: badTime }, BUDGET, "get x", 1)).toThrow(
      'The answer\'s "created" is not a name',
    );
  });

  test("an answer past the byte budget is refused, not cut", () => {
    const tight = { ...BUDGET, maxResultBytes: 4 };
    expect(() => oxiaAgentResult({ op: "key count", count: 1 }, tight, "list", 1)).toThrow(BYTE_BUDGET_PREFIX);
  });

  test("the count sentences carry the row budget's prefix and offer no narrower count", () => {
    expect(OXIA_AGENT_COUNT_SENTENCES.overRows(200)).toBe(
      `${ROW_BUDGET_PREFIX}: the namespace holds more than 200 keys, and Studio counts its keys only up to the row budget, refusing a larger count rather than cutting it. A count over a narrower range is not one of agent mode's reads, since it would reveal key names.`,
    );
    expect(OXIA_AGENT_COUNT_SENTENCES.overBytes).toBe(
      "The namespace's keys are longer than the 8 MiB Studio reads to count them, so the count was refused rather than cut.",
    );
    expect(OXIA_AGENT_COUNT_SENTENCES.manyHolders(2)).toContain("stored on 2 shards");
  });
});

describe("the failures", () => {
  test("an Oxia error is worded by its category alone, never the server's words", () => {
    const error = oxiaAgentFailure(new OxiaError("unauthenticated", { rpc: "Read" }), BUDGET, "get x");
    expect(error).toBeInstanceOf(QueryError);
    expect(error?.message).toBe(OXIA_AGENT_FAILURE_SENTENCES.refused("unauthenticated"));
    expect(OXIA_AGENT_FAILURE_SENTENCES.refused("unknown")).toBe(
      "Oxia did not answer the read (unknown). Oxia's own words are not passed on to agent mode, since an Oxia error can repeat a key.",
    );
    for (const category of [
      "namespace-not-found",
      "receive-cap",
      "not-leader",
      "leader-changing",
      "shard-not-found",
      "record-changed",
    ] as const) {
      expect(OXIA_AGENT_FAILURE_SENTENCES.refused(category)).toContain("not passed on");
    }
  });

  test("a deadline, and a permit wait the deadline ended, are the time budget's refusal", () => {
    const expected = `${TIME_BUDGET_PREFIX}: no answer within 10000ms`;
    expect(oxiaAgentFailure(new OxiaError("deadline-exceeded"), BUDGET, "get x")?.message).toBe(expected);
    expect(oxiaAgentFailure(new DOMException("late", "TimeoutError"), BUDGET, "get x")?.message).toBe(expected);
  });

  test("a projection refusal is its own sentence; anything else passes on as it is", () => {
    const projection = new MetadataProjectionError("created", "name");
    expect(oxiaAgentFailure(projection, BUDGET, "get x")?.message).toBe(projection.message);
    expect(oxiaAgentFailure(new QueryError("refused before the network"), BUDGET, "get x")).toBeUndefined();
    expect(oxiaAgentFailure(new DOMException("stop", "AbortError"), BUDGET, "get x")).toBeUndefined();
  });
});
