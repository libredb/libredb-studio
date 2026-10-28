import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import {
  ETCD_DESTRUCTIVE_OPERATIONS,
  etcdTypedConfirmation,
  readEtcdOperations,
} from "@/lib/db/providers/keyvalue/etcd/guard";

/** etcd's row of the confirmation gate's vocabulary. */
export const ETCD_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: ETCD_DESTRUCTIVE_OPERATIONS,
  // The provider's own parser, read by guard.ts, so what asks and what runs are one parse (#1089 5.5). Text
  // it refuses names nothing, where every other reader answers "could not tell": the provider refuses that
  // text before any request, so a prompt would ask about a command that cannot run.
  read: readEtcdOperations,
  decidesAlone: true,
  // A range delete and a lease revoke are typed; everything else that asks takes one click (#1089 5.5).
  typedConfirmation: etcdTypedConfirmation,
  // A put's value is part of the statement, so no etcd statement is posted for an AI analysis (#1089 E10).
  safetyAnalysis: false,
};
