/**
 * The refusal table, through the real provider on a recording transport: every everyday kubectl line outside v1,
 * every refused command, connection flag and flag outside a command's column answers its own sentence, the editor's
 * gate refuses it with the same sentence, and not one request is sent for it.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  CONNECTION_FLAGS,
  KUBECTL_SENTENCES as S,
  NOT_IN_V1_COMMANDS,
  NOT_READ_ONLY_COMMANDS,
  connectionFlagSentence,
  notInV1CommandSentence,
  notReadOnlySentence,
  tooManyNamesSentence,
} from "@/lib/db/providers/platform/kubernetes/console/commands";
import { kubectlRefusal } from "@/lib/db/providers/platform/kubernetes/console/guard";
import { PAGING_CLAUSE_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/paging";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { fakeCluster } from "../../../../helpers/kubernetes-cluster";
import { kubernetesConnection } from "../../../../helpers/kubernetes-connection";
import { recordingKubernetesTransport, testSeams } from "../../../../helpers/kubernetes-transport";

const transport = recordingKubernetesTransport(fakeCluster({ lists: { "/api/v1/namespaces": [{ name: "shop" }] } }));
const provider = new KubernetesProvider(
  kubernetesConnection({ database: "shop" }),
  { queryTimeout: 30_000 },
  testSeams(transport),
);

beforeAll(async () => {
  await provider.connect();
});

/** Runs a statement that must be refused: answers its sentence, and sends nothing. */
async function refused(text: string): Promise<string> {
  const before = transport.calls.length;
  const error = await provider.query(text).then(
    () => new Error(`expected ${JSON.stringify(text)} to be refused`),
    (refusal: Error) => refusal,
  );
  expect(error).toBeInstanceOf(QueryError);
  expect(transport.calls).toHaveLength(before);
  expect(kubectlRefusal(text)).toBe(error.message);
  return error.message;
}

/**
 * The command list every not-in-v1 sentence ends with, written out so a sentence that stops naming the command or
 * the list fails here, rather than being read back from the builder under test.
 */
const V1_RUNS =
  "which runs get, describe, logs, top pod, top node, events, api-resources, api-versions, explain, auth can-i, auth whoami and version. Nothing was sent.";

