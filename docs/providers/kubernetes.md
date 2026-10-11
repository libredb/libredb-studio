# Kubernetes Provider

The `kubernetes` type-id: a read-only browser and kubectl-subset console for one Kubernetes cluster, over the API server's REST API.
Source: [`src/lib/db/providers/platform/kubernetes/`](../../src/lib/db/providers/platform/kubernetes/), and the browser-side kubeconfig import in [`src/lib/kubernetes/kubeconfig-import.ts`](../../src/lib/kubernetes/kubeconfig-import.ts).
Tests: [`tests/unit/db/kubernetes/`](../../tests/unit/db/kubernetes/), [`tests/integration/db/kubernetes-provider.test.ts`](../../tests/integration/db/kubernetes-provider.test.ts) and [`e2e/kubernetes-provider.spec.ts`](../../e2e/kubernetes-provider.spec.ts).

## 1. Overview

Studio reads one Kubernetes cluster: a tree of the `Cluster` pseudo-container and the namespaces, a YAML view of every built-in object, Describe and Logs on a row, and a console that speaks a subset of kubectl.
It is read-only in this version, whatever the connection's read-only box says: no request it can send writes, runs a program or opens a stream, and no Secret value reaches any surface.
It needs no driver and no Kubernetes library: requests go over Studio's shared `node:https` transport, and the kubeconfig import reads YAML in the browser with the `yaml` package Studio already ships.

### Concept mapping

| Kubernetes | Studio |
| --- | --- |
| One cluster, one kubeconfig context | One connection |
| Cluster-scoped kinds (nodes, namespaces, cluster roles) | The `Cluster` container |
| A namespace | A container, one level deep |
| A kind (`deployments`) | A folder, grouped as Workloads, Config, Network, Storage and Access Control |
| An object (`deployment/web`) | A row named `web`, whose path carries its kind, opened as YAML |
| A custom resource type | A row of the Custom Resources folder, whose List action runs `kubectl get` |
| `kubectl get`, `describe`, `logs` and the rest | One statement per run in the editor |

## 2. Architecture

`KubernetesProvider` extends `BaseDatabaseProvider` in the new `platform` family and composes one module per purpose.
The clock, the sleep, the randomness and the transport factory are one injected seams object, so every module is tested without a socket.

| File | What it owns |
| --- | --- |
| `index.ts` | The composition: capabilities, labels, the session's lifecycle |
| `connection-options.ts` | The connection's fields validated into one endpoint, and every refusal of section 4.2 |
| `request-policy.ts` | The request allowlist, checked on the final strings before any socket |
| `client.ts` | The client on the shared node transport: headers, byte and time caps, `Retry-After` |
| `discovery.ts`, `resolve.ts` | Aggregated discovery, its admission and cache, and kubectl's name resolution |
| `kinds.ts`, `objects.ts`, `source.ts` | The kind table, the tree surface and the YAML view |
| `table.ts`, `redaction.ts` | Table answers to grids with the paged walk, and the one place Secret data is removed |
| `errors.ts`, `labels.ts`, `monitoring.ts`, `connect-warnings.ts`, `limits.ts` | Studio's error sentences, the labels, health, Test Connection's warnings, every cap |
| `console/` | The kubectl subset: lexer, command table, parser, one reader per command family, paging |

## 3. Design decisions

- Read-only by construction: the allowlist admits `GET` on discovery, collections and objects whose verbs discovery lists, `GET` on pod logs, and `POST` to the three self-review endpoints only, with a body Studio builds.
- Static credentials only: a bearer token, or a client certificate and key, with the cluster's CA and an optional TLS server name; no credential plugin runs and no cloud token is minted.
- Secret values are never shown: a Secret's name, type, key count and age only.
- Errors are sentences Studio composes from the request and the answer's code and reason, never the server's own message, which names the identity and can echo a value.

## 4. Connection

### 4.1 Fields

