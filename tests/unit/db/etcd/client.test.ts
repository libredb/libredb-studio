import { describe, expect, test } from "bun:test";
import { ETCD_CLIENT_METHODS, type EtcdClient, EtcdError } from "@/lib/db/providers/keyvalue/etcd/client";
import { createFakeEtcdClient } from "../../../helpers/etcd-fake-client";

const signal = new AbortController().signal;

/** Spec E11, in its own order, plus close() for E16. */
const E11_ALLOWLIST = [
  "range",
  "put",
  "deleteRange",
  "txn",
  "watch",
  "leaseGrant",
  "leaseRevoke",
  "leaseKeepAliveOnce",
  "leaseTimeToLive",
  "leaseLeases",
  "memberList",
  "status",
  "alarmList",
  "alarmDisarm",
  "compact",
  "defragment",
  "authStatus",
  "authenticate",
  "userList",
  "userGet",
  "roleList",
  "roleGet",
];

describe("ETCD_CLIENT_METHODS", () => {
  test("is exactly the allowlist of spec E11 plus close()", () => {
    const listed: readonly string[] = ETCD_CLIENT_METHODS;
    expect(listed).toEqual([...E11_ALLOWLIST, "close"]);
  });

  test("names no method twice", () => {
    expect(new Set(ETCD_CLIENT_METHODS).size).toBe(ETCD_CLIENT_METHODS.length);
  });
});

describe("EtcdError", () => {
  test("carries the category, etcd's text as detail and message, and the gRPC code", () => {
    const error = new EtcdError("no-leader", "etcdserver: no leader", 14);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EtcdError");
    expect(error.category).toBe("no-leader");
    expect(error.detail).toBe("etcdserver: no leader");
    expect(error.message).toBe("etcdserver: no leader");
    expect(error.grpcCode).toBe(14);
    expect(error.tlsFailure).toBeUndefined();
  });

  test("leaves the gRPC code absent when none was given", () => {
    const error = new EtcdError("closed", "closed");
    expect(error.grpcCode).toBeUndefined();
    expect("grpcCode" in error).toBe(false);
  });

  test("carries a TLS failure on the tls category", () => {
    const error = new EtcdError("tls", "unable to verify the first certificate", 14, "chain");
    expect(error.tlsFailure).toBe("chain");
  });

  test("refuses a TLS failure on any other category", () => {
    expect(() => new EtcdError("not-connected", "Failed to connect", 14, "chain")).toThrow(
      "An EtcdError of category not-connected cannot carry a TLS failure",
    );
  });
});

describe("createFakeEtcdClient (plan Contract C12)", () => {
  test("rejects every method it was not given with an unknown EtcdError naming the method", async () => {
    const fake = createFakeEtcdClient();
    const errors = await Promise.all(
      ETCD_CLIENT_METHODS.map((method) =>
        (fake[method] as (...args: unknown[]) => Promise<unknown>)(signal).catch((e: unknown) => e),
      ),
    );
    ETCD_CLIENT_METHODS.forEach((method, index) => {
      const error = errors[index];
      expect(error).toBeInstanceOf(EtcdError);
      expect((error as EtcdError).category).toBe("unknown");
      expect((error as EtcdError).detail).toBe(`The fake etcd client has no stub for ${method}`);
    });
  });

  test("runs an override with the caller's arguments and answers its result as the same object", async () => {
    const answer = { enabled: true, authRevision: "7" };
    const fake = createFakeEtcdClient({ authStatus: async () => answer });
    expect(await fake.authStatus({ signal })).toBe(answer);
  });

  test("records every call in order, the stubbed and the unstubbed, with its arguments by identity", async () => {
    const request = { key: new Uint8Array([0x61]), limit: 1 };
    const options = { signal };
    const fake = createFakeEtcdClient({
      range: async () => ({
        header: { clusterId: "1", memberId: "2", revision: "3", raftTerm: "4" },
        kvs: [],
        more: false,
        count: "0",
      }),
    });
    await fake.range(request, options);
    await fake.status(options).catch(() => undefined);
    await fake.leaseTimeToLive("5", true, options).catch(() => undefined);
    expect(fake.calls.map((c) => c.method)).toEqual(["range", "status", "leaseTimeToLive"]);
    expect(fake.calls[0].args[0]).toBe(request);
    expect(fake.calls[0].args[1]).toBe(options);
    expect(fake.calls[2].args).toEqual(["5", true, options]);
  });

  test("records a call before its override runs, so a call that throws is still recorded", async () => {
    let seen = -1;
    const fake = createFakeEtcdClient({
      put: async () => {
        seen = fake.calls.length;
        throw new EtcdError("permission-denied", "etcdserver: permission denied", 7);
      },
    });
    const put = fake.put({ key: new Uint8Array(), value: new Uint8Array() }, { signal });
    await expect(put).rejects.toBeInstanceOf(EtcdError);
    expect(seen).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });

  test("a fresh fake records nothing", () => {
    const fake: EtcdClient = createFakeEtcdClient();
    expect((fake as ReturnType<typeof createFakeEtcdClient>).calls).toEqual([]);
  });
});