describe("everyday kubectl lines outside v1, pasted as they are", () => {
  test.each([
    [
      "kubectl get pods -o jsonpath='{.items[*].metadata.name}'",
      "-o jsonpath is not in v1 of this console: -o takes wide, name, json or yaml. Nothing was sent.",
    ],
    ["kubectl logs -f deploy/web", S.follow],
    [
      "kubectl get events --sort-by=.lastTimestamp",
      "The flag --sort-by of kubectl get is not in v1 of this console. Nothing was sent.",
    ],
    ["kubectl get all -n shop", S.oneType],
    [
      "kubectl exec -it pod/x -- sh",
      "kubectl exec is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    ["kubectl get pods,svc -n shop", S.oneType],
    [
      "kubectl get pods -o custom-columns=NAME:.metadata.name",
      "-o custom-columns is not in v1 of this console: -o takes wide, name, json or yaml. Nothing was sent.",
    ],
    [
      "kubectl get pods -o go-template='{{.kind}}'",
      "-o go-template is not in v1 of this console: -o takes wide, name, json or yaml. Nothing was sent.",
    ],
    ["kubectl get --raw /metrics", "The flag --raw of kubectl get is not in v1 of this console. Nothing was sent."],
    [
      "kubectl port-forward svc/web 8080:80",
      "kubectl port-forward is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    [
      "kubectl cp shop/web:/etc/passwd ./passwd",
      "kubectl cp is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    [
      "kubectl proxy --port=8001",
      "kubectl proxy is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    [
      "kubectl debug pod/web -it --image=busybox",
      "kubectl debug is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    [
      "kubectl run tmp --image=busybox -- sh",
      "kubectl run is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    [
      "kubectl attach pod/web -it",
      "kubectl attach is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    [
      "kubectl apply -f deploy.yaml",
      "kubectl apply is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    [
      "kubectl delete pod web --force",
      "kubectl delete is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    [
      "kubectl rollout restart deploy/web",
      "kubectl rollout restart is refused: it is not read-only, and this console only reads the cluster. Nothing was sent.",
    ],
    ["kubectl rollout status deploy/web", `kubectl rollout status is not in v1 of this console, ${V1_RUNS}`],
    ["kubectl config get-contexts", `kubectl config is not in v1 of this console, ${V1_RUNS}`],
    ["kubectl cluster-info", `kubectl cluster-info is not in v1 of this console, ${V1_RUNS}`],
    ["kubectl wait --for=condition=Ready pod/web", `kubectl wait is not in v1 of this console, ${V1_RUNS}`],
    [
      "kubectl get pods --context prod",
      "The flag --context is refused: the connection decides this. Nothing was sent.",
    ],
    [
      "kubectl get pods --kubeconfig /tmp/admin.conf",
      "The flag --kubeconfig is refused: the connection decides this. Nothing was sent.",
    ],
    [
      "kubectl get pods --token=eyJhbGciOi",
      "The flag --token is refused: the connection decides this. Nothing was sent.",
    ],
    ["kubectl get pods --as=system:admin", "The flag --as is refused: the connection decides this. Nothing was sent."],
    ["kubectl get pods -v=8", "The flag -v is refused: the connection decides this. Nothing was sent."],
    [
      "kubectl get pods --insecure-skip-tls-verify",
      "The flag --insecure-skip-tls-verify is refused: the connection decides this. Nothing was sent.",
    ],
    [
      "kubectl top pod --containers",
      "The flag --containers of kubectl top pod is not in v1 of this console. Nothing was sent.",
    ],
    ["kubectl events --watch", "The flag --watch of kubectl events is not in v1 of this console. Nothing was sent."],
    ["kubectl describe pods -l app=web", S.describeOne],
    ["kubectl logs deploy/web --tail=-1", S.tail],
    ["kubectl describe pod web\n# libredb:page offset=0 limit=5", PAGING_CLAUSE_SENTENCE],
    [
      `kubectl get pods ${Array.from({ length: 501 }, (_unused, index) => `p${index}`).join(" ")}`,
      tooManyNamesSentence(500),
    ],
    [
      `kubectl get pods -L ${Array.from({ length: 17 }, (_unused, index) => `k${index}`).join(",")}`,
      S.labelColumnsCount,
    ],
    ["kubectl get pods | grep web", undefined],
    ["kubectl get pods; kubectl get svc", undefined],
  ])("%j", async (text, sentence) => {
    const message = await refused(text);
    if (sentence !== undefined) expect(message).toBe(sentence);
  });
});

/** Every command of v1, each followed by every connection flag. */
const V1_STATEMENTS = [
  "get pods",
  "describe pod web",
  "logs web",
  "top pod",
  "top node",
  "events",
  "api-resources",
  "api-versions",
  "explain pods",
  "auth can-i get pods",
  "auth whoami",
  "version",
];

describe("every refused command and connection flag", () => {
  test.each([...NOT_READ_ONLY_COMMANDS])("kubectl %s answers not read-only", async (command) => {
    expect(await refused(`kubectl ${command} x`)).toBe(notReadOnlySentence(command));
  });

  test.each([...NOT_IN_V1_COMMANDS])("kubectl %s answers not in v1", async (command) => {
    expect(await refused(`kubectl ${command}`)).toBe(notInV1CommandSentence(command));
  });

  test.each(V1_STATEMENTS.flatMap((statement) => [...CONNECTION_FLAGS].map((flag) => [statement, flag] as const)))(
    "kubectl %s %s answers that the connection decides it",
    async (statement, flag) => {
      expect(await refused(`kubectl ${statement} ${flag}=secret-value`)).toBe(connectionFlagSentence(flag));
    },
  );
});