| Field | Label | Rule |
| --- | --- | --- |
| `host` | API server | A host name or address; a pasted `https://` address fills Host and Port, and a path in it is refused, because a path such as Rancher's goes under API path |
| `port` | Port | 6443 by default |
| `password` | Token | A bearer token, without the word `Bearer`; empty for a client certificate or `kubectl proxy` |
| `database` | Default namespace | A DNS-1123 label; empty means `default`, as kubectl reads a context with no namespace |
| `namespaces` | Namespaces | Optional DNS-1123 labels separated by commas or spaces; when set, the tree lists them and reads no namespace list |
| `apiPath` | API path | Optional path every request goes under, such as `/k8s/clusters/c-m-abc12` |
| `tlsServerName` | TLS server name | Optional name the server's certificate is checked against, a kubeconfig's `tls-server-name` |

There is no User field: basic authentication is refused, and a user name from a seed or the API is refused naming the field.
The SSL / TLS panel carries the CA and a client certificate and key; the SSH tunnel is offered.

### 4.2 What is refused at connect

The same rules run in the dialog and again at connect, because a seed or an API call never passes the dialog:
- SSL mode `disable` to a host that is not this machine, and to this machine unless the operator sets `KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT=true`;
- SSL mode `require`, or a certificate check turned off, unless the operator sets `KUBERNETES_ALLOW_INSECURE_TLS=true`;
- a token holding anything outside visible ASCII, or starting with `Bearer `;
- a user name; an API path or TLS server name that fails its rule; a Default namespace or a Namespaces entry that is not a DNS-1123 label, or a Default namespace outside a set Namespaces list;
- an SSH tunnel whose far end is a link-local or instance metadata address.

Studio has no default credential chain, no kubeconfig loader on the server and no in-cluster identity: a connection is its fields and nothing else.

Plain HTTP to this machine is refused with this sentence when the flag is off:

> Plain HTTP to this machine (kubectl proxy) is off on this server: the operator turns it on with KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT=true, which the npx and desktop launchers set when Studio listens on this machine only. Nothing was sent.

An unchecked certificate is refused with this one:

> SSL mode require, or a certificate check turned off, would send the token to a server whose certificate is not checked, which this server refuses unless the operator sets KUBERNETES_ALLOW_INSECURE_TLS=true. Choose verify-full with the cluster's CA, or verify-system. Nothing was sent.

### 4.3 Test Connection's warnings

Test Connection answers Studio's fixed success sentence, and shows these warnings beside it:
- The credential warning: six self access reviews ask whether the identity may create or get `pods/exec` in the default namespace, get `nodes/proxy`, do anything to every resource, and list Secrets in the default namespace and in the whole cluster; each right it holds is named, with the advice that a token bound to `view` or `studio-reader` is safer.
- The namespace notice, when the identity may not list namespaces and the Namespaces field is empty: the tree then shows the Default namespace alone.
- The cap notice, when the cluster lists more than 1,000 namespaces:

> This cluster lists more than 1,000 namespaces, so the tree shows the first 1,000; list the ones to show in the connection's Namespaces field.

The API lists namespaces in name order, so when the Default namespace sorts past the first 1,000 and the list or one read of it shows it exists, it takes the place of the 1,000th, and the tree and plan mode's walk still read it.
When the list answers, a Default namespace the API does not show is not drawn, past the cap or below it.

`kubectl auth whoami` in the console shows who the connection is.

### 4.4 Import a kubeconfig

For a new connection the dialog offers Import kubeconfig.
The paste is read in the browser, at most 1 MiB and 100 levels of nesting, and is never sent to the server, logged or stored; the text is dropped once the form is filled.
The parser is strict on purpose: a duplicate key, a YAML alias, a merge key, a `%YAML` or `%TAG` directive, or a tag outside the standard `!!` tags fails the import, with the parser's code and position and never its message, which could quote a token.

Each context offers its cluster's server, split into Host, Port and API path, its CA, its TLS server name, the user's token or client certificate and key, and the context's namespace.
The server is split as written and never normalized: one that holds a backslash, whitespace or a control character, or whose path holds `%`, `//`, or a `.` or `..` segment, is refused rather than rewritten.
An `http://` server maps to SSL mode `disable`, and `insecure-skip-tls-verify: true` to SSL mode `require`, each with a notice of the flag the operator must set.
These settings are named in the import's notice and never imported: `exec`, `auth-provider`, every file path (`certificate-authority`, `client-certificate`, `client-key`, `tokenFile`, `token-file`), `proxy-url`, `username`, `password`, `as`, `as-uid`, `as-groups` and `as-user-extra`; `disable-compression` and `extensions` are ignored.
Studio reads no local file, runs no program and impersonates no one, so none of them can mean what the file says.

