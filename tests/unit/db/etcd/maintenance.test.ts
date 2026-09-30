/**
 * Compaction, defragmentation and alarm disarm (spec 7.2), through the shared fake client (plan
 * Contract C12): the three declared cards' words, E6's refusal before any request, the exact calls each
 * operation sends, each message, the disarm's `success: false` rule, and the root-role sentence a
 * PermissionDenied from any of the three reads (R13 D3).
 */
import { describe, expect, test } from "bun:test";
import { ConnectionError, QueryError, TimeoutError } from "@/lib/db/errors";
import type { EtcdAlarm, EtcdMember, EtcdStatus } from "@/lib/db/providers/keyvalue/etcd/client";
import { type EtcdErrorConnection, toEtcdError } from "@/lib/db/providers/keyvalue/etcd/errors";
import {
  ETCD_MAINTENANCE_OPERATIONS,
  ETCD_MAINTENANCE_SPECS,
  runEtcdMaintenance,
} from "@/lib/db/providers/keyvalue/etcd/maintenance";
import type { EtcdSurfaceContext } from "@/lib/db/providers/keyvalue/etcd/objects";
import { refuseReadOnly } from "@/lib/db/providers/keyvalue/etcd/write-policy";
import { maintenanceControl, type ProviderCapabilities } from "@/lib/db/types";
import { createFakeEtcdClient } from "../../../helpers/etcd-fake-client";

const CONNECTION: EtcdErrorConnection = {
  host: "etcd.test",
  port: 2379,
  runtimeReportsTlsCause: true,
  receiveCapBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
};

/** Root, or auth off: read-write, and a clock that stands still. */
function surface(over: Partial<EtcdSurfaceContext> = {}): EtcdSurfaceContext {
  return {
    readable: { kind: "all" },
    writable: { kind: "all" },
    signal: new AbortController().signal,
    now: () => 1_000,
    errors: CONNECTION,
    ...over,
  };
}

/** A clock that answers each time in turn, then keeps the last. */
function stepping(...times: number[]): () => number {
  let at = 0;
  return () => times[Math.min(at++, times.length - 1)];
}

/** Two member ids past 2^53, as etcd answers them: decimal strings (spec 4.1). */
const ETCD_1 = "10276657743932975437";
const ETCD_2 = "12345678901234567890";

function status(memberId: string, dbSize: string, revision = "4242"): EtcdStatus {
  return {
    header: { clusterId: "14841639068965178418", memberId, revision, raftTerm: "3" },
    version: "3.7.2",
    dbSize,
    dbSizeInUse: dbSize,
    dbSizeQuota: "2147483648",
    leader: ETCD_1,
    raftIndex: "5000",
    raftTerm: "3",
    raftAppliedIndex: "5000",
    errors: [],
    isLearner: false,
    storageVersion: "3.7.0",
  };
}

const MEMBERS: readonly EtcdMember[] = [
  {
    id: ETCD_1,
    name: "etcd-1",
    peerUrls: ["http://etcd-1:2380"],
    clientUrls: ["http://etcd-1:2379"],
    isLearner: false,
  },
  {
    id: ETCD_2,
    name: "etcd-2",
    peerUrls: ["http://etcd-2:2380"],
    clientUrls: ["http://etcd-2:2379"],
    isLearner: false,
  },
];

const members = async () => ({ header: status(ETCD_1, "0").header, members: MEMBERS });

/** A grpc-js ServiceError, as the adapter hands it to toEtcdError (plan C5). */
function grpc(code: number, details: string): Error {
  return Object.assign(new Error(`${code} STATUS: ${details}`), { code, details, metadata: {} });
}

const DENIED = () => toEtcdError(grpc(7, "etcdserver: permission denied"));

