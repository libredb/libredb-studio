/**
 * The etcd agent boundary, replayed from what etcd v3.7.2 answered requests sent raw over gRPC, with no Studio check
 * in front of them (tests/fixtures/etcd/v3.7.2/agent-boundary/run.sh). A principal the proof admits is refused every
 * write, compaction, defragmentation, snapshot, member and user change as an authorization refusal, and the server's
 * keys, revision and leases read the same before and after; root, the positive control, is admitted every one. Every
 * read the table holds, run through the provider for every principal, answers no seeded key name or value.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import { proveEtcdReadOnly } from "@/lib/db/providers/keyvalue/etcd/agent-read-only-proof";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import type { DatabaseConnection } from "@/lib/types";
import {
  capturedClient,
  capturedError,
  ETCD_AGENT_PRINCIPALS,
  type EtcdAgentPrincipal,
  principalCapture,
} from "../../../helpers/etcd-agent";
import { createFakeEtcdClient } from "../../../helpers/etcd-fake-client";

/** The writes the probes sent, every one a change to the server when admitted. */
const WRITES = [
  "put",
  "deleteRange",
  "txnPut",
  "txnDeleteProbe",
  "compactRevisionOne",
  "alarmDeactivateNone",
  "defragment",
  "hashKV",
  "snapshot",
  "memberRemoveUnknown",
  "userAdd",
  "roleRevokeUnknown",
] as const;

/** Every key name and value the run seeded; none may reach an agent answer. */
const SEEDED = [
  "/app/config",
  "/app/feature",
  "/app/session",
  "/other/credential",
  "fixture-config-value",
  "fixture-feature-flag",
  "fixture-outside-value",
  "fixture-session",
];

const signal = () => new AbortController().signal;

async function proved(principal: EtcdAgentPrincipal): Promise<boolean> {
  const capture = principalCapture(principal);
  return proveEtcdReadOnly(createFakeEtcdClient(capturedClient(capture)), capture.$captured.principal, signal()).then(
    () => true,
    (error: unknown) => {
      if (error instanceof ExecutionProfileError) return false;
      throw error;
    },
  );
}

describe("what the proof admits, the server refuses every write to", () => {
  test("the proof admits exactly the READ-only principals", async () => {
    const admitted: string[] = [];
    for (const principal of ETCD_AGENT_PRINCIPALS) if (await proved(principal)) admitted.push(principal);
    expect(admitted).toEqual(["reader-all", "reader-range", "no-roles"]);
  });

  test.each(["reader-all", "reader-range", "no-roles"] as const)(
    "%s is refused every write as an authorization refusal, and the server is unchanged",
    (principal) => {
      const capture = principalCapture(principal);
      for (const write of WRITES) {
        const answer = capture.probes[write];
        expect({ write, outcome: answer?.outcome }).toEqual({ write, outcome: "error" });
        // Classified by the adapter's own table as a refusal of authorization, never as a malformed request.
        expect({ write, category: capturedError(answer!).category }).toEqual({ write, category: "permission-denied" });
      }
      expect(capture.stateAfter.keys).toEqual(capture.stateBefore.keys);
      expect(capture.stateAfter.leases).toEqual(capture.stateBefore.leases);
      // Its one change is the lease the probes granted and revoked at once: v3.7.2 asks no permission for either,
      // which is why the table sends neither.
      expect(capture.probes.leaseGrant?.outcome).toBe("ok");
      expect(capture.probes.leaseRevokeGranted?.outcome).toBe("ok");
    },
  );

  test("root, the positive control, is admitted every write the probes sent", () => {
    const capture = principalCapture("root");
    for (const write of ["put", "deleteRange", "txnPut", "compactRevisionOne", "defragment", "snapshot", "userAdd"]) {
      expect({ write, outcome: capture.probes[write]?.outcome }).toEqual({ write, outcome: "ok" });
    }
    // The ids that exist nowhere are refused for being unknown, not for authorization.
    expect(capture.probes.memberRemoveUnknown).toMatchObject({ details: "etcdserver: member not found" });
  });

  test("with authentication off every write is admitted to no user at all", () => {
    const capture = principalCapture("auth-off");
    for (const write of ["put", "deleteRange", "txnPut", "compactRevisionOne", "defragment", "snapshot", "userAdd"]) {
      expect({ write, outcome: capture.probes[write]?.outcome }).toEqual({ write, outcome: "ok" });
    }
  });
});

describe("every read of the table answers no key name or value", () => {
  const READS = [
    "endpoint status",
    "member list",
    "alarm list",
    "auth status",
    "lease list",
    "lease timetolive 694d8147df1dc4c8",
    'get "" --prefix --count-only',
    "get /app/config",
    "get /app/session",
    "get /app/missing",
    "get /other/credential",
  ];
  const BUDGET = { maxResultRows: 200, maxResultBytes: 64 * 1024, statementTimeoutMs: 10_000 };

  test.each(["reader-all", "reader-range", "no-roles"] as const)("as %s, answer or refusal", async (principal) => {
    const capture = principalCapture(principal);
    const client = createFakeEtcdClient({
      ...capturedClient(capture),
      authenticate: async () => {},
      close: async () => {},
    });
    const connection: DatabaseConnection = {
      id: "etcd-boundary",
      name: "etcd boundary",
      type: "etcd",
      host: "etcd.test",
      port: 2379,
      user: capture.$captured.principal,
      password: "not-a-real-password",
      ssl: { mode: "require" },
      createdAt: new Date(0),
    };
    const provider = new EtcdProvider(connection, {}, { readOnly: true, sendsStatements: true }, async () => client);
    await provider.connect();
    for (const text of READS) {
      // oxlint-disable-next-line no-await-in-loop -- one command at a time, as the agent sends them.
      const outcome = await provider.queryReadOnly(text, BUDGET).then(
        (result) => JSON.stringify(result),
        (error: unknown) => (error as Error).message,
      );
      // The command's own key appears in the command, never in what comes back.
      for (const seeded of SEEDED) expect({ text, leaked: outcome.includes(seeded) }).toEqual({ text, leaked: false });
      expect(outcome).not.toContain("etcdserver");
    }
  });
});
