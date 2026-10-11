# Kubernetes captures

What k3s API servers answered the Kubernetes provider, one file per persona and fixture set.
The integration test (`tests/integration/db/kubernetes-provider.test.ts`) and the end-to-end stub API server (`e2e/helpers/kubernetes-stub.ts`) replay them; no test here reaches a live server.

## Where they come from

`tests/live/kubernetes-evidence.ts --set <set> --env <dir>` runs the scenarios of `tests/live/kubernetes-evidence-plan.ts` against the throwaway cluster of `docker/kubernetes/README.md` that the set names, and writes `<set>/<persona>.json` for each persona and `<set>/manifest.json`.
It drives the real provider and records its own requests at the transport seam, so a replay answers exactly what the provider sends; a provider change that alters a request makes the replay answer a `text/plain` 404, which every replaying test reports, and the set is captured again from the same commit.
The connections come from the persona kubeconfigs that `docker/kubernetes/seed.sh` wrote, read through the browser importer.
A step whose answer does not show what the plan expects stops the run, and nothing is written.
`manifest.json` names the set, the cluster, the image, the server's `gitVersion`, the Studio commit, the harness files that differ from it (`uncommitted`, empty when the commit alone reproduces the capture), the date and each persona's step and exchange counts.

| set | cluster | personas | what it shows |
| --- | --- | --- | --- |
| `v1.35.5` | `k8s-probe` | `admin`, `reader`, `viewer`, `shop-only`, `studio-reader` | every read of the tree and every console command, the locks of `view`, a namespace-bound identity, the credential warning's six reviews |
| `v1.30.14` | `k8s-floor` | `reader` | the documented floor: aggregated discovery `v2` and one Table list |
| `v1.29.15` | `k8s-best-effort` | `reader` | best effort: aggregated discovery `v2beta1` |

Each file holds `{ persona, exchanges }`; an exchange is the request (method, path and query, the `Accept` header, the body of a POST) and the answer (status, content type, `Retry-After`, body), in the order the requests finished.
No other header is recorded, so no `Authorization` and no `Audit-Id` is in any file.

## The replay

A request is matched by its key: the method, the path, the query with its pairs sorted, and for a POST its body (`requestKey` in `tests/helpers/kubernetes-replay.ts`).
A key recorded more than once answers in recorded order and then repeats its last answer; a request nobody recorded answers `404` with `text/plain`, as an API server answers a path it does not serve.
The `Accept` must match too: a request that asks for another `Accept` than the recording did answers a `406` NotAcceptable and counts as missed, so a change in what the provider asks for is never answered from a recording of the old ask.

## The scrub

Every exchange passes `tests/helpers/kubernetes-evidence-scrub.ts` before it is written.
UIDs, credential ids and other UUIDs become `00000000-0000-4000-8000-<n>`, 32-digit hex ids a zero-padded counter, IPv4 addresses `192.0.2.<n>` and IPv6 addresses `2001:db8::<n>` (loopback stays), JWTs `<jwt>`, the personas' tokens `<token>`, and every PEM block, and every base64 string or base64 run inside a longer string that decodes to one, a block whose body reads `PLACEHOLDER`, in the request and the answer alike, so a request built from a replayed answer is the request that was recorded.
Every Secret outside the namespaces `shop` and `restricted`, a row of a Secrets Table included, loses its values, its `stringData` and its last-applied annotation, and a Node loses its `k3s.io/node-*` annotations.
The Secrets of `shop` and `restricted` keep the fake markers `docker/kubernetes/sample.yaml` plants, so the redaction tests prove on real answers that no marker leaves the provider.
Nothing is written while any file holds a token or a PEM text the run was given, a private key, a JWT or an IPv4 or IPv6 address the placeholders missed.
The captures were scanned with the pinned gitleaks image of `.github/workflows/security-scan.yml` before they were committed.

## What is built, not captured

Three answers no supported cluster gives are built in the integration test, not stored here: a server that answers discovery only in its unaggregated form (refused with the 1.30 floor's sentence), a list answered as plain JSON where a Table was asked for (what the Accept list's plain-JSON fallback yields where a 406 would otherwise be), and a group version marked `Stale` (passed over for the next one).
The OpenShift projects fallback rests on built answers as well, in `tests/unit/db/kubernetes/objects-containers.test.ts`.