describe("the three declared cards of Admin > Operations (spec 3.4, 7.2)", () => {
  test("compact, defragment and disarm, in that order, each global, never per entity, and typed-confirmed", () => {
    expect(ETCD_MAINTENANCE_OPERATIONS).toEqual(["compact", "defragment", "disarm"]);
    expect(ETCD_MAINTENANCE_SPECS).toEqual({
      compact: {
        label: "Compact history",
        title: "Compact history",
        description:
          "Removes every revision before the current one. History reads before it fail, and a watch from an older revision is cancelled.",
        perEntity: false,
        global: true,
        confirmation: "typed",
      },
      defragment: {
        label: "Defragment",
        title: "Defragment the member",
        description:
          "Rebuilds the database file of the member this connection reaches, and only that member. That member blocks reads and writes while it runs.",
        perEntity: false,
        global: true,
        confirmation: "typed",
      },
      disarm: {
        label: "Disarm alarms",
        title: "Disarm alarms",
        description:
          "Clears every raised alarm. Defragment every member that alarm list names first: a NOSPACE alarm comes back on the next write if the database is still over its quota.",
        perEntity: false,
        global: true,
        confirmation: "typed",
      },
    });
  });

  test("the one gate both maintenance surfaces ask offers each globally with its card's words, and never per entity", () => {
    const capabilities = {
      supportsMaintenance: true,
      maintenanceOperations: [...ETCD_MAINTENANCE_OPERATIONS],
      maintenanceOperationSpecs: ETCD_MAINTENANCE_SPECS,
    } as unknown as ProviderCapabilities;
    for (const type of ETCD_MAINTENANCE_OPERATIONS) {
      const spec = ETCD_MAINTENANCE_SPECS[type];
      const card = {
        label: spec?.label,
        title: spec?.title,
        description: spec?.description,
        confirmation: "typed" as const,
      };
      expect(maintenanceControl(capabilities, type, "global")).toStrictEqual({ offered: true, ...card });
      expect(maintenanceControl(capabilities, type, "perEntity").offered).toBe(false);
    }
  });
});

describe("runEtcdMaintenance: refused before any request (spec E6, 7.2)", () => {
  for (const source of ["seed", "connection", "execution-profile"] as const) {
    test(`read-only from ${source}: each operation is refused with E6's sentence, and nothing is sent`, async () => {
      const client = createFakeEtcdClient();
      const sentence = refuseReadOnly({ readOnly: source })?.message as string;
      for (const type of ETCD_MAINTENANCE_OPERATIONS) {
        const attempt = runEtcdMaintenance(client, surface({ readOnly: source }), type);
        // oxlint-disable-next-line no-await-in-loop -- each operation's refusal is read before the next is asked.
        await expect(attempt).rejects.toThrow(QueryError);
        // oxlint-disable-next-line no-await-in-loop -- the same refusal, its sentence read before the next operation.
        await expect(attempt).rejects.toThrow(sentence);
      }
      expect(client.calls).toEqual([]);
    });
  }

  test("a type etcd does not run is refused by name, and nothing is sent", async () => {
    const client = createFakeEtcdClient();
    await expect(runEtcdMaintenance(client, surface(), "vacuum")).rejects.toThrow(
      "etcd runs compact, defragment and disarm, and not vacuum.",
    );
    expect(client.calls).toEqual([]);
  });
});

describe("runEtcdMaintenance: compaction (spec 7.2)", () => {
  test("Compact to the revision Status answers, sent as that decimal string, and the time from the injected clock", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(ETCD_1, "1", "9007199254740993"),
      compact: async () => undefined,
    });
    expect(await runEtcdMaintenance(client, surface({ now: stepping(100, 142) }), "compact")).toEqual({
      success: true,
      executionTime: 42,
      message:
        "Compacted history to revision 9007199254740993: every revision before it is gone, so a history read or a watch from an older revision now fails.",
    });
    expect(client.calls.map((call) => [call.method, call.args[0]])).toEqual([
      ["status", { signal: expect.any(AbortSignal) }],
      ["compact", "9007199254740993"],
    ]);
  });

  test("history already compacted to that revision is the state asked for, said as that", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(ETCD_1, "1"),
      compact: async () => {
        throw toEtcdError(grpc(11, "etcdserver: mvcc: required revision has been compacted"));
      },
    });
    expect(await runEtcdMaintenance(client, surface(), "compact")).toEqual({
      success: true,
      executionTime: 0,
      message: "History is already compacted to revision 4242 or later: there was no older revision to remove.",
    });
  });

  test("a Status read that fails raises 5.6's mapped error, and nothing is compacted", async () => {
    const client = createFakeEtcdClient({
      status: async () => {
        throw toEtcdError(grpc(4, "Deadline exceeded after 3.000s,remote_addr=127.0.0.1:2379"));
      },
      compact: async () => undefined,
    });
    await expect(runEtcdMaintenance(client, surface(), "compact")).rejects.toThrow(TimeoutError);
    expect(client.calls.map((call) => call.method)).toEqual(["status"]);
  });

  test("a Compact etcd did not answer reads as a read's failure, never as a write of unknown outcome, since running it again is harmless", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(ETCD_1, "1"),
      compact: async () => {
        throw toEtcdError(grpc(14, "etcdserver: leader changed"));
      },
    });
    const attempt = runEtcdMaintenance(client, surface(), "compact");
    await expect(attempt).rejects.toThrow(ConnectionError);
    await expect(attempt).rejects.toThrow("etcd did not answer the compaction.");
  });

  test("any other answer to Compact is 5.6's mapped error", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(ETCD_1, "1"),
      compact: async () => {
        throw toEtcdError(grpc(14, "etcdserver: no leader"));
      },
    });
    await expect(runEtcdMaintenance(client, surface(), "compact")).rejects.toThrow(ConnectionError);
  });
});

