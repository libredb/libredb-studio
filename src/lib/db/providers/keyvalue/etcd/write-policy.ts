/**
 * The provider's server-side decisions of E6 and E8 (spec 3.1, 3.6, R13 A6), from the classification
 * guard.ts made of the parsed command and the facts execute.ts read first.
 *
 * Pure, and server-side only: no browser code imports it, so the rules the provider enforces are not
 * rules a page can change. Each function answers the refusal, with the sentence the user reads, or
 * undefined when the command may go on to its next check. None throws, so the value edit can return
 * a refusal as its `refused` outcome, which the edit-apply route never turns into an unknown outcome
 * (spec 5.6, E6). No sentence carries a value's bytes (spec E9); a key is named in the quoting a
 * person types it in.
 */
import type { EtcdBytes } from "./client";
import type { CommandAssessment } from "./guard";
import { protectedHit, typedKey } from "./keys";
import { isKubernetesEncrypted, isKubernetesEnvelope, withheldLabel } from "./values";

/**
 * Where a connection's read-only mode was set (spec E6): a seed, a connection of the user's own, or an
 * execution profile.
 */
export type ReadOnlySource = "seed" | "connection" | "execution-profile";

export type PolicyRefusalReason =
  | "read-only"
  | "protected-prefix"
  | "protected-key"
  | "kubernetes-value"
  | "unreadable-target"
  | "lease-protected"
  | "lease-unreadable";

export interface PolicyRefusal {
  readonly reason: PolicyRefusalReason;
  readonly message: string;
}

const READ_ONLY_SENTENCES: Readonly<Record<ReadOnlySource, string>> = {
  seed: "This connection is read-only (set in the operator's seed file).",
  connection: "This connection is read-only: turn off Read-only in its settings to write.",
  "execution-profile": "This run opens the connection read-only (agent execution profile).",
};

/** E6's three sentences: a seed, a connection of the user's own, and an execution profile. */
export function readOnlySentence(source: ReadOnlySource): string {
  return READ_ONLY_SENTENCES[source];
}

/** E6 for a value edit and a maintenance operation, and the first check of every write command. */
export function refuseReadOnly(context: { readonly readOnly?: ReadOnlySource }): PolicyRefusal | undefined {
  return context.readOnly === undefined
    ? undefined
    : { reason: "read-only", message: readOnlySentence(context.readOnly) };
}

/**
 * E8's sentence (spec 3.6): a protected prefix is named with the Kubernetes API as the way to write,
 * and `compact_rev_key` with kube-apiserver as its owner; a lease's refusal says revoking deletes it.
 */
function protectedRefusal(
  hit: { readonly kind: "prefix" | "key"; readonly name: string },
  lease: boolean,
): PolicyRefusal {
  const deletes = lease ? ", and revoking the lease deletes it" : "";
  if (hit.kind === "key") {
    return {
      reason: lease ? "lease-protected" : "protected-key",
      message: `${lease ? "This lease holds" : "This write reaches"} ${hit.name}, the key kube-apiserver keeps its compaction clock in${deletes}, so Studio refuses it: kube-apiserver owns that key.`,
    };
  }
  return {
    reason: lease ? "lease-protected" : "protected-prefix",
    message: `${lease ? "This lease holds a key under" : "This write reaches"} the Kubernetes key prefix ${hit.name}${deletes}, so Studio refuses it: Kubernetes objects are written through the Kubernetes API, never straight into etcd.`,
  };
}

/**
 * E6, then E8's prefix and key half, before any request (spec 3.6): a read passes; any write is
 * refused in read-only mode; a write whose key, range or prefix meets the protected set is refused,
 * naming the prefix or the key. A lease's keys are E8's other half, `refuseLeaseRevoke`.
 */
export function refuseBeforeSend(
  assessment: CommandAssessment,
  context: { readonly readOnly?: ReadOnlySource },
): PolicyRefusal | undefined {
  if (assessment.class === "read") return undefined;
  const readOnly = refuseReadOnly(context);
  if (readOnly !== undefined) return readOnly;
  for (const range of assessment.writeRanges) {
    const hit = protectedHit(range);
    if (hit !== undefined) return protectedRefusal(hit, false);
  }
  return undefined;
}

/**
 * E8's content rule over the stored values execute.ts read first, one entry per single-key write
 * target: undefined is an absent key, which passes, and "unreadable" a refused read, which is refused,
 * because etcd grants WRITE without READ (SRC etcd__api_authpb_auth.proto, Permission.Type, whose WRITE
 * stands apart from READWRITE). A value that begins with `k8s\x00` or `k8s:enc:` refuses the whole
 * command, naming the key and E9's label.
 */
export function refuseStoredValues(
  targets: ReadonlyArray<{ readonly key: EtcdBytes; readonly stored: EtcdBytes | undefined | "unreadable" }>,
): PolicyRefusal | undefined {
  for (const { key, stored } of targets) {
    const named = typedKey(key, "command-line");
    if (stored === "unreadable") {
      return {
        reason: "unreadable-target",
        message: `Studio could not read ${named} before writing it, so it cannot tell whether the key holds a Kubernetes object, and it refuses the write: a write needs READ on each key it names as well as WRITE.`,
      };
    }
    if (stored !== undefined && (isKubernetesEnvelope(stored) || isKubernetesEncrypted(stored))) {
      return {
        reason: "kubernetes-value",
        message: `${named} holds a Kubernetes value (${withheldLabel(key, stored) as string}), so Studio refuses the write: Kubernetes objects are written through the Kubernetes API, never straight into etcd.`,
      };
    }
  }
  return undefined;
}

/**
 * E8's lease half: the keys `LeaseTimeToLive keys: true` answered, or "unreadable". Revoking a lease
 * deletes its keys, and Kubernetes attaches its event keys to leases, so a lease holding a protected
 * key, or one whose keys cannot be read, is refused (spec E8).
 */
export function refuseLeaseRevoke(keys: readonly EtcdBytes[] | "unreadable"): PolicyRefusal | undefined {
  if (keys === "unreadable") {
    return {
      reason: "lease-unreadable",
      message:
        "Studio could not read the keys this lease holds, so it refuses to revoke it: revoking a lease deletes every key it holds, and Kubernetes attaches its keys to leases.",
    };
  }
  for (const key of keys) {
    const hit = protectedHit({ key });
    if (hit !== undefined) return protectedRefusal(hit, true);
  }
  return undefined;
}
