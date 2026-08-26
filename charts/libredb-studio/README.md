# LibreDB Studio Helm Chart

[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/libredb-studio)](https://artifacthub.io/packages/search?repo=libredb-studio)

Web-based SQL IDE for cloud-native teams supporting fourteen engines - PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Redis, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Apache Trino and Apache Cassandra.

## Prerequisites

- Kubernetes >= 1.26
- Helm >= 3.12

## Quick Start

```bash
# Add the Helm repository
helm repo add libredb https://libredb.org/libredb-studio/
helm repo update

# Zero-config install: first-run admin credentials are generated automatically
helm install libredb libredb/libredb-studio

# Retrieve the generated admin credentials from the pod log
kubectl logs deployment/libredb-libredb-studio | grep -A 4 "generated admin credentials"

# Access via port-forward
kubectl port-forward svc/libredb-libredb-studio 3000:80
# Open http://localhost:3000
```

For production, provide your own secrets instead of relying on generated ones
(add `--set secrets.userPassword=...` only if you want the optional non-admin account):

```bash
helm install libredb libredb/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

### OCI Registry Install

```bash
helm install libredb oci://ghcr.io/libredb/charts/libredb-studio \
  --version 0.1.52 \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

## Storage Modes

### Local (default)

Browser localStorage. No server-side persistence. Suitable for single-user testing.

### SQLite

Persistent file-based storage. A PVC is automatically created.

```bash
helm install libredb libredb/libredb-studio \
  --set config.storageProvider=sqlite \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

> **Note:** SQLite is single-writer. Do not use with multiple replicas.
> With SQLite storage `autoscaling.enabled` is ignored: the HPA is not rendered
> (a warning appears in the install notes) and the deployment stays at `replicaCount`.

### PostgreSQL (built-in subchart)

Deploys a Bitnami PostgreSQL instance alongside LibreDB Studio.

```bash
helm install libredb libredb/libredb-studio \
  --set postgresql.enabled=true \
  --set postgresql.auth.password=pg-secret \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

Storage provider is automatically set to `postgres` when the subchart is enabled.

> **Note:** after Broadcom's August 2025 Bitnami catalog freeze the subchart's
> pinned image is pulled from `docker.io/bitnamilegacy/postgresql`, which is
> frozen and receives no further security updates. For production, prefer an
> external database (below) or a dedicated operator such as
> [CloudNativePG](https://cloudnative-pg.io/).

### PostgreSQL (external)

```bash
helm install libredb libredb/libredb-studio \
  --set config.storageProvider=postgres \
  --set secrets.storagePostgresUrl="postgresql://user:pass@host:5432/libredb" \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

## Auth Bootstrap (Zero-Config vs Strict)

**The chart defaults to the application's zero-config bootstrap** (`config.authBootstrap: ""` — the `AUTH_BOOTSTRAP` variable is omitted and the app default, on, applies): when `secrets.jwtSecret` / `secrets.adminPassword` are not provided, they are generated on first start, printed once to the pod log, and stored in `/app/data/auth-bootstrap.json`. Explicitly set values always win — only missing ones are generated. This makes the chart deployable with default values, which certified catalogs such as the Rancher partner-charts repository require.

Notes on the zero-config default:

- The default install is **admin-only**. The second, non-admin account is never generated; set `secrets.userPassword` to enable it.
- Without persistence the data directory is an `emptyDir`: generated credentials survive container restarts but are regenerated when the pod is recreated. Set `persistence.enabled=true` or provide your own `secrets.*` values for stable credentials.
- Generated credentials appear once in the pod log. If your logs are collected centrally, prefer explicit secrets or strict mode.
- Zero-config is single-replica only: each pod would generate its own JWT secret, breaking sessions across replicas, so the chart refuses to render with `replicaCount > 1` or `autoscaling.enabled` unless `secrets.jwtSecret` (or `secrets.existingSecret`) is set.

### Retrieving the generated credentials

The banner is printed once, by the container that ran the first start. The pod log is therefore not always where you will find it:

```bash
# 1. The usual case
kubectl logs deployment/libredb-libredb-studio | grep -A 4 "generated admin credentials"

# 2. The container has restarted since first start - the banner is in the previous log
kubectl logs deployment/libredb-libredb-studio --previous | grep -A 4 "generated admin credentials"

# 3. Or read the file the app stored them in (mode 0600, survives restarts)
kubectl exec deploy/libredb-libredb-studio -- cat /app/data/auth-bootstrap.json
```

`kubectl logs deployment/...` picks **one** pod arbitrarily, so with more than one replica name the pod that started first explicitly (`kubectl get pods --sort-by=.status.startTime`, then `kubectl logs <pod>`). Deleting `auth-bootstrap.json` makes the next start generate a fresh set.

**Strict mode** (`--set config.authBootstrap=off`) restores fail-closed behavior: `secrets.jwtSecret` is required, and `secrets.adminPassword` is required as well while `authProvider=local` (or use `secrets.existingSecret`); the install fails fast with a clear message when either is missing, and with an existing secret the pod will not start until the referenced keys exist. Under `authProvider=oidc` the admin password is neither required nor referenced as a mandatory Secret key - the issuer authenticates users, so an OIDC `existingSecret` needs no `admin-password` entry. Recommended for production. `secrets.userPassword` stays optional in every mode. Setting `config.authBootstrap=on` is equivalent to the default `""`, just explicit.

### Serving over plain HTTP (LAN or home server)

Auth cookies carry the `Secure` flag in production, and a browser **rejects** a `Secure`
cookie that arrives over plain `http` on a host that is not loopback. The login form then
posts, succeeds, and returns you to the login form - the silent loop reported on home-server
installs. Tell the chart when that is your situation:

```bash
helm install libredb libredb/libredb-studio \
  --set config.authCookieSecure=false
```

The value is three-state and **unset is the default**: the chart writes no
`AUTH_COOKIE_SECURE`, and the app decides for itself, exactly as it did before this value
existed. So an upgrade changes nothing until you set it.

You do **not** need this when TLS is terminated at an ingress or a load balancer: the
browser still speaks `https`, so it accepts the cookie. `false` is only for the case where
the browser's own connection is cleartext - and it means session cookies travel in
cleartext, so keep it to a trusted network. `true` forces the flag on.

## OIDC SSO

```bash
helm install libredb libredb/libredb-studio \
  --set authProvider=oidc \
  --set config.oidcIssuer=https://dev-xxx.auth0.com \
  --set secrets.oidcClientId=your-client-id \
  --set secrets.oidcClientSecret=your-client-secret \
  --set secrets.jwtSecret=$(openssl rand -base64 32)
```

`secrets.adminPassword` is not part of an OIDC install: the issuer authenticates every user, and the app still signs its own session cookie with `secrets.jwtSecret`. Strict mode (`config.authBootstrap=off`) therefore requires only the JWT secret here.

## AI Configuration

```bash
helm install libredb libredb/libredb-studio \
  --set config.llmProvider=openai \
  --set config.llmModel=gpt-4o \
  --set secrets.llmApiKey=sk-your-key \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

## Agent Runtime

Studio can run a read-only investigation agent over a connected database, and **there is nothing to
turn on**. The app derives whether the agent can run from what is true at runtime: a model configured
through the AI settings above (there is no second place to enter a key) plus a writable ledger
directory. Configuring a model IS the opt-in, so this install already has an agent:

```bash
helm install libredb libredb/libredb-studio \
  --set config.llmProvider=gemini \
  --set secrets.llmApiKey=your-key \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

No `extraEnv` recipe and no `--set-string` trap: **the chart sets
`WORKFLOW_LOCAL_DATA_DIR=/app/data/workflow` for you**, and `/app/data` is mounted in every render (an
`emptyDir` by default, the PVC when `persistence.enabled`), so the ledger is writable under this
chart's `readOnlyRootFilesystem: true`. Override it through `extraEnv` only to put the ledger
somewhere else — the chart writes it before `extraEnv`, so your entry wins. When the agent cannot run,
`GET /api/agent/config` says which of the two conditions failed rather than leaving a rail that fails
on its first Start.

The chart sets it rather than leaning on the image because of when each one ships. `image.tag`
defaults to the chart's `appVersion`, and the container image gained its own
`WORKFLOW_LOCAL_DATA_DIR` default in an app version **later than `0.11.0`**, the version this chart
deploys. On the image a default install actually pulls, an unset variable resolves to `.workflow-data`
under the container's working directory `/app` — which `readOnlyRootFilesystem: true` makes
unwritable, and every run would refuse with `LEDGER_UNAVAILABLE`. Once an image carrying the default is
released the two agree on the same path, so nothing changes for you either way.

**Upgrading a deployment that already has `secrets.llmApiKey` set?** Then it has an agent now, whether
or not you asked for one. Decline it explicitly:

```bash
helm upgrade libredb libredb/libredb-studio --reuse-values --set agent.enabled=false
```

`agent.enabled` is an off-switch and nothing more. Unset (the default) writes no
`LIBREDB_AGENT_ENABLED` at all and leaves the runtime deriving its own answer; `false` writes
`LIBREDB_AGENT_ENABLED=false`, which is the supported way to have AI configured and no agent; `true`
is accepted and explicit but cannot conjure a model. The chart renders the value as a quoted string,
which is why no `--set-string` is needed here.

`agent.threadContext` follows the same rule for a narrower thing: whether a run may be told about the
**conversation** it belongs to. A follow-up asked on the same connection otherwise continues the
previous run's conversation — the earlier steps' objectives and the most recent step's report are
derived server-side from those runs' own ledgers and handed to the model fenced. Unset writes
nothing and the runtime keeps its own default, which is on; `false` writes
`LIBREDB_AGENT_THREAD_CONTEXT=false`, and every run then opens on its own with the rail saying so
rather than going quiet.

```bash
helm upgrade libredb libredb/libredb-studio --reuse-values --set agent.threadContext=false
```

Set it where no question's context may reach another. The user already has the equivalent control —
the rail names the conversation and offers to leave it — so this exists for deployments where that
choice may not be theirs.

**Run history lives in that ledger, so `persistence` decides whether it survives.** With
`persistence.enabled=false` the ledger is an `emptyDir`: every run is written, and the entire history
goes with the pod — a restart of the container keeps it, a rescheduled or recreated pod does not. Set
`persistence.enabled=true` if a finished run should still be readable tomorrow. The install notes say
so at the end of a `helm install` that lands in this state.

**The zero-config backend is single-instance, and the chart enforces it.** It keeps run state on each
pod's own disk behind file locks, which is correct for the default `replicaCount: 1` and broken above
it: a run started on one pod is simply not there when the browser's next request lands on another. So
a release that could run agents and asks for more than one replica (or an HPA that can reach two)
**fails to render**, with a message naming the three ways out. Two of them are real today:

```bash
# keep the agent, on one pod
--set replicaCount=1
# or keep many pods, with no agent anywhere
--set agent.enabled=false
```

The third — `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`, the opt-in PostgreSQL backend, pointed
at **its own** database rather than one of the databases you connect Studio to — lifts the render
guard when supplied through `extraEnv`:

```yaml
# values.yaml — extraEnv is rendered verbatim, so valueFrom works for the URL.
# Assumes secrets.jwtSecret (or secrets.existingSecret) is set: the chart also
# refuses to render above one replica under zero-config bootstrap.
replicaCount: 3
extraEnv:
  - name: WORKFLOW_TARGET_WORLD
    value: "@workflow/world-postgres"
  - name: WORKFLOW_POSTGRES_URL
    valueFrom:
      secretKeyRef:
        name: libredb-workflow
        key: postgres-url
```

…but it **does not work with the published image**: that world is absent from the container image and
the npx payload (`B16` in the project's `docs/BACKLOG.md`), so multi-replica agent runs are
unsupported today rather than merely unconfigured. The escape hatch exists because `image.repository`
is overridable — use it only with an image that carries the world. Two further caveats if you do:
`WORKFLOW_TARGET_WORLD` accepts only `local` and `@workflow/world-postgres`, and any other value is
refused when a run is opened rather than defaulted (the workflow runtime would otherwise treat it as a
module to load); and `WORKFLOW_POSTGRES_URL` must be set, because unset that backend falls back to a
development default (`postgres://world:world@localhost:5432/world`) rather than refusing.

**The guard's blind spots, completely.** It reads these values and nothing else, so a model configured
in any of these three places passes it unseen and a multi-replica release renders without complaint:

| Where the model is configured | Why the guard cannot see it |
| --- | --- |
| `secrets.existingSecret` | a Secret the chart does not create and cannot read |
| `extraEnvFrom` | `envFrom` sources, whose keys are not visible to a template |
| `extraEnv` | rendered verbatim and **not** inspected for `LLM_API_KEY`, `LLM_API_URL` or `LLM_PROVIDER` (the only entry it does look for is `WORKFLOW_TARGET_WORLD`, above) |

Set `agent.enabled=false` by hand in any of those cases. The alternative — counting what cannot be
read — would refuse to render every existing multi-replica install that keeps a JWT secret in an
`existingSecret` and configures no AI at all, so the trade is deliberate.

Which providers count as a configured model, when no `agent.enabled` is set: an inline
`secrets.llmApiKey`, or `config.llmProvider` set to `ollama` or `custom`, both of which the app
accepts without an API key (`custom` wants `LLM_API_URL` instead). `gemini` and `openai` require a key,
so they count only when `secrets.llmApiKey` is also set.

Full behaviour, the tool set and the honest limitations are in the project's `docs/AGENT.md`.

### Giving the agent a model it has never measured

The image carries a document recording what specific models were measured under — how long one of
their turns may take, how many readings they may take before being asked to report, whether an empty
turn is worth asking again. A model it does not name is driven with the defaults, which is the honest
treatment of a model nobody has measured.

Mounting a document is how a model somebody else measured gets those settings, with no new release
and no code change:

```bash
kubectl create configmap my-tuning --from-file=model-tuning.json
helm upgrade libredb libredb/libredb-studio --reuse-values \
  --set agent.modelTuning.existingConfigMap=my-tuning
```

Entries are merged **per model and whole**: an entry replaces the shipped entry for that model
rather than contributing one field to it, because half of one measurement beside half of another is
a configuration nobody has ever run. A document that is missing, unreadable or off-schema is
**ignored** and the shipped measurements stand, so this cannot break a working agent.

That last property is also why it needs checking rather than assuming. `GET /api/agent/config`
reports what became of the document to an **admin** session — `{"modelTuning":{"state":"applied",…}}`
or `{"state":"ignored","reason":…}` — because a setting that fails open is one an operator can
otherwise believe is in force for as long as they never look.

The document's contract — every setting and its bounds, what happens to a key this build does not
implement, and a complete example to start from — is in the project's `docs/llms/model-tuning.md`.

**One thing to know about updating it.** The app reads the document once per process, so a change
only takes effect on a pod that restarts. Changing `agent.modelTuning.document` handles that for
you: the rendered ConfigMap is hashed into the pod template, so `helm upgrade` rolls the
deployment. An `existingConfigMap` is your object rather than the chart's — the chart has nothing
to hash and cannot see your edit — so after changing that ConfigMap, roll the deployment yourself:

```bash
kubectl rollout restart deployment/libredb-libredb-studio
```

## Production Setup (Ingress + HA)

```bash
helm install libredb libredb/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=StrongPass123 \
  --set postgresql.enabled=true \
  --set postgresql.auth.password=pg-secret \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set "ingress.hosts[0].host=libredb.example.com" \
  --set "ingress.hosts[0].paths[0].path=/" \
  --set "ingress.hosts[0].paths[0].pathType=Prefix" \
  --set "ingress.tls[0].secretName=libredb-tls" \
  --set "ingress.tls[0].hosts[0]=libredb.example.com" \
  --set autoscaling.enabled=true \
  --set podDisruptionBudget.enabled=true
```

### Traefik Ingress

```bash
helm install libredb libredb/libredb-studio \
  --set ingress.enabled=true \
  --set ingress.className=traefik \
  --set "ingress.annotations.traefik\.ingress\.kubernetes\.io/router\.entrypoints=websecure" \
  --set "ingress.hosts[0].host=libredb.example.com" \
  --set "ingress.hosts[0].paths[0].path=/" \
  --set "ingress.hosts[0].paths[0].pathType=Prefix" \
  # ... secrets omitted for brevity
```

### IPv6 and dual-stack

Dual-stack used to be two settings. Since chart **0.1.42** it is one: the address families the
**Service** is allocated from. The address the **pod** listens on is no longer a values decision —
the ConfigMap writes an empty `HOSTNAME`, and the container resolves its own address at startup,
preferring `::`:

```bash
helm install libredb libredb/libredb-studio \
  --set service.ipFamilyPolicy=PreferDualStack
```

The container does not assume `::` is dual-stack, it proves it: it binds a throwaway listener on
`::` on an ephemeral port, connects to it over `127.0.0.1`, and keeps `::` only if that connection
is accepted. It falls back to `0.0.0.0` in two cases — the namespace has no IPv6 at all, or the
`::` listener really did turn out to be IPv6-only *and* a non-loopback IPv4 address exists that
would otherwise lose reachability. One line in the pod log names the address it chose and why, so
`kubectl logs` answers "what is it listening on" without a shell.

`config.bindAddress` overrules the resolver when you would rather state it than leave it to the
image:

| `config.bindAddress` | Effect |
|---|---|
| `""` (default) | the container resolves it, preferring a verified dual-stack `::` |
| `"::"` | force a dual-stack listener, no probe |
| `"0.0.0.0"` | pin the container to IPv4 — what every chart before 0.1.42 did unconditionally |

`extraEnv` still wins over `config.bindAddress`: it renders an explicit `env` entry, which
overrides the ConfigMap key of the same name. As in the `extraEnv` examples further down, a second
variable needs its own index — reusing `extraEnv[0]` overwrites this one.

**The one pairing that breaks is now a deliberate one.** Kubernetes never checks what address the
container bound: on a dual-stack cluster the pod has an IPv6 address either way, so the IPv6
EndpointSlice is populated and kube-proxy routes to it, where an IPv4-only listener answers with a
TCP RST. Kubelet probes only the primary podIP, so the pod stays `Ready` and the IPv6 path is
silently dead. That is unreachable by default now; it needs an explicit IPv4 pin, through
`config.bindAddress` or an `extraEnv` `HOSTNAME`. The install notes warn on exactly that
combination.

**Upgrading from 0.1.40 or earlier.** A release whose Service is single-stack IPv4 is unaffected in
practice — the pod answers on IPv4 as before, through the same socket. A release with a dual-stack
or IPv6 Service starts answering on its IPv6 address, which is the point of the change but is still
a change: on a cluster where that address is reachable from further away than the IPv4 one, review
your NetworkPolicy before upgrading, or set `config.bindAddress=0.0.0.0` to keep today's behaviour.
Pinning `image.tag` to an older release is safe too: those images treat an empty `HOSTNAME` as
unset and bind `0.0.0.0`, exactly as they do today.

`service.ipFamilyPolicy` takes `SingleStack`, `PreferDualStack` or `RequireDualStack`;
`service.ipFamilies` pins the order explicitly, e.g. `[IPv6, IPv4]`, and needs a dual-stack policy
alongside it or the chart refuses to render. Both are empty by default, so the cluster's own
default applies and existing installs upgrade to an unchanged Service. Three cluster-side rules are
worth knowing before you set them:

- `RequireDualStack` fails to create on a single-stack cluster, and naming a family the cluster
  does not have in `service.ipFamilies` is rejected even under `PreferDualStack`.
- The first entry of `service.ipFamilies` is the primary family — it is what `spec.clusterIP` is
  allocated from — and it is immutable. Reordering the list on a live Service is rejected; the
  Service has to be deleted and recreated.
- A `PreferDualStack` Service is not retroactively upgraded when the cluster later gains
  dual-stack. Adding the second family is a deliberate change, and removing it again requires
  setting `service.ipFamilyPolicy=SingleStack` in the same upgrade.

With `service.type: LoadBalancer` these fields govern the cluster IPs only. Whether the external
address is dual-stack is up to the cloud load-balancer controller, several of which want their own
annotation for it.

## Rate Limiting Across Replicas

Studio's built-in rate limiter (login attempts, AI endpoints, and every database-reaching route —
query execution, schema browsing, maintenance, fleet health) keeps its counters in the application
process. With the default `replicaCount: 1` that is the whole deployment. **If you raise
`replicaCount` or enable `autoscaling`, each replica enforces the budget separately**, so N replicas
allow N times the configured limit. Studio does not ship a distributed limiter, and it is not
planned: an ingress already has one.

Enforce the same budgets at the ingress instead. With nginx:

```bash
helm install libredb libredb/libredb-studio \
  --set replicaCount=3 \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set-string "ingress.annotations.nginx\.ingress\.kubernetes\.io/limit-rpm=120" \
  --set-string "ingress.annotations.nginx\.ingress\.kubernetes\.io/limit-burst-multiplier=2"
```

`--set-string`, not `--set`: ingress annotations are a `map[string]string`, and plain `--set`
type-coerces the bare number, rendering `limit-rpm: 120` as an integer that the API server rejects.

With Traefik, attach a `rateLimit` middleware and reference it from the ingress annotations.

Set `ALLOWED_ORIGINS` at the same time. Studio refuses any POST, PUT, PATCH or DELETE whose Origin
host does not match its own, and an ingress that rewrites the `Host` header to a service name
without setting `x-forwarded-host` will trip that on every request including login. The symptom is
a page that loads and then refuses every action with a 403. There is no dedicated values field for
it, so pass it through `extraEnv`:

```bash
helm install libredb libredb/libredb-studio \
  --set 'extraEnv[0].name=ALLOWED_ORIGINS' \
  --set-string 'extraEnv[0].value=https://libredb.example.com'
```

### The Content-Security-Policy escape hatch

Studio's `Content-Security-Policy` is enforced by default. If an upgrade breaks a resource you
serve from a non-default origin (a self-hosted Monaco bundle, a CDN in front of static assets),
downgrade it to report-only without a rebuild — it is a plain runtime environment variable, also
passed through `extraEnv`:

```bash
helm install libredb libredb/libredb-studio \
  --set 'extraEnv[0].name=CSP_REPORT_ONLY' \
  --set-string 'extraEnv[0].value=true'
```

In report-only mode the browser logs the same violation to its console instead of blocking the
resource. Please also open an issue naming the violated directive.

`--set-string`, not `--set`, and the single quotes are load-bearing in both `extraEnv` recipes above.
`--set extraEnv[0].value=true` renders `value: true`, an unquoted YAML boolean, and the API server
rejects the manifest with `invalid type for io.k8s.api.core.v1.EnvVar.value: got "bool", expected
"string"` — `extraEnv` is typed only as an array of objects in `values.schema.json`, so nothing
catches it before apply. Unquoted `extraEnv[0]` is also a glob pattern in zsh, which fails the
command with `no matches found` before helm is reached.

Setting both `ALLOWED_ORIGINS` and `CSP_REPORT_ONLY` at once needs a distinct index per entry —
`extraEnv` is a list, and `--set` on the same index (`extraEnv[0]` in both examples above) just
overwrites the one element, so copying both snippets into a single command silently keeps only the
second variable:

```bash
helm install libredb libredb/libredb-studio \
  --set 'extraEnv[0].name=ALLOWED_ORIGINS' \
  --set-string 'extraEnv[0].value=https://libredb.example.com' \
  --set 'extraEnv[1].name=CSP_REPORT_ONLY' \
  --set-string 'extraEnv[1].value=true'
```

### Separating the storage encryption key

With `STORAGE_PROVIDER` set to `sqlite` or `postgres`, connection credentials are encrypted at rest
using a key derived from `JWT_SECRET`. Nothing needs configuring for that to work. Set
`STORAGE_ENCRYPTION_KEY` when you want the two separated — most usefully so rotating the
session-signing secret does not invalidate every saved connection password, and, for
`STORAGE_PROVIDER=sqlite`, so a backup or volume snapshot of `/app/data` does not also carry the
key that opens the ciphertext it contains (with nothing set, the fallback key is persisted in that
same directory, alongside the database file):

```bash
helm install libredb libredb/libredb-studio \
  --set 'extraEnv[0].name=STORAGE_ENCRYPTION_KEY' \
  --set 'extraEnv[0].valueFrom.secretKeyRef.name=libredb-studio-storage' \
  --set 'extraEnv[0].valueFrom.secretKeyRef.key=encryption-key'
```

Rotating the key makes existing stored credentials unreadable — the connections survive and their
passwords are omitted. See
[docs/STORAGE.md](https://github.com/libredb/libredb-studio/blob/main/docs/STORAGE.md#credential-encryption-at-rest).

## External Secrets

Use `secrets.existingSecret` to reference a secret managed by External Secrets Operator, Sealed Secrets, or Vault:

```bash
helm install libredb libredb/libredb-studio \
  --set secrets.existingSecret=my-libredb-secret
```

Your external secret is referenced with these keys (customizable via `secrets.existingSecretKeys`):
- `jwt-secret`, `admin-password` — required in strict mode (the pod waits for them); in zero-config mode missing ones are generated at first start
- Optional: `admin-email`, `user-email`, `user-password` (the non-admin account exists only when `user-password` is set), `llm-api-key`, `oidc-client-id`, `oidc-client-secret`, `storage-postgres-url`

## Upgrading

```bash
helm repo update
helm upgrade libredb libredb/libredb-studio
```

> **Behavior change:** the chart default flipped from strict (`config.authBootstrap: "off"`)
> to zero-config (`""`). Releases that relied on the old default become zero-config on
> upgrade: missing `secrets.jwtSecret`/`secrets.adminPassword` no longer fail the install,
> and with `secrets.existingSecret` the auth env references become `optional: true` — a pod
> whose external Secret is missing a key now starts with generated credentials instead of
> waiting in `CreateContainerConfigError`. To keep the previous fail-closed behavior, set
> `config.authBootstrap=off` explicitly.

## Uninstalling

```bash
helm uninstall libredb
```

> **Note:** PVCs are not deleted automatically. To remove persistent data:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=libredb
> ```

## Configuration Reference

| Parameter | Description | Default |
|-----------|-------------|---------|
| `replicaCount` | Number of replicas | `1` |
| `image.repository` | Container image | `ghcr.io/libredb/libredb-studio` |
| `image.tag` | Image tag | `""` (Chart appVersion) |
| `image.pullPolicy` | Pull policy | `IfNotPresent` |
| `authProvider` | Auth mode: local or oidc | `local` |
| `config.authBootstrap` | Auth bootstrap: `""` (zero-config, app default), `on` (explicit zero-config), `off` (strict) | `""` |
| `config.authCookieSecure` | Whether auth cookies carry the `Secure` flag (`AUTH_COOKIE_SECURE`). Unset writes nothing and the app decides (Secure in production, except a loopback host reached over plain http); `false` drops the flag, which is what a browser reaching a non-loopback host over plain http needs - it rejects a Secure cookie and login silently loops; `true` forces it on. TLS terminated at an ingress does not need this | unset |
| `secrets.jwtSecret` | JWT signing secret: empty (zero-config) or >= 32 chars (schema-enforced) | `""` |
| `secrets.adminEmail` | Admin email | `admin@libredb.org` |
| `secrets.adminPassword` | Admin password | `""` |
| `secrets.userEmail` | User email | `user@libredb.org` |
| `secrets.userPassword` | User password (optional; enables the non-admin account) | `""` |
| `secrets.existingSecret` | Use existing Secret | `""` |
| `config.bindAddress` | Container bind address (`HOSTNAME`): empty lets the image resolve one, preferring a verified dual-stack `::`; `::` forces it; `0.0.0.0` pins IPv4 | `""` |
| `config.storageProvider` | Storage: local, sqlite, postgres | `local` |
| `config.llmProvider` | AI provider | `""` |
| `agent.enabled` | Explicit off-switch for the agent runtime. Unset writes nothing and the app derives availability (a configured model plus a writable ledger); `false` writes `LIBREDB_AGENT_ENABLED=false`; `true` declines the off-switch but cannot conjure a model. Rendering fails when an agent could run above one replica | unset |
| `agent.modelTuning.existingConfigMap` | A ConfigMap holding measured per-model settings to layer over the ones the image ships with. Naming a source is what enables the feature — there is no separate flag — and this one is the natural home for a document you were handed: `kubectl create configmap my-tuning --from-file=model-tuning.json`. Mounted read-only at `/app/model-tuning` and named to the app through `AGENT_MODEL_TUNING_PATH` | `""` |
| `agent.modelTuning.document` | The same document inline, rendered into a ConfigMap by this chart and converted to JSON. For a short overlay; `existingConfigMap` wins when both are given | `{}` |
| `agent.modelTuning.configMapKey` | The key the document sits under, which is also the file name it is mounted as | `model-tuning.json` |
| `persistence.enabled` | Enable PVC | `false` |
| `persistence.size` | PVC size | `1Gi` |
| `persistence.emptyDirSizeLimit` | Cap the `/app/data` emptyDir used when persistence is off (e.g. `512Mi`); empty means unlimited | `""` |
| `persistence.fixPermissions` | Chown the mounted volume to `runAsUser:fsGroup` in a root init container (hostPath / static PVs the kubelet does not `fsGroup`). Rendering fails when the OpenShift security-context adaptation is active - restricted-v2 rejects a root container and the UID/GID come from the namespace range there | `false` |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service port | `80` |
| `service.ipFamilyPolicy` | Service address families: `SingleStack`, `PreferDualStack` or `RequireDualStack`; empty renders no field and leaves the cluster default in place | `""` |
| `service.ipFamilies` | Explicit family order, e.g. `[IPv4, IPv6]`; entry 0 is the immutable primary family. Two entries require a dual-stack `service.ipFamilyPolicy` (the chart refuses to render otherwise) | `[]` |
| `ingress.enabled` | Enable Ingress | `false` |
| `route.labels` | Labels added to every enabled route (a per-route label with the same key wins); `labels` is therefore a reserved key name and cannot be a route name | `{}` |
| `route.annotations` | Annotations added to every enabled route (a per-route annotation with the same key wins); reserved key name, as `route.labels` | `{}` |
| `route.main.enabled` | Enables or disables the route | `false` |
| `route.main.additionalRules` | Additional custom rules appended to `spec.rules` | `[]` |
| `route.main.annotations` | Annotations for this route only | `{}` |
| `route.main.apiVersion` | Route apiVersion, e.g. `gateway.networking.k8s.io/v1` or `gateway.networking.k8s.io/v1alpha2` | `gateway.networking.k8s.io/v1` |
| `route.main.filters` | Filters applied to requests matching this rule | `[]` |
| `route.main.hostnames` | Hostnames for the route | `[]` |
| `route.main.httpsRedirect` | Redirect to HTTPS (HTTP 301) instead of routing to the Service | `false` |
| `route.main.kind` | Route kind; only `HTTPRoute` is supported (schema-enforced) | `HTTPRoute` |
| `route.main.labels` | Labels for this route only | `{}` |
| `route.main.matches[0].path.type` | Path match type | `PathPrefix` |
| `route.main.matches[0].path.value` | Path match value | `/` |
| `route.main.parentRefs` | Gateways to attach to; required when the route is enabled (rendering fails without it, since it cannot be defaulted) | `[]` |
| `autoscaling.enabled` | Enable HPA (ignored with SQLite storage: single-writer) | `false` |
| `autoscaling.minReplicas` | Min replicas | `2` |
| `autoscaling.maxReplicas` | Max replicas | `10` |
| `podDisruptionBudget.enabled` | Enable PDB | `false` |
| `podDisruptionBudget.minAvailable` | Min available pods (set only one of minAvailable/maxUnavailable) | `1` |
| `podDisruptionBudget.maxUnavailable` | Max unavailable pods (unset minAvailable with `null` to use) | unset |
| `networkPolicy.enabled` | Enable NetworkPolicy | `false` |
| `postgresql.enabled` | Deploy PostgreSQL subchart | `false` |
| `global.compatibility.openshift.adaptSecurityContext` | Drop fixed UID/GID fields for the OpenShift SCC: `auto`, `force`, or `disabled` | `auto` |

See [values.yaml](values.yaml) for the complete list of configurable parameters.

## OpenShift

OpenShift's `restricted-v2` SCC assigns `runAsUser`/`fsGroup` from a
per-namespace range and rejects pods that hard-code IDs outside it. With the
default `global.compatibility.openshift.adaptSecurityContext: auto`, the chart
detects OpenShift (via the `security.openshift.io/v1` API group) and omits its
fixed `runAsUser`/`runAsGroup`/`fsGroup` so the SCC can assign valid IDs;
`runAsNonRoot` and the seccomp profile are kept. The image supports arbitrary
UIDs: every writable path is a volume mount. Set `force` to always adapt (for
example when templating manifests offline for an OpenShift cluster) or
`disabled` to keep the fixed IDs everywhere.