describe("runEtcdMaintenance: defragmentation (spec 7.2)", () => {
  test("Status, a serializable MemberList, Defragment, Status: the member named and its size before and after", async () => {
    const sizes = ["1288490189", "325058560"];
    const client = createFakeEtcdClient({
      status: async () => status(ETCD_1, sizes.shift() as string),
      memberList: members,
      defragment: async () => undefined,
    });
    expect(await runEtcdMaintenance(client, surface(), "defragment")).toEqual({
      success: true,
      executionTime: 0,
      message: "Defragmented etcd-1 (8e9e05c52164694d): 1.2 GiB to 310 MiB on disk",
    });
    expect(client.calls.map((call) => call.method)).toEqual(["status", "memberList", "defragment", "status"]);
    expect(client.calls[1].args[0]).toEqual({ linearizable: false });
  });

  test("a second Status from another member names both, and gives no sizes, since which one ran cannot be told", async () => {
    const answers = [status(ETCD_1, "1288490189"), status(ETCD_2, "325058560")];
    const client = createFakeEtcdClient({
      status: async () => answers.shift() as EtcdStatus,
      memberList: members,
      defragment: async () => undefined,
    });
    expect(await runEtcdMaintenance(client, surface(), "defragment")).toEqual({
      success: true,
      executionTime: 0,
      message:
        "Defragmentation ran, but this connection reached etcd-1 (8e9e05c52164694d) before it and etcd-2 (ab54a98ceb1f0ad2) after it, so which member was defragmented cannot be told and the sizes are not compared.",
    });
  });

  test("a second Status that fails after Defragment answered is said, not raised, because the operation ran", async () => {
    let reads = 0;
    const client = createFakeEtcdClient({
      status: async () => {
        reads += 1;
        if (reads === 2) throw toEtcdError(grpc(14, "etcdserver: leader changed"));
        return status(ETCD_1, "1288490189");
      },
      memberList: members,
      defragment: async () => undefined,
    });
    const result = await runEtcdMaintenance(client, surface(), "defragment");
    expect(result.success).toBe(true);
    expect(result.message).toStartWith(
      "Defragmented etcd-1 (8e9e05c52164694d). Its size afterwards could not be read, so the sizes are not compared: ",
    );
  });

  test("a member with no name is named by its hex id", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(ETCD_2, "1024"),
      memberList: async () => ({ header: status(ETCD_2, "0").header, members: [{ ...MEMBERS[1], name: "" }] }),
      defragment: async () => undefined,
    });
    expect((await runEtcdMaintenance(client, surface(), "defragment")).message).toBe(
      "Defragmented ab54a98ceb1f0ad2: 1 KiB to 1 KiB on disk",
    );
  });

  test("a MemberList read that fails raises 5.6's mapped error before Defragment is sent", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(ETCD_1, "1"),
      memberList: async () => {
        throw toEtcdError(grpc(4, "Deadline exceeded after 3.000s,remote_addr=127.0.0.1:2379"));
      },
      defragment: async () => undefined,
    });
    await expect(runEtcdMaintenance(client, surface(), "defragment")).rejects.toThrow(TimeoutError);
    expect(client.calls.map((call) => call.method)).toEqual(["status", "memberList"]);
  });
});