A context whose user signs in through a credential plugin, as every EKS, GKE and AKS kubeconfig does, is imported without a credential:

> This context's user signs in through a credential plugin (exec or auth-provider), which Studio does not run, so the Token is empty. Create a ServiceAccount token bound to the view or studio-reader ClusterRole and paste it under Token, as docs/providers/kubernetes.md shows; on your own machine, kubectl proxy is another way in.

### 4.5 A ServiceAccount token: view and studio-reader

Bind a ServiceAccount to the built-in `view` ClusterRole for a token that reads the namespaced workloads and Namespaces, never Secrets:

```bash
kubectl create namespace libredb-studio
kubectl -n libredb-studio create serviceaccount studio-reader
kubectl create clusterrolebinding studio-reader-view --clusterrole=view --serviceaccount=libredb-studio:studio-reader
kubectl -n libredb-studio create token studio-reader --duration=720h
```

Measured on k3s v1.35.5 with a token bound to plain `view`, the tree locks Secrets, Leases, Roles and Role Bindings in a namespace.
Under Cluster it locks every kind but Namespaces: Nodes, Persistent Volumes, Storage Classes, Custom Resource Definitions, Priority Classes, Runtime Classes, Ingress Classes, both webhook configuration kinds, Cluster Roles and Cluster Role Bindings.
The `studio-reader` ClusterRole adds `get` and `list` on Nodes, Persistent Volumes, Custom Resource Definitions and Storage Classes, and never Secrets; apply it as it stands in [`docker/kubernetes/studio-reader.yaml`](../../docker/kubernetes/studio-reader.yaml):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: libredb-studio
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: studio-reader
  namespace: libredb-studio
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: studio-reader
rules:
  - apiGroups: [""]
    resources: [nodes, persistentvolumes]
    verbs: [get, list]
  - apiGroups: [apiextensions.k8s.io]
    resources: [customresourcedefinitions]
    verbs: [get, list]
  - apiGroups: [storage.k8s.io]
    resources: [storageclasses]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: studio-reader-view
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
  - kind: ServiceAccount
    name: studio-reader
    namespace: libredb-studio
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: studio-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: studio-reader
subjects:
  - kind: ServiceAccount
    name: studio-reader
    namespace: libredb-studio
```

A role with `resources: ["*"]` and `get` is not read-only: it also grants `get` on `nodes/proxy`, which reaches every node's kubelet.
Test Connection names that right when the token holds it.

Token lifetimes: `kubectl create token` without `--duration` gives the server's default, one hour on most clusters, and the server may cap what `--duration` asks for.
For a token that does not expire, create its Secret and read it back:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: studio-reader-token
  namespace: libredb-studio
  annotations:
    kubernetes.io/service-account.name: studio-reader
type: kubernetes.io/service-account-token
```

```bash
kubectl -n libredb-studio get secret studio-reader-token -o jsonpath='{.data.token}' | base64 -d
```

A token from this Secret stays valid until the Secret is deleted, and Studio keeps it with the connection, in the browser's storage and, with `STORAGE_PROVIDER` set to `sqlite` or `postgres`, in the server's store.
Prefer `kubectl create token` with a `--duration` you renew, and delete the Secret to revoke a token made this way.

An expired or revoked token is one request and this sentence, never a retry:

> The API server rejected the token or certificate (401 Unauthorized); a ServiceAccount token may have expired. Create a new token and paste it in the connection's Token field.

### 4.6 Rancher

A cluster behind Rancher is reached at `https://<rancher>/k8s/clusters/<cluster id>`.
Put the host under API server, 443 under Port and `/k8s/clusters/<cluster id>` under API path; a pasted kubeconfig from Rancher is split that way by the import.
An API path may not hold a segment named `api`, `apis`, `proxy`, `namespaces`, `nodes`, `services`, `pods`, `openapi` or `version`, so a prefix can never route a request through a proxy subresource.

### 4.7 Studio in Docker

