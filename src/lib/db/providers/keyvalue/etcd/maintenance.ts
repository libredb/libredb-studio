/**
 * Compaction, defragmentation and alarm disarm (spec 7.2): the operations of the three declared cards
 * of Admin > Operations, reached only through the admin-only, audited maintenance route (spec E7), each
 * typed-confirmed with the connection's name (spec 3.4), and each refused on a read-only connection
 * before any request (spec E6).
 *
 * On an etcd with auth on all three need the root role, each through `AuthAdmin.isPermitted` (SRC
 * `etcd__server_etcdserver_api_v3rpc_key.go`, `kvServer.Compact`, and
 * `etcd__server_etcdserver_api_v3rpc_maintenance.go`, `authMaintenanceServer.Defragment` and `.Alarm`;
 * R13 D3), so a PermissionDenied from any of them reads 7.2's one sentence, naming who this connection
 * signs in as. Every other failure reads errors.ts's table as a read's, because running any of the
 * three again is harmless and a key-shaped "read the key again" would be the wrong advice. The result
 * is the engine's verdict, under the route's `success: false` rule.
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseType, MaintenanceOperation, MaintenanceOperationSpec, MaintenanceResult } from "@/lib/db/types";
import { type EtcdAlarm, type EtcdClient, EtcdError, type EtcdStatus } from "./client";
import { etcdWords, toProviderError } from "./errors";
import { describeAlarm, formatEtcdBytes, memberLabel } from "./monitoring";
import type { EtcdSurfaceContext } from "./objects";
import { refuseReadOnly } from "./write-policy";

const PROVIDER: DatabaseType = "etcd";

/** etcd's three operations, each its own `MaintenanceOperation`, never a reused `vacuum` or `optimize` (spec 7.2, R13 A2). */
export const ETCD_MAINTENANCE_OPERATIONS: readonly MaintenanceOperation[] = ["compact", "defragment", "disarm"];

/**
 * The three declared cards (spec 7.2): each global and never per entity, typed-confirmed with the
 * connection's name, and worded by its label, title and description, which the Operations tab draws
 * verbatim (spec 3.4).
 */
export const ETCD_MAINTENANCE_SPECS: Partial<Record<MaintenanceOperation, MaintenanceOperationSpec>> = {
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
};

export type EtcdMaintenanceClient = Pick<
  EtcdClient,
  "status" | "memberList" | "compact" | "defragment" | "alarmList" | "alarmDisarm"
>;

/** What one operation found; runEtcdMaintenance adds the time it took. */
interface Verdict {
  readonly success: boolean;
  readonly message: string;
}

/** 7.2's sentence for a PermissionDenied from Compact, Defragment or an alarm DEACTIVATE (R13 D3). */
function rootRoleSentence(context: EtcdSurfaceContext): string {
  const principal = context.principal;
  if (principal === undefined) return "Compaction, defragmentation and alarm disarm need the etcd root role.";
  const who =
    principal.via === "certificate" ? `the client certificate's Common Name ${principal.name}` : principal.name;
  return `Compaction, defragmentation and alarm disarm need the etcd root role; this connection signs in as ${who}.`;
}

/** A read on the way to an operation, its failure raised through errors.ts's table (spec 5.6). */
async function readFor<T>(context: EtcdSurfaceContext, command: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toProviderError(error, { command, write: false, connection: context.errors });
  }
}

/** The operation's own RPC: a PermissionDenied reads 7.2's sentence, and anything else errors.ts's table. */
async function operate<T>(context: EtcdSurfaceContext, command: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof EtcdError && error.category === "permission-denied") {
      throw new QueryError(`${rootRoleSentence(context)}${etcdWords(error)}`, PROVIDER);
    }
    throw toProviderError(error, { command, write: false, connection: context.errors });
  }
}

/**
 * `Compact` to the current revision, which `Status` answers, sent with `physical: true`, which the
 * adapter sets (spec 7.2). etcd answers "required revision has been compacted" when history is already
 * gone up to that revision or past it, which is the state this operation asks for, so it is said as that.
 */
async function compact(client: EtcdMaintenanceClient, context: EtcdSurfaceContext): Promise<Verdict> {
  const status = await readFor(context, "status read", () => client.status({ signal: context.signal }));
  const revision = status.header.revision;
  const compacted = await operate(context, "compaction", async () => {
    try {
      await client.compact(revision, { signal: context.signal });
      return true;
    } catch (error) {
      if (error instanceof EtcdError && error.category === "compacted") return false;
      throw error;
    }
  });
  if (!compacted) {
    return {
      success: true,
      message: `History is already compacted to revision ${revision} or later: there was no older revision to remove.`,
    };
  }
  return {
    success: true,
    message: `Compacted history to revision ${revision}: every revision before it is gone, so a history read or a watch from an older revision now fails.`,
  };
}