describe("runEtcdMaintenance: alarm disarm (spec 7.2)", () => {
  const RAISED: readonly EtcdAlarm[] = [
    { memberId: ETCD_1, alarm: "nospace" },
    { memberId: ETCD_2, alarm: "corrupt" },
  ];

  test("one DEACTIVATE per listed alarm, each carrying the exact pair the GET returned, ids past 2^53 unchanged", async () => {
    const client = createFakeEtcdClient({ alarmList: async () => RAISED, alarmDisarm: async (alarm) => [alarm] });
    expect(await runEtcdMaintenance(client, surface(), "disarm")).toEqual({
      success: true,
      executionTime: 0,
      message: "Disarmed NOSPACE on member 8e9e05c52164694d, CORRUPT on member ab54a98ceb1f0ad2.",
    });
    expect(client.calls.map((call) => call.method)).toEqual(["alarmList", "alarmDisarm", "alarmDisarm"]);
    expect(client.calls[1].args[0]).toBe(RAISED[0]);
    expect(client.calls[2].args[0]).toBe(RAISED[1]);
    expect(client.calls[1].args[0]).toEqual({ memberId: "10276657743932975437", alarm: "nospace" });
  });

  test("with no alarm raised nothing is sent, and the message says so", async () => {
    const client = createFakeEtcdClient({ alarmList: async () => [], alarmDisarm: async () => [] });
    expect(await runEtcdMaintenance(client, surface(), "disarm")).toEqual({
      success: true,
      executionTime: 0,
      message: "No alarm was raised, so nothing was disarmed.",
    });
    expect(client.calls.map((call) => call.method)).toEqual(["alarmList"]);
  });

  test("an alarm its DEACTIVATE answer does not return was not cleared: success false, naming it beside what was", async () => {
    const client = createFakeEtcdClient({
      alarmList: async () => RAISED,
      alarmDisarm: async (alarm) => (alarm.alarm === "nospace" ? [alarm] : []),
    });
    expect(await runEtcdMaintenance(client, surface(), "disarm")).toEqual({
      success: false,
      executionTime: 0,
      message:
        "etcd did not clear CORRUPT on member ab54a98ceb1f0ad2; cleared NOSPACE on member 8e9e05c52164694d. Run alarm list to see what is still raised.",
    });
  });

  test("an answer naming the member's other alarm, or the type on another member, is not the pair it was sent", async () => {
    const client = createFakeEtcdClient({
      alarmList: async () => [RAISED[0]],
      alarmDisarm: async () => [
        { memberId: ETCD_1, alarm: "corrupt" },
        { memberId: ETCD_2, alarm: "nospace" },
      ],
    });
    expect(await runEtcdMaintenance(client, surface(), "disarm")).toEqual({
      success: false,
      executionTime: 0,
      message:
        "etcd did not clear NOSPACE on member 8e9e05c52164694d; none was cleared. Run alarm list to see what is still raised.",
    });
  });

  test("an alarm list that fails raises 5.6's mapped error, and nothing is disarmed", async () => {
    const client = createFakeEtcdClient({
      alarmList: async () => {
        throw toEtcdError(grpc(14, "etcdserver: no leader"));
      },
      alarmDisarm: async () => [],
    });
    await expect(runEtcdMaintenance(client, surface(), "disarm")).rejects.toThrow(ConnectionError);
    expect(client.calls.map((call) => call.method)).toEqual(["alarmList"]);
  });
});

describe("runEtcdMaintenance: a PermissionDenied from any of the three reads 7.2's one sentence (R13 D3)", () => {
  const ROOT_ONLY = "Compaction, defragmentation and alarm disarm need the etcd root role";
  const denying = () =>
    createFakeEtcdClient({
      status: async () => status(ETCD_1, "1"),
      memberList: members,
      alarmList: async () => [{ memberId: ETCD_1, alarm: "nospace" }],
      compact: async () => {
        throw DENIED();
      },
      defragment: async () => {
        throw DENIED();
      },
      alarmDisarm: async () => {
        throw DENIED();
      },
    });

  for (const type of ["compact", "defragment", "disarm"] as const) {
    test(`${type}, signed in with a password: names the user, then etcd's words`, async () => {
      const attempt = runEtcdMaintenance(denying(), surface({ principal: { name: "reader", via: "password" } }), type);
      await expect(attempt).rejects.toThrow(QueryError);
      await expect(attempt).rejects.toThrow(
        `${ROOT_ONLY}; this connection signs in as reader. (etcd: permission denied)`,
      );
    });
  }

  test("signed in by a client certificate: names its Common Name", async () => {
    await expect(
      runEtcdMaintenance(denying(), surface({ principal: { name: "reader", via: "certificate" } }), "compact"),
    ).rejects.toThrow(
      `${ROOT_ONLY}; this connection signs in as the client certificate's Common Name reader. (etcd: permission denied)`,
    );
  });

  test("with no principal the sentence names no user", async () => {
    await expect(runEtcdMaintenance(denying(), surface(), "defragment")).rejects.toThrow(
      `${ROOT_ONLY}. (etcd: permission denied)`,
    );
  });

  test("a denial that is not etcd's own text is quoted as it came, not credited to etcd", async () => {
    const client = createFakeEtcdClient({
      status: async () => status(ETCD_1, "1"),
      compact: async () => {
        throw toEtcdError(grpc(7, "a proxy in front of etcd denied the call"));
      },
    });
    await expect(runEtcdMaintenance(client, surface(), "compact")).rejects.toThrow(
      `${ROOT_ONLY}. (a proxy in front of etcd denied the call)`,
    );
  });
});