kind and k3d kubeconfigs name `127.0.0.1`, which inside a Studio container is the container itself.
Join the cluster's Docker network (`docker run --network k3d-<cluster> ...`, or `kind` for kind) and use the control-plane container's name on 6443, which its certificate names (`kind get kubeconfig --internal` prints it), or run Studio with host networking.

### 4.8 kubectl proxy on your own machine

On an npx, desktop or package install that listens on this machine only, `kubectl proxy` serves the API on `http://127.0.0.1:8001` with your own kubectl credentials, and a connection to it takes SSL mode `disable` and no token.
The npx and desktop launchers set `KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT=true` when Studio listens on loopback; the deb and rpm wrapper, the Homebrew formula and the Windows launcher do not set it yet, so on those installs set it yourself.
`kubectl proxy` exposes your kubectl user's full rights to every process on this machine.
A shared Studio server never sets the flag, so the route stays closed there.

### 4.9 Managed clusters

EKS, GKE and AKS kubeconfigs sign in through a credential plugin, which Studio does not run.
Create a ServiceAccount token as in section 4.5 and connect with it; Studio mints no cloud token in this version.

### 4.10 SSH tunnel

The SSH tunnel dials the API server from the SSH host; the TLS identity is the far end, or the TLS server name when set.
A far end given as a link-local or metadata literal is refused; a far end given as a name is resolved by the SSH server, which Studio cannot check.

## 5. Query interface

One kubectl command per run, the selected line: an optional leading `kubectl`, a leading `$ ` or `% ` prompt, POSIX shell quoting and `#` comment lines, with every short and long form of a flag kubectl takes (`-n shop`, `-n=shop`, `-nshop`, `--namespace shop`, `--namespace=shop`).
Without `-n`, a namespaced command uses the Default namespace, else `default`.
Every statement answers one grid.

| Command | Arguments | Flags |
| --- | --- | --- |
| `kubectl get` | TYPE [NAME ...] \| TYPE/NAME ... | `-n\|--namespace`, `-A\|--all-namespaces`, `-l\|--selector`, `--field-selector`, `-o\|--output`, `--show-labels`, `-L\|--label-columns`, `--ignore-not-found`, `--request-timeout`, `-w\|--watch` |
| `kubectl describe` | TYPE NAME \| TYPE/NAME | `-n\|--namespace` |
| `kubectl logs` | POD \| TYPE/NAME | `-n\|--namespace`, `-c\|--container`, `--all-containers`, `--all-pods`, `-p\|--previous`, `--tail`, `--since`, `--since-time`, `--timestamps`, `--limit-bytes`, `-l\|--selector` |
| `kubectl top pod` | none | `-n\|--namespace`, `-A\|--all-namespaces`, `-l\|--selector`, `--sort-by` |
| `kubectl top node` | none | `-n\|--namespace`, `-A\|--all-namespaces`, `-l\|--selector`, `--sort-by` |
| `kubectl events` | none | `-n\|--namespace`, `-A\|--all-namespaces`, `--for`, `--types` |
| `kubectl api-resources` | none | `--namespaced`, `--api-group`, `--verbs`, `-o\|--output` |
| `kubectl api-versions` | none | none |
| `kubectl explain` | TYPE[.FIELD ...] | `--recursive`, `--api-version` |
| `kubectl auth can-i` | VERB TYPE[/NAME] | `-n\|--namespace`, `-A\|--all-namespaces`, `--subresource`, `--list` |
| `kubectl auth whoami` | none | none |
| `kubectl version` | none | none |

What each answers:
- `get` shows the server's own Table columns, so a custom resource shows its printer columns; `-o wide` adds the wide ones, `-o name` one column, and `-o json` or `-o yaml` one row per object with its document.
- `get -w` lists, then watches for a bounded window (10 s, or `--request-timeout`), with an EVENT column for the window's changes; it is not live, and running it again reads again.
- `describe` answers section, field and value rows: the summary, one row per condition, one row per event.
- `logs` reads the pod kubectl would choose for `TYPE/NAME`, and the default container its annotation names, else the first; without `--tail` it reads the last 500 lines and says that kubectl's default is every line.
- `events` sorts by time as `kubectl events` does and shows the newest 1,000.
- `events --types` with a single value also sends it to the server as a `type=` field selector, so the server narrows the events the 5,000 read limit counts; with both values no type selector is sent.
- `explain` reads the server's OpenAPI v3 documents, cached per immutable URL.

