/**
 * The shared fake `EtcdClient` every etcd unit test builds on (plan Contract C12).
 *
 * Every call is recorded in order, before the stub runs, so a test can require the exact sequence
 * of requests a module sent, and that a refusal sent none. A method the test does not override
 * rejects with an `EtcdError` of category `unknown` naming the method, so a module that reaches for
 * an RPC the test did not expect fails loudly instead of reading `undefined`.
 */
import { ETCD_CLIENT_METHODS, type EtcdClient, EtcdError } from "@/lib/db/providers/keyvalue/etcd/client";

export interface FakeEtcdCall {
  readonly method: keyof EtcdClient;
  readonly args: readonly unknown[];
}

export type FakeEtcdClient = EtcdClient & { readonly calls: ReadonlyArray<FakeEtcdCall> };

export function createFakeEtcdClient(overrides: Partial<EtcdClient> = {}): FakeEtcdClient {
  const calls: FakeEtcdCall[] = [];
  const client: Record<string, unknown> = { calls };
  for (const method of ETCD_CLIENT_METHODS) {
    const stub = overrides[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    client[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      if (stub === undefined) {
        return Promise.reject(new EtcdError("unknown", `The fake etcd client has no stub for ${method}`));
      }
      return stub(...args);
    };
  }
  return client as unknown as FakeEtcdClient;
}
