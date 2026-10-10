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
  notInV1FlagSentence,
  notInV1OutputSentence,
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

describe("everyday kubectl lines outside v1, pasted as they are", () => {
  test.each([
    ["kubectl get pods -o jsonpath='{.items[*].metadata.name}'", notInV1OutputSentence("jsonpath")],
    ["kubectl logs -f deploy/web", S.follow],
    ["kubectl get events --sort-by=.lastTimestamp", notInV1FlagSentence("--sort-by", "get")],
    ["kubectl get all -n shop", S.oneType],
    ["kubectl exec -it pod/x -- sh", notReadOnlySentence("exec")],
    ["kubectl get pods,svc -n shop", S.oneType],
    ["kubectl get pods -o custom-columns=NAME:.metadata.name", notInV1OutputSentence("custom-columns")],
    ["kubectl get pods -o go-template='{{.kind}}'", notInV1OutputSentence("go-template")],
    ["kubectl get --raw /metrics", notInV1FlagSentence("--raw", "get")],
    ["kubectl port-forward svc/web 8080:80", notReadOnlySentence("port-forward")],
    ["kubectl cp shop/web:/etc/passwd ./passwd", notReadOnlySentence("cp")],
    ["kubectl proxy --port=8001", notReadOnlySentence("proxy")],
    ["kubectl debug pod/web -it --image=busybox", notReadOnlySentence("debug")],
    ["kubectl run tmp --image=busybox -- sh", notReadOnlySentence("run")],
    ["kubectl attach pod/web -it", notReadOnlySentence("attach")],
    ["kubectl apply -f deploy.yaml", notReadOnlySentence("apply")],
    ["kubectl delete pod web --force", notReadOnlySentence("delete")],
    ["kubectl rollout restart deploy/web", notReadOnlySentence("rollout restart")],
    ["kubectl rollout status deploy/web", notInV1CommandSentence("rollout status")],
    ["kubectl config get-contexts", notInV1CommandSentence("config")],
    ["kubectl cluster-info", notInV1CommandSentence("cluster-info")],
    ["kubectl wait --for=condition=Ready pod/web", notInV1CommandSentence("wait")],
    ["kubectl get pods --context prod", connectionFlagSentence("--context")],
    ["kubectl get pods --kubeconfig /tmp/admin.conf", connectionFlagSentence("--kubeconfig")],
    ["kubectl get pods --token=eyJhbGciOi", connectionFlagSentence("--token")],
    ["kubectl get pods --as=system:admin", connectionFlagSentence("--as")],
    ["kubectl get pods -v=8", connectionFlagSentence("-v")],
    ["kubectl get pods --insecure-skip-tls-verify", connectionFlagSentence("--insecure-skip-tls-verify")],
    ["kubectl top pod --containers", notInV1FlagSentence("--containers", "top pod")],
    ["kubectl events --watch", notInV1FlagSentence("--watch", "events")],
    ["kubectl describe pods -l app=web", S.describeOne],
    ["kubectl logs deploy/web --tail=-1", S.tail],
    ["kubectl describe pod web\n# libredb:page offset=0 limit=5", PAGING_CLAUSE_SENTENCE],
    [
      `kubectl get pods ${Array.from({ length: 501 }, (_unused, index) => `p${index}`).join(" ")}`,
      tooManyNamesSentence(500),
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