Refused, each with a sentence and nothing sent:
- A flag outside its command's column, as "not in v1", naming the flag.
- The connection's flags, with "the connection decides this": `--kubeconfig`, `--context`, `--cluster`, `--user`, `--token`, `--server`, `-s`, `--as`, `--as-group`, `--as-uid`, `--as-user-extra`, `--username`, `--password`, `--certificate-authority`, `--client-certificate`, `--client-key`, `--insecure-skip-tls-verify`, `--tls-server-name`, `--cache-dir`, `--kuberc`, `-v` and `--v`.
- Every command that writes, runs code or opens a tunnel, as not read-only: `create`, `expose`, `run`, `set`, `edit`, `delete`, `scale`, `autoscale`, `certificate`, `cordon`, `uncordon`, `drain`, `taint`, `apply`, `patch`, `replace`, `label`, `annotate`, `debug`, `exec`, `attach`, `cp`, `port-forward` and `proxy`; `rollout` other than `status` and `history`.
- Read-only commands outside v1, as not in v1: `config`, `cluster-info`, `wait`, `diff`, `completion`, `options`, `plugin`, `kustomize`, `alpha`, `help`, `rollout status`, `rollout history` and `get --raw`.
- `-o jsonpath`, `-o jsonpath-file`, `-o custom-columns`, `-o go-template` and `--sort-by` on `get`; a multi-type `get` (`TYPE,TYPE`) and `get all`.
- `logs -f`:

> follow is not available in v1; remove -f to read the latest lines, and run again to refresh.

The grid pages the list form of a single-type `get` with a paging line of Studio's own, `# libredb:page offset=<n> limit=<n>`, never a kubectl flag; every other statement answers one page.
A statement reads at most 5,000 rows; a page at or past that answers a sentence to narrow the list with `-l` or `--field-selector`.

Query history masks the values of `--token`, `--password`, `--client-key`, `--client-certificate`, `--from-literal` and `--docker-password` in every spelling, though the console refuses every line that carries them; a tab keeps what was typed, a saved query keeps what was saved, and the embedded workspace writes no history.

## 6. Schema: the tree

One container level: `Cluster` first, then the namespaces, each with the kinds it holds; the Default namespace is the session's.
The namespace list is the Namespaces field when set; otherwise the API's list; on a refusal, OpenShift's projects where the server serves them; otherwise the Default namespace alone, with the notice of section 4.3.
`Cluster` cannot be a namespace, because a namespace name holds no upper-case letter.

| Group | Under a namespace | Under `Cluster` |
| --- | --- | --- |
| Workloads | Pods, Deployments, Replica Sets, Stateful Sets, Daemon Sets, Jobs, Cron Jobs, Replication Controllers | |
| Config | Config Maps, Secrets, Resource Quotas, Limit Ranges, Horizontal Pod Autoscalers, Pod Disruption Budgets, Leases | Priority Classes, Runtime Classes, Mutating and Validating Webhook Configurations |
| Network | Services, Endpoints, Endpoint Slices, Ingresses, Network Policies | Ingress Classes |
| Storage | Persistent Volume Claims | Persistent Volumes, Storage Classes |
| Access Control | Service Accounts, Roles, Role Bindings | Cluster Roles, Cluster Role Bindings |
| none | Events, Custom Resources | Nodes, Namespaces, Custom Resource Definitions, Custom Resources |

A group with one kind in a container is not drawn, and its kind sits under the container.
An object's row shows its name, and its path carries its kind, `deployment/web`, so two kinds' objects never collide; clicking it opens its YAML, with `managedFields` removed and a Secret's values gone.
Describe is on every built-in object's row menu, Logs on a pod's, and List on a custom resource type's; each opens a new tab and runs.
A kind the identity may not list keeps its folder, locked with Studio's sentence; a kind the server does not serve says so.
A folder lists the first 1,000 objects; past that its count is "1,000 or more", counted from the first 1,000 objects the tree lists; the console reads the rest.

