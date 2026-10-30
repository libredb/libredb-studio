/**
 * Replays what etcd v3.7.2 answered each agent principal, from the captures under
 * tests/fixtures/etcd/v3.7.2/agent-boundary/, so the etcd agent tests read the server's own answers rather than
 * answers written for them. Each captured gRPC answer is turned into what the provider's adapter hands on (the
 * `EtcdClient` shapes), and each captured gRPC status into the `EtcdError` the adapter's own table makes of it.
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type {
  EtcdAlarm,
  EtcdAuthStatus,
  EtcdClient,
  EtcdError,
  EtcdKeyValue,
  EtcdLeaseTimeToLiveResponse,
  EtcdMember,
  EtcdPermission,
  EtcdRangeResponse,
  EtcdStatus,
} from "@/lib/db/providers/keyvalue/etcd/client";
import { toEtcdError } from "@/lib/db/providers/keyvalue/etcd/errors";
import { KEY_SPACE_HEADER } from "./etcd-key-space";

const FIXTURES = posix.join(import.meta.dir.replaceAll("\\", "/"), "../fixtures/etcd/v3.7.2/agent-boundary");

/** One captured call: the answer, or the gRPC status the server refused it with. */
export type CapturedAnswer =
  | { readonly outcome: "ok"; readonly answer: unknown }
  | { readonly outcome: "error"; readonly code: number; readonly details: string };

export interface PrincipalCapture {
  readonly $captured: {
    readonly principal: string;
    readonly roles?: ReadonlyArray<{ readonly role: string }>;
  };
  readonly reads: Readonly<Record<string, CapturedAnswer>>;
  readonly probes: Readonly<Record<string, CapturedAnswer>>;
  readonly stateBefore: CapturedState;
  readonly stateAfter: CapturedState;
}

export interface CapturedState {
  readonly revision: string;
  readonly keys: readonly unknown[];
  readonly leases: readonly unknown[];
  readonly auth: unknown;
}

/** The principals captured on the server with authentication on, and the one with it off. */
export const ETCD_AGENT_PRINCIPALS = [
  "root",
  "root-role",
  "reader-all",
  "reader-range",
  "readwrite-range",
  "write-range",
  "no-roles",
] as const;
export type EtcdAgentPrincipal = (typeof ETCD_AGENT_PRINCIPALS)[number];

export function readEtcdAgentCapture<T>(name: string): T {
  return JSON.parse(readFileSync(posix.join(FIXTURES, `${name}.json`), "utf8")) as T;
}

export function principalCapture(name: EtcdAgentPrincipal | "auth-off"): PrincipalCapture {
  return readEtcdAgentCapture<PrincipalCapture>(name);
}

/** A capture's bytes, written as `{ "$text" }` or `{ "$bytes" }`. */
export function capturedBytes(value: unknown): Uint8Array {
  const shown = value as { readonly $text?: string; readonly $bytes?: string };
  if (shown.$text !== undefined) return new TextEncoder().encode(shown.$text);
  return new Uint8Array(Buffer.from(shown.$bytes ?? "", "base64"));
}

/** The `EtcdError` the adapter makes of a captured refusal. */
export function capturedError(answer: CapturedAnswer): EtcdError {
  if (answer.outcome !== "error") throw new Error("the capture holds an answer, not a refusal");
  return toEtcdError({ code: answer.code, details: answer.details });
}

/** A captured answer handed on, or its refusal thrown, as the adapter does. */
function replay<T>(answer: CapturedAnswer | undefined, map: (raw: never) => T): Promise<T> {
  if (answer === undefined) return Promise.reject(new Error("the capture holds no such call"));
  if (answer.outcome === "error") return Promise.reject(capturedError(answer));
  return Promise.resolve(map(answer.answer as never));
}

interface RawKeyValue {
  readonly key: unknown;
  readonly value: unknown;
  readonly create_revision: string;
  readonly mod_revision: string;
  readonly version: string;
  readonly lease: string;
}

function keyValue(raw: RawKeyValue): EtcdKeyValue {
  return {
    key: capturedBytes(raw.key),
    value: capturedBytes(raw.value),
    createRevision: raw.create_revision,
    modRevision: raw.mod_revision,
    version: raw.version,
    lease: raw.lease,
  };
}

export function capturedRange(raw: { kvs: RawKeyValue[]; more: boolean; count: string }): EtcdRangeResponse {
  return { header: KEY_SPACE_HEADER, kvs: raw.kvs.map(keyValue), more: raw.more, count: raw.count };
}

