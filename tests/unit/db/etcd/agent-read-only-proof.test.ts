/**
 * The etcd agent read-only proof over what etcd v3.7.2 answered each principal
 * (tests/fixtures/etcd/v3.7.2/agent-boundary/): authentication on, no root user or role, and every permission of every
 * role READ, each read from the server for every proof.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  ETCD_PROOF_SENTENCES,
  etcdAgentUser,
  proveEtcdReadOnly,
} from "@/lib/db/providers/keyvalue/etcd/agent-read-only-proof";
import type { EtcdClient, EtcdPermission } from "@/lib/db/providers/keyvalue/etcd/client";
import { EtcdError } from "@/lib/db/providers/keyvalue/etcd/client";
import {
  type CapturedAnswer,
  capturedBytes,
  capturedClient,
  principalCapture,
  readEtcdAgentCapture,
} from "../../../helpers/etcd-agent";
import { createFakeEtcdClient } from "../../../helpers/etcd-fake-client";

const signal = () => new AbortController().signal;

/** The proof's verdict for a client, as the refusal's sentence and code, or "proved". */
async function verdict(client: Pick<EtcdClient, "authStatus" | "userGet" | "roleGet">, user: string) {
  try {
    await proveEtcdReadOnly(client, user, signal());
    return "proved";
  } catch (error) {
    if (!(error instanceof ExecutionProfileError)) throw error;
    return { message: error.message, reason: error.reasonCode };
  }
}

describe("the user named at open", () => {
  test("a connection that names no user, by password or certificate, is refused before anything is sent", () => {
    for (const principal of [undefined, { name: "" }]) {
      expect(() => etcdAgentUser(principal)).toThrow(
        new ExecutionProfileError(ETCD_PROOF_SENTENCES.noUser, "PROFILE_SERVER_UNENFORCED"),
      );
    }
  });

  test("root is refused by name", () => {
    expect(() => etcdAgentUser({ name: "root" })).toThrow(ETCD_PROOF_SENTENCES.rootUser);
    try {
      etcdAgentUser({ name: "root" });
    } catch (error) {
      expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    }
  });

  test("any other user is the one the proof reads", () => {
    expect(etcdAgentUser({ name: "agent_reader" })).toBe("agent_reader");
  });
});

describe("the proof over the captured principals", () => {
  test("authentication off is refused: etcd answered every write with no token", async () => {
    const capture = principalCapture("auth-off");
    for (const probe of ["put", "deleteRange", "compactRevisionOne", "defragment", "snapshot", "userAdd"]) {
      expect(capture.probes[probe]?.outcome).toBe("ok");
    }
    const client = createFakeEtcdClient(capturedClient(capture));
    expect(await verdict(client, "agent_reader")).toEqual({
      message: ETCD_PROOF_SENTENCES.authOff,
      reason: "PROFILE_SERVER_UNENFORCED",
    });
    expect(client.calls.map((call) => call.method)).toEqual(["authStatus"]);
  });

  test("a user holding the root role is refused, and every write the probes sent was admitted to it", async () => {
    const capture = principalCapture("root-role");
    expect(capture.probes.put?.outcome).toBe("ok");
    expect(capture.probes.userAdd?.outcome).toBe("ok");
    const client = createFakeEtcdClient(capturedClient(capture));
    expect(await verdict(client, capture.$captured.principal)).toEqual({
      message: ETCD_PROOF_SENTENCES.rootRole,
      reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    });
    // The roles are read and root's is never asked for: RoleGet of root answers no permission at all.
    expect(client.calls.map((call) => call.method)).toEqual(["authStatus", "userGet"]);
  });

  test("root's own answers would refuse it too, after the name already has", async () => {
    const capture = principalCapture("root");
    expect(capture.reads["roleGet:root"]).toMatchObject({
      outcome: "error",
      details: "etcdserver: role name not found",
    });
    expect(await verdict(createFakeEtcdClient(capturedClient(capture)), "agent_named_otherwise")).toMatchObject({
      message: ETCD_PROOF_SENTENCES.rootRole,
    });
  });

  test.each(["reader-all", "reader-range", "no-roles"] as const)(
    "%s holds READ only, reads its own roles, and is proved",
    async (name) => {
      const capture = principalCapture(name);
      const client = createFakeEtcdClient(capturedClient(capture));
      expect(await verdict(client, capture.$captured.principal)).toBe("proved");
      const roles = capture.$captured.roles?.map((role) => role.role) ?? [];
      expect(client.calls.map((call): string => call.method)).toEqual([
        "authStatus",
        "userGet",
        ...roles.map(() => "roleGet"),
      ]);
      expect(client.calls.find((call) => call.method === "userGet")?.args[0]).toBe(capture.$captured.principal);
      // Every key write the probes sent was refused to it, as a permission refusal.
      for (const probe of ["put", "putInScratchRange", "deleteRange", "txnPut", "compactRevisionOne", "defragment"]) {
        expect(capture.probes[probe]).toMatchObject({
          outcome: "error",
          code: 7,
          details: "etcdserver: permission denied",
        });
      }
    },
  );

  test.each(["readwrite-range", "write-range"] as const)(
    "%s is refused a write on a random key but writes its own range, so the role read refuses it",
    async (name) => {
      const capture = principalCapture(name);
      expect(capture.probes.put).toMatchObject({ outcome: "error", details: "etcdserver: permission denied" });
      expect(capture.probes.putInScratchRange?.outcome).toBe("ok");
      expect(capture.probes.deleteRangeInScratchRange?.outcome).toBe("ok");
      expect(await verdict(createFakeEtcdClient(capturedClient(capture)), capture.$captured.principal)).toEqual({
        message: ETCD_PROOF_SENTENCES.writer,
        reason: "PROFILE_PRIVILEGES_TOO_BROAD",
      });
    },
  );

  test("a user who is not root reads itself and its own roles, and is refused every other user and role", () => {
    const capture = principalCapture("reader-range");
    expect(capture.reads.userGetSelf?.outcome).toBe("ok");
    expect(capture.reads["roleGet:agent_read_app"]?.outcome).toBe("ok");
    expect(capture.reads.userGetRoot).toMatchObject({ outcome: "error", details: "etcdserver: permission denied" });
    expect(capture.reads["roleGet:agent_read_all(not held)"]).toMatchObject({
      outcome: "error",
      details: "etcdserver: permission denied",
    });
  });

  test("a READ-only user is granted and revokes a lease: a call the roles do not govern, which the table never sends", () => {
    const capture = principalCapture("reader-all");
    expect(capture.probes.leaseGrant?.outcome).toBe("ok");
    expect(capture.probes.leaseRevokeGranted?.outcome).toBe("ok");
  });
});