## 7. Monitoring & health

Health reads `/readyz` and `/version`; the overview counts nodes and namespaces from the same capped walk as the tree.
Kubernetes keeps no query log, lists no client sessions and has no tables, so those panels say so.

## 8. Maintenance

No maintenance is offered.

### Object edit (#789)

No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: this version reads a cluster and never writes to it, so the YAML view offers no edit.

## 9. Capabilities, AI and MCP

- `enforcesReadOnly`; the read-only box changes nothing, because nothing writes.
- Plan mode sees the namespaces it walked, the kinds, their counts and object names; it walks the Default namespace and `Cluster` only and is told how many other namespaces it did not read.
- Secret names are withheld from plan mode: the Secrets kind appears with its count.
- Namespace names listed by the `Cluster` walk are withheld the same way: the Namespaces kind appears with its count, so no name of a namespace plan mode did not read reaches the model.
- No value, label, annotation, env value, ConfigMap key or Secret key reaches the model, and the AI panels receive no Kubernetes name.
- MCP is not offered for Kubernetes, and agent execution refuses its investigation and data-analysis workflows before a run opens (B105).
- The operations workflow opens on Kubernetes in both modes, as on every engine, because it sends no statement; its reports of sessions, slow queries, health, storage, table statistics and index usage come back empty or N/A here.

## 10. Error handling

| Answer | What Studio says |
| --- | --- |
| 401 | The expiry sentence of section 4.5, after exactly one request |
| 403 | Studio's sentence naming the verb, the kind and the namespace; a lock in the tree |
| 404 for a type | Discovery is read again once, then kubectl's "the server doesn't have a resource type" |
| 404 for an object | Not found, with no discovery refresh |
| 410 in a paged list | The walk restarts once from the beginning, then a sentence |
| 429 | One wait of at most 5 s from `Retry-After` (1 s when absent), within the time the request has left, then a sentence |
| 400, 422, 5xx | Studio's sentence with the answer's reason |

A server older than the floor is refused at connect:

> This API server does not serve authentication.k8s.io/v1 SelfSubjectReview, which Kubernetes serves from 1.28, so it runs 1.27 or earlier; Studio supports Kubernetes 1.30 and later, and 1.28 and 1.29 on a best-effort basis.

A server that answers discovery only in its unaggregated form is refused too:

> This API server did not answer aggregated discovery, which Kubernetes serves from 1.30 (1.28 and 1.29 as a beta); Studio supports Kubernetes 1.30 and later.

## 11. The read-only guarantee

Every request passes the allowlist before a socket opens, on the final path after the API path:
- `GET` on `/api`, `/apis`, `/version`, `/readyz`, `/openapi/v3` and one OpenAPI group document with its `hash`;
- `GET` on a collection only where discovery lists `list`, on an object only with `get`, a watch only with `watch`, and pod logs;
- `POST` only to `selfsubjectreviews`, `selfsubjectaccessreviews` and `selfsubjectrulesreviews`, with a JSON body Studio builds.

Every other method and subresource, `exec`, `attach`, `portforward`, `proxy`, `serviceaccounts/token`, `eviction` and `binding` among them, is refused by name.
Names are checked before a URL is built and nothing is percent-encoded into a path; the query is built from a fixed key set, so a `continue` token or a selector can never add a key.
Studio sets `Authorization`, `Accept` and `User-Agent` itself, never an impersonation header or user text; redirects are not followed, a `101` answer is refused, and link-local and metadata addresses are never dialled.

Aggregated API groups, such as `metrics.k8s.io`, are proxied by the API server to a backend service, which Studio's egress checks never see; Studio reads them with `GET` like any group and relies on GET semantics and the identity's RBAC.

Secrets: every answer to a request for core `secrets`, and every object whose kind is `Secret`, loses `data`, `stringData`, the `kubectl.kubernetes.io/last-applied-configuration` annotation and `managedFields` before anything leaves the provider, whichever command or view asked.
A deploy tool may keep its own copy of the applied Secret in an annotation, so any other annotation of a Secret whose value is not short plain text, or that names a `data` or `stringData` key, is replaced by a marker; its key stays.