/**
 * Defragments the member this connection reaches (spec 7.2): `Status` and a serializable `MemberList`
 * name it and read its size, `Defragment` runs on it, and `Status` again reads its size after. The
 * `Defragment` answer carries no header, so each `Status` answer's member id names the member it came
 * from, and the sizes are given only when both name one member, since a `pick_first` failover between
 * them would make which one was defragmented unknowable (spec 6.1, R12 UX-11). The operation has run
 * once `Defragment` answers, so a failed second `Status` is said in the message, not raised.
 */
async function defragment(client: EtcdMaintenanceClient, context: EtcdSurfaceContext): Promise<Verdict> {
  const before = await readFor(context, "status read", () => client.status({ signal: context.signal }));
  const { members } = await readFor(context, "member list", () =>
    client.memberList({ linearizable: false }, { signal: context.signal }),
  );
  await operate(context, "defragmentation", () => client.defragment({ signal: context.signal }));
  const named = memberLabel(before.header.memberId, members);
  let after: EtcdStatus;
  try {
    after = await client.status({ signal: context.signal });
  } catch (error) {
    const reason = toProviderError(error, { command: "status read", write: false, connection: context.errors }).message;
    return {
      success: true,
      message: `Defragmented ${named}. Its size afterwards could not be read, so the sizes are not compared: ${reason}`,
    };
  }
  if (after.header.memberId !== before.header.memberId) {
    const other = memberLabel(after.header.memberId, members);
    return {
      success: true,
      message: `Defragmentation ran, but this connection reached ${named} before it and ${other} after it, so which member was defragmented cannot be told and the sizes are not compared.`,
    };
  }
  return {
    success: true,
    message: `Defragmented ${named}: ${formatEtcdBytes(before.dbSize)} to ${formatEtcdBytes(after.dbSize)} on disk`,
  };
}

/**
 * Disarms every raised alarm (spec 7.2): `Alarm` GET, then one `DEACTIVATE` per listed alarm carrying
 * its member id and type exactly as the GET returned them, because the server clears only an exact
 * pair and a member id of 0 clears nothing on 3.7.2 (R11 ETCD-8). A `DEACTIVATE` answer lists only the
 * alarm it cleared, so an alarm its answer does not return was not cleared, and the result is then
 * `success: false`, naming it beside what was cleared.
 */
async function disarm(client: EtcdMaintenanceClient, context: EtcdSurfaceContext): Promise<Verdict> {
  const raised = await readFor(context, "alarm list", () => client.alarmList({ signal: context.signal }));
  if (raised.length === 0) return { success: true, message: "No alarm was raised, so nothing was disarmed." };
  const cleared: EtcdAlarm[] = [];
  const left: EtcdAlarm[] = [];
  for (const alarm of raised) {
    // oxlint-disable-next-line no-await-in-loop -- one DEACTIVATE at a time, each answer read before the next is sent.
    const answer = await operate(context, "alarm disarm", () => client.alarmDisarm(alarm, { signal: context.signal }));
    if (answer.some((one) => one.memberId === alarm.memberId && one.alarm === alarm.alarm)) {
      cleared.push(alarm);
    } else {
      left.push(alarm);
    }
  }
  if (left.length === 0) return { success: true, message: `Disarmed ${cleared.map(describeAlarm).join(", ")}.` };
  const done = cleared.length === 0 ? "none was cleared" : `cleared ${cleared.map(describeAlarm).join(", ")}`;
  return {
    success: false,
    message: `etcd did not clear ${left.map(describeAlarm).join(", ")}; ${done}. Run alarm list to see what is still raised.`,
  };
}

/**
 * Runs one of the three operations (spec 7.2), or refuses before any request: on a read-only
 * connection (spec E6), and for a type etcd does not run, which the route's declaration check already
 * answers with a 400 before this is called.
 */
export async function runEtcdMaintenance(
  client: EtcdMaintenanceClient,
  context: EtcdSurfaceContext,
  type: MaintenanceOperation,
): Promise<MaintenanceResult> {
  const started = context.now();
  const readOnly = refuseReadOnly(context);
  if (readOnly !== undefined) throw new QueryError(readOnly.message, PROVIDER);
  let verdict: Verdict;
  switch (type) {
    case "compact":
      verdict = await compact(client, context);
      break;
    case "defragment":
      verdict = await defragment(client, context);
      break;
    case "disarm":
      verdict = await disarm(client, context);
      break;
    default:
      throw new QueryError(`etcd runs compact, defragment and disarm, and not ${type}.`, PROVIDER);
  }
  return { success: verdict.success, executionTime: context.now() - started, message: verdict.message };
}