describe("a grant made during the run", () => {
  interface Midrun {
    readonly roleBefore: CapturedAnswer;
    readonly putBefore: CapturedAnswer;
    readonly grantAsRoot: CapturedAnswer;
    readonly roleAfter: CapturedAnswer;
    readonly putAfter: CapturedAnswer;
  }
  const midrun = readEtcdAgentCapture<Midrun>("midrun");
  const permissions = (answer: CapturedAnswer): EtcdPermission[] =>
    (answer as { answer: { perm: Array<{ permType: string; key: unknown }> } }).answer.perm.map((permission) => ({
      type: permission.permType.toLowerCase() as EtcdPermission["type"],
      key: capturedBytes(permission.key),
    }));

  test("the same token writes once WRITE is granted, and the next proof reads the grant and refuses", async () => {
    expect(midrun.putBefore).toMatchObject({ outcome: "error", details: "etcdserver: permission denied" });
    expect(midrun.grantAsRoot.outcome).toBe("ok");
    expect(midrun.putAfter.outcome).toBe("ok");
    let answer = midrun.roleBefore;
    const client = createFakeEtcdClient({
      authStatus: async () => ({ enabled: true, authRevision: "1" }),
      userGet: async () => ["agent_midrun"],
      roleGet: async () => permissions(answer),
    });
    expect(await verdict(client, "agent_midrun")).toBe("proved");
    answer = midrun.roleAfter;
    expect(await verdict(client, "agent_midrun")).toEqual({
      message: ETCD_PROOF_SENTENCES.writer,
      reason: "PROFILE_PRIVILEGES_TOO_BROAD",
    });
    // Nothing is kept: each proof read the server again.
    expect(client.calls.filter((call) => call.method === "roleGet")).toHaveLength(2);
  });
});

describe("an answer that proves nothing", () => {
  const enabled = async () => ({ enabled: true, authRevision: "1" });
  const denied = () => new EtcdError("permission-denied", "etcdserver: permission denied", 7);

  test("a user whose own roles cannot be read is refused, never assumed a reader", async () => {
    const userRefused = createFakeEtcdClient({ authStatus: enabled, userGet: async () => Promise.reject(denied()) });
    expect(await verdict(userRefused, "agent")).toEqual({
      message: ETCD_PROOF_SENTENCES.unread,
      reason: "PROFILE_UNSUPPORTED_TARGET",
    });
    const roleRefused = createFakeEtcdClient({
      authStatus: enabled,
      userGet: async () => ["reader"],
      roleGet: async () => Promise.reject(denied()),
    });
    expect(await verdict(roleRefused, "agent")).toMatchObject({ message: ETCD_PROOF_SENTENCES.unread });
  });

  test("a transport failure is raised as itself, never read as a verdict", async () => {
    const down = new EtcdError("unavailable", "etcdserver: request timed out", 14);
    const failing = createFakeEtcdClient({ authStatus: enabled, userGet: async () => Promise.reject(down) });
    await expect(proveEtcdReadOnly(failing, "agent", signal())).rejects.toBe(down);
    const statusDown = createFakeEtcdClient({ authStatus: async () => Promise.reject(down) });
    await expect(proveEtcdReadOnly(statusDown, "agent", signal())).rejects.toBe(down);
  });

  test("root is refused by name even when the client would answer for it", async () => {
    const client = createFakeEtcdClient({ authStatus: enabled, userGet: async () => [] });
    await expect(proveEtcdReadOnly(client, "root", signal())).rejects.toThrow(ETCD_PROOF_SENTENCES.rootUser);
    expect(client.calls.map((call) => call.method)).toEqual(["authStatus"]);
  });

  test("every call carries the proof's own signal", async () => {
    const own = new AbortController().signal;
    const client = createFakeEtcdClient({
      authStatus: enabled,
      userGet: async () => ["r"],
      roleGet: async () => [],
    });
    await proveEtcdReadOnly(client, "agent", own);
    for (const call of client.calls) expect(call.args.at(-1)).toEqual({ signal: own });
  });
});