## 12. Limits and supported versions

| Limit | Value |
| --- | --- |
| Objects per list request | 500 |
| Rows one statement reads | 5,000 |
| Objects the tree lists per kind and container | 1,000 |
| Bytes per response | 16 MiB |
| Nesting of an answer's objects and arrays | 1,000 levels |
| Bytes per `-o json` or `-o yaml` document | 1 MiB |
| Objects per `-o json` or `-o yaml` statement | 500 |
| Log lines without `--tail` | 500 |
| Log lines `--tail` may ask for | 5,000 |
| Log lines per pod under `-l` without `--tail` | 10 |
| Bytes per log stream | 1 MiB |
| Log streams per statement | 5 |
| Watch window without `--request-timeout` | 10 s |
| Bytes per watch window | 8 MiB |
| Events `events` reads | 5,000 |
| Events `events` shows | 1,000 |
| Bytes per `explain` document | 4 MiB |
| Discovery kept per connection | 10 minutes |
| Longest wait on a 429 | 5 s |
| Bytes of a pasted kubeconfig | 1 MiB |
| Nesting of a pasted kubeconfig | 100 levels |

A value above a limit is refused with a sentence naming the limit, never clamped.
Kubernetes 1.30 and later is supported; 1.28 and 1.29 are read on a best-effort basis; 1.27 and earlier are refused.

## 13. Testing and measurements

The unit tests drive every module on a recording transport; the integration test replays what three k3s servers answered, captured by [`tests/live/kubernetes-evidence.ts`](../../tests/live/kubernetes-evidence.ts) from the clusters of [`docker/kubernetes/`](../../docker/kubernetes/) and described in [`tests/fixtures/kubernetes/README.md`](../../tests/fixtures/kubernetes/README.md).
Measured on k3s 1.35.5 and 1.30.14, discovery answers the aggregated `v2` form; on 1.29.15 it answers `v2beta1`, which Studio reads the same way.
Measured on k3s 1.29.15, 1.30.14 and 1.35.5, the log endpoint refuses an Accept of `text/plain` with a 406 NotAcceptable and answers the log as `text/plain` to the JSON Accept, so Studio asks for a log with the JSON Accept.
Not measured: an etcd-backed managed cluster, Rancher's proxy, OpenShift (its projects fallback rests on built answers), and EKS on 443.

## 14. Known limitations

- Watch and logs are bounded snapshots, never a live stream (D277).
- One type per `get`; `get all` and `TYPE,TYPE` are refused (D278).
- Custom resource types are rows of one folder, not folders of their own (D279).
- A managed cluster needs a pasted ServiceAccount token: Studio mints no EKS, GKE, AKS or OIDC token (D280).
- A Secret's values cannot be revealed (D281).
- One common view for every kind: no kind-specific panels, no permission hints on expand, no namespace filter, and Test Connection's fixed sentence (U111).
- No `-o jsonpath`, `-o custom-columns` or `--sort-by`, and no completion in the editor (U112).
- No Helm releases (D282), no credential plugins in any mode (D283), no host allowlist for egress (D284), and no per-kind statistics (D285).
- The deb and rpm wrapper, the Homebrew formula and the Windows launcher do not set the loopback flag for `kubectl proxy` (D286).
- `get -w` takes no `-o name`, `-o json` or `-o yaml` (D288), and `auth can-i --list` shows the server's rules without kubectl's compaction (D289).
- Test Connection records no `Audit-Id` from the API server (D287).
- One ServiceAccount token per connection makes every Studio user one identity in the cluster's audit log.
- Namespace names reach plan mode as container names; on a multi-tenant cluster they may name customers (B106).
- No agent execution and no MCP (B105).

## 15. References

- The Kubernetes API concepts and the [aggregated discovery](https://kubernetes.io/docs/concepts/overview/kubernetes-api/#aggregated-discovery) and [Table](https://kubernetes.io/docs/reference/using-api/api-concepts/#receiving-resources-as-tables) pages.
- [Service account tokens](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/) and [RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/).
- [`docker/kubernetes/README.md`](../../docker/kubernetes/README.md) and [`tests/fixtures/kubernetes/README.md`](../../tests/fixtures/kubernetes/README.md).