export function capturedStatus(raw: {
  header: { member_id: string };
  version: string;
  dbSize: string;
  dbSizeInUse: string;
  dbSizeQuota: string;
  leader: string;
  raftIndex: string;
  raftTerm: string;
  raftAppliedIndex: string;
  errors: string[];
  isLearner: boolean;
  storageVersion: string;
}): EtcdStatus {
  return {
    header: { ...KEY_SPACE_HEADER, memberId: raw.header.member_id },
    version: raw.version,
    dbSize: raw.dbSize,
    dbSizeInUse: raw.dbSizeInUse,
    dbSizeQuota: raw.dbSizeQuota,
    leader: raw.leader,
    raftIndex: raw.raftIndex,
    raftTerm: raw.raftTerm,
    raftAppliedIndex: raw.raftAppliedIndex,
    errors: raw.errors,
    isLearner: raw.isLearner,
    storageVersion: raw.storageVersion,
  };
}

export function capturedMembers(raw: {
  members: Array<{ ID: string; name: string; peerURLs: string[]; clientURLs: string[]; isLearner: boolean }>;
}): EtcdMember[] {
  return raw.members.map((member) => ({
    id: member.ID,
    name: member.name,
    peerUrls: member.peerURLs,
    clientUrls: member.clientURLs,
    isLearner: member.isLearner,
  }));
}

export function capturedAlarms(raw: { alarms: Array<{ memberID: string; alarm: string }> }): EtcdAlarm[] {
  return raw.alarms.map((alarm) => ({
    memberId: alarm.memberID,
    alarm: alarm.alarm.toLowerCase() as EtcdAlarm["alarm"],
  }));
}

export function capturedLeaseTtl(raw: {
  ID: string;
  TTL: string;
  grantedTTL: string;
  keys: unknown[];
}): EtcdLeaseTimeToLiveResponse {
  return {
    header: KEY_SPACE_HEADER,
    id: raw.ID,
    ttl: raw.TTL,
    grantedTtl: raw.grantedTTL,
    keys: raw.keys.map(capturedBytes),
  };
}

function capturedAuth(raw: { enabled: boolean; authRevision: string }): EtcdAuthStatus {
  return { enabled: raw.enabled, authRevision: raw.authRevision };
}

function capturedPermissions(raw: {
  perm: Array<{ permType: string; key: unknown; range_end: unknown }>;
}): EtcdPermission[] {
  return raw.perm.map((permission) => {
    const rangeEnd = capturedBytes(permission.range_end);
    return {
      type: permission.permType.toLowerCase() as EtcdPermission["type"],
      key: capturedBytes(permission.key),
      ...(rangeEnd.length === 0 ? {} : { rangeEnd }),
    };
  });
}

/** The keys a principal's captured single-key reads name, by the capture's read name. */
export const CAPTURED_KEYS = {
  rangeKey: "/app/config",
  rangeKeyLeased: "/app/session",
  rangeKeyMissing: "/app/missing",
  rangeKeyOutside: "/other/credential",
} as const;

/**
 * The client calls the agent path and its proof make, answered from `capture`: the proof's three reads, the table's
 * reads, and a single-key or every-key range by the key it names. A call the capture does not hold rejects.
 */
export function capturedClient(capture: PrincipalCapture): Partial<EtcdClient> {
  const { reads } = capture;
  const decoder = new TextDecoder();
  return {
    authStatus: async () => replay(reads.authStatus, capturedAuth),
    userGet: async () => replay(reads.userGetSelf, (raw: { roles: string[] }) => raw.roles),
    roleGet: async (role) => replay(reads[`roleGet:${role}`], capturedPermissions),
    status: async () => replay(reads.status, capturedStatus),
    memberList: async () =>
      replay(reads.memberListLinearizable, (raw: Parameters<typeof capturedMembers>[0]) => ({
        header: KEY_SPACE_HEADER,
        members: capturedMembers(raw),
      })),
    alarmList: async () => replay(reads.alarmGet, capturedAlarms),
    leaseLeases: async () =>
      replay(reads.leaseLeases, (raw: { leases: Array<{ ID: string }> }) => ({
        header: KEY_SPACE_HEADER,
        ids: raw.leases.map((lease) => lease.ID),
      })),
    leaseTimeToLive: async (_id, keys) =>
      replay(keys ? reads.leaseTimeToLiveKeys : reads.leaseTimeToLive, capturedLeaseTtl),
    range: async (request) => {
      if (request.countOnly === true) return replay(reads.rangeCountAll, capturedRange);
      const key = decoder.decode(request.key);
      const read = Object.entries(CAPTURED_KEYS).find(([, named]) => named === key)?.[0];
      return replay(read === undefined ? undefined : reads[read], capturedRange);
    },
  };
}
