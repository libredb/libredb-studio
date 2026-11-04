/**
 * What the confirmation gate and the etcd provider's own guard make of a set of texts, as data two runtimes can
 * compare: the gate's answer, the error the provider's `query` rejects with, and how many calls it sent the client.
 * tests/unit/db/etcd/long-line-runtimes.test.ts computes this under Bun and again in a Node child process from a
 * bundle of this file, and the two must be equal. What either one throws is reported as its name and message rather
 * than thrown, so a runtime whose reader fails says how.
 */
import { isDestructiveNonSqlQuery } from "@/lib/db/destructive-commands";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import type { DatabaseConnection } from "@/lib/types";
import { createFakeEtcdClient } from "./etcd-fake-client";
import { KEY_SPACE_HEADER } from "./etcd-key-space";

export interface EtcdTextCase {
  readonly name: string;
  readonly text: string;
}

export interface EtcdTextOutcome {
  readonly name: string;
  /** `isDestructiveNonSqlQuery(text, "etcd")`, or `<name>: <message>` of what it threw. */
  readonly gate: boolean | string;
  /** `<name>: <message>` of the error `query(text)` rejected with, or "answered". */
  readonly guard: string;
  /** The calls `query(text)` sent the client. */
  readonly sent: number;
}

const described = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function gateAnswer(text: string): boolean | string {
  try {
    return isDestructiveNonSqlQuery(text, "etcd");
  } catch (error) {
    return described(error);
  }
}

/** A connected provider over a fake cluster with authentication off, which answers only the connect sequence. */
async function connectedProvider() {
  const client = createFakeEtcdClient({
    authStatus: async () => ({ enabled: false, authRevision: "1" }),
    status: async () => ({
      header: KEY_SPACE_HEADER,
      version: "3.7.2",
      dbSize: "20480",
      dbSizeInUse: "16384",
      dbSizeQuota: "0",
      leader: "10276657743932975437",
      raftIndex: "40",
      raftTerm: "2",
      raftAppliedIndex: "40",
      errors: [],
      isLearner: false,
      storageVersion: "3.7.0",
    }),
    close: async () => {},
  });
  const connection: DatabaseConnection = {
    id: "etcd-text",
    name: "etcd text",
    type: "etcd",
    host: "etcd.test",
    port: 2379,
    createdAt: new Date(0),
  };
  const provider = new EtcdProvider(connection, { queryTimeout: 5_000 }, {}, async () => client);
  await provider.connect();
  return { provider, client };
}

export async function etcdTextOutcomes(cases: readonly EtcdTextCase[]): Promise<EtcdTextOutcome[]> {
  const { provider, client } = await connectedProvider();
  const outcomes: EtcdTextOutcome[] = [];
  try {
    for (const { name, text } of cases) {
      const before = client.calls.length;
      let guard = "answered";
      try {
        // oxlint-disable-next-line no-await-in-loop -- one text at a time, so each one's calls are counted alone.
        await provider.query(text);
      } catch (error) {
        guard = described(error);
      }
      outcomes.push({ name, gate: gateAnswer(text), guard, sent: client.calls.length - before });
    }
  } finally {
    await provider.disconnect();
  }
  return outcomes;
}
