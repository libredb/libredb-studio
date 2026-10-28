import type { DestructiveVocabulary, OperationReader } from "@/lib/db/destructive-vocabulary";
import { KUBECTL_MAX_TEXT_BYTES } from "@/lib/db/providers/platform/kubernetes/console/commands";
import { kubectlRefusal } from "@/lib/db/providers/platform/kubernetes/console/guard";

/**
 * kubectl operations that destroy or change anything and reach the server: none, so the set is empty.
 *
 * Not an omission. A mutating kubectl command is refused before any request, and the Kubernetes provider's request
 * policy admits GET and the three self reviews only, so a confirmation would ask about a statement that cannot run.
 */
const KUBERNETES_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/**
 * What a kubectl statement would run: never an operation this gate asks about.
 *
 * The provider either runs the statement as reads or refuses it before anything is sent, so a mutating command, and
 * text it cannot lex, changes nothing and asks nothing.
 */
const readKubernetesOperations: OperationReader = () => [];

/**
 * Kubernetes's row of the confirmation gate's vocabulary.
 *
 * The provider refuses every mutating command before any request, so nothing asks. A statement names namespaces and
 * objects, so none is posted for an AI analysis. What the console's parser refuses (a write, exec or a tunnel, a
 * connection flag, a flag outside v1) the editor refuses before anything is sent, past the dialect's own byte bound.
 */
export const KUBERNETES_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: KUBERNETES_DESTRUCTIVE_OPERATIONS,
  read: readKubernetesOperations,
  decidesAlone: true,
  safetyAnalysis: false,
  refuse: kubectlRefusal,
  maxTextBytes: KUBECTL_MAX_TEXT_BYTES,
};
