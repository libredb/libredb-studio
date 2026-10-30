# LibreDB Studio Helm Chart

[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/libredb-studio)](https://artifacthub.io/packages/search?repo=libredb-studio)

Web-based SQL IDE for cloud-native teams supporting forty-two engines - PostgreSQL, MySQL, SQLite, libSQL, DuckDB, Oracle, Db2 LUW, SQL Server, MongoDB, Redis, Couchbase, Firestore, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Trino, BigQuery, Snowflake, Apache Spark, Apache Cassandra, Prometheus, Apache Kafka, MQTT, RabbitMQ, etcd, Neo4j, Milvus, Qdrant, Weaviate, InfluxDB, InfluxDB 3, Oxia, Databend, S3-compatible object storage, Kubernetes, OPC UA, MTConnect, Modbus, NETCONF, SNMP and Sparkplug B.

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
  --version 0.1.117 \
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

The subchart serves plain TCP by default, so the chart writes `?sslmode=disable` into the `STORAGE_POSTGRES_URL` it builds for it and Studio connects without TLS.
With `postgresql.tls.enabled=true` (and the subchart's certificate settings) the URL carries no `sslmode`, and Studio uses TLS, its default for any non-local host, without verifying the certificate.

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

## Two-Factor Authentication (TOTP)

Optional, local-provider only, and opt-in per account. Set a base32 secret and that account must
present a 6-digit authenticator code after its password:

```bash
# Generate it, enrol the printed value in your authenticator app, then install.
ADMIN_TOTP_SECRET="$(openssl rand 20 | base32 | tr -d '=')"
echo "$ADMIN_TOTP_SECRET"

helm upgrade --install libredb libredb/libredb-studio \
  --set secrets.adminPassword=MyAdmin123 \
  --set secrets.adminTotpSecret="$ADMIN_TOTP_SECRET"
```

No example secret is printed here on purpose. One that looks real invites being copied and left in
place, and a second factor whose secret is published is worse than none.

The value travels in the chart's Secret and is referenced from the pod, so it never appears in the
Deployment spec - which is why `extraEnv` is the wrong tool for it. Both `ADMIN_TOTP_SECRET` and
`USER_TOTP_SECRET` refs are always optional, including in strict mode, so a second factor nobody
asked for can never keep the pod from starting. `values.schema.json` applies the same test the app
does, base32 and at least the 128 bits RFC 4226 requires, so a bad secret fails at install time
rather than at the login screen.

Under `authProvider=oidc` the login page shows no password form and MFA belongs to the identity
provider - but `POST /api/auth/login` stays reachable whenever `secrets.adminPassword` is also set,
and this guards that route in every mode. Full setup, enrolment and recovery:
[`docs/MFA.md`](https://github.com/libredb/libredb-studio/blob/main/docs/MFA.md).

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

The optional single sign-on settings have typed values, each written only when set: `config.oidcUserRoles` (`OIDC_USER_ROLES`), `config.oidcPrompt` (`OIDC_PROMPT`, such as `omit` for silent single sign-on), `config.oidcAutoRedirect` and `config.oidcLogoutHint` (`true` writes the variable), and `config.sessionTtlSeconds` (`AUTH_SESSION_TTL_SECONDS`, 300 to 86400).

### Rancher Manager as the identity provider

Rancher's OIDC provider signs Studio users in with their Rancher identity once an administrator turns on the `oidc-provider` feature flag and creates an `OIDCClient` for Studio ([docs/OIDC.md](https://github.com/libredb/libredb-studio/blob/main/docs/OIDC.md#rancher) has the manifest and the scope each Rancher line accepts).
Write the client id and secret Rancher generates into a Secret of their own, as `oidc-client-id` and `oidc-client-secret`, and name it in `secrets.oidcExistingSecret`.
That value sources `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` only, so the JWT secret and the admin password stay with the chart's own Secret or the zero-config bootstrap, and the pod does not start until the Secret holds both keys:

```yaml
authProvider: oidc
config:
  oidcIssuer: https://rancher.example.com/oidc
  oidcScope: openid profile groups   # 2.15; "openid profile" on 2.14
  oidcPrompt: omit
  oidcAutoRedirect: true
  sessionTtlSeconds: 900
secrets:
  oidcExistingSecret: libredb-studio-oidc
```

`config.oidcScope` must be set, because Rancher refuses the default's `email` scope.
The username is the Rancher user id, such as `u-abc12`, and every user is a `user` until `config.oidcRoleClaim: groups` and `config.oidcAdminRoles` name an admin group principal.
Logout ends Studio's session only, since Rancher has no end-session endpoint.
When Rancher's certificate comes from a private CA, Studio needs it through `NODE_EXTRA_CA_CERTS`, as [Trusting a private CA](#trusting-a-private-ca) shows.
`secrets.oidcExistingSecret` needs `authProvider=oidc`, and the render fails when `secrets.existingSecret`, `secrets.oidcClientId` or `secrets.oidcClientSecret` is set beside it.

### Rancher mode values

A default install sets none of these values; an install inside Rancher Manager sets them alongside the identity provider above:

```yaml
config:
  allowCustomConnections: false   # ALLOW_CUSTOM_CONNECTIONS: seed connections only
  seedLiteralValues: true         # SEED_LITERAL_VALUES: no ${ENV} or ${vault:...} in seeds
seedConnections:
  enabled: true
  existingSecret: libredb-studio-seeds   # the seed file from a Secret, under configMapKey
rancher:
  navLink:
    enabled: true
    label: LibreDB Studio
    group: Databases
    target: _blank
ingress:
  enabled: true
  hosts:
    - host: studio.example.com
      paths:
        - path: /
          pathType: Prefix
```

`config.allowCustomConnections` is three-state like `config.authCookieSecure`: unset writes nothing and the app keeps custom connections on, and `false` keeps every user to the seed connections, which is the setting for a Studio that shares a cluster network with services its users must not reach ([docs/SEED_CONNECTIONS.md](https://github.com/libredb/libredb-studio/blob/main/docs/SEED_CONNECTIONS.md#custom-connections)).
`seedConnections.existingSecret` mounts the seed file from a Secret instead of a ConfigMap, for a seed file that holds passwords; set exactly one of `seedConnections.config`, `seedConnections.existingConfigMap` and `seedConnections.existingSecret`.
`rancher.navLink.enabled` renders a `ui.cattle.io/v1` `NavLink` to `https://<first ingress host><config.basePath>` in the cluster's navigation, only where the cluster serves that API; elsewhere nothing is rendered and the install notes say so.
The link is always https, so serve TLS for that host, through `ingress.tls` or in front of the ingress.
Its icon is the LibreDB logo, written inline as a `data:` URI so the browser fetches nothing from another host; `rancher.navLink.iconSrc` takes another icon as an https URL or a `data:image/` URI, and the schema refuses anything else.
A `NavLink` is cluster-scoped, so installing it needs a cluster owner, and its name is the release namespace and the release's full name joined by a dot.
Its `app.kubernetes.io/name` label stays `libredb-studio` whatever `nameOverride` says, because the LibreDB Rancher extension finds the link by that label.
The render fails when the link is on without `ingress.enabled` and a concrete first host; a wildcard host such as `*.example.com` is refused.

With the Kubernetes access review and discovery, Studio lists the CloudNativePG databases of the namespaces a cluster owner chose, and opens each one only for a Rancher user the cluster lets `get` its credential Secret ([docs/SEED_CONNECTIONS.md](https://github.com/libredb/libredb-studio/blob/main/docs/SEED_CONNECTIONS.md#kubernetes-access-review)):

```yaml
authProvider: oidc
config:
  oidcIssuer: https://rancher.example.com/oidc
  oidcScope: openid profile groups
  oidcPrompt: omit
  oidcAutoRedirect: true
  sessionTtlSeconds: 900          # at most 900 with the review on
  allowCustomConnections: false
secrets:
  oidcExistingSecret: libredb-studio-oidc
agent:
  enabled: false
seedConnections:
  cacheTTL: 10000                 # the managed list, discovered databases included, is read again every 10 s
accessReview:
  enabled: true
  cacheSeconds: 15
discovery:
  kubernetes:
    enabled: true
    namespaces: [team-a, team-b]
```

`accessReview.enabled` writes `KUBERNETES_ACCESS_REVIEW=on`, names Studio's own Deployment as the one whose `update` right makes a Studio admin, and grants Studio's ServiceAccount `create` on `subjectaccessreviews` through a ClusterRole and ClusterRoleBinding named `<namespace>.<fullname>-access-review`.
The reviews authenticate with a projected token of that ServiceAccount and the cluster's CA, mounted read-only at `/var/run/secrets/libredb/access-review`; the pod's own token mount stays off.
`accessReview.cacheSeconds` (0 to 60), `accessReview.signIn` and `accessReview.tokenExpirationSeconds` (600 to 86400, 3600 when unset) are written only when set.
With the review on, admin comes only from that review, so the chart writes no `ADMIN_PASSWORD`, `USER_EMAIL` or `USER_PASSWORD` from `secrets.existingSecret`.
The render fails, naming the value, for every combination Studio refuses to start with: `authProvider` other than `oidc`, `config.oidcRoleClaim`, `mcp.enabled`, `agent.enabled=true`, `governance.enabled`, `secrets.adminPassword` or `secrets.userPassword`, `config.sessionTtlSeconds` unset or above 900, `serviceAccount.create=false` without a `serviceAccount.name` or a `serviceAccount.name` of `default`, either of which would grant the namespace's default account, the discovery exporter's account as Studio's, an `accessReview.signIn` that is not `<verb> <resource>[.<group>][/<name>] [-n <namespace>]`, and an `extraEnv` entry named `KUBERNETES_ACCESS_REVIEW*`.
With `networkPolicy.enabled`, the review also opens egress on port 6443, where `kubernetes.default.svc` lands on RKE2, k3s and kubeadm; an API server on another port goes in `networkPolicy.additionalEgress`.
Switching `accessReview.enabled` on for an install that already signs people in through OIDC: rotate `secrets.jwtSecret` in the same upgrade, because an earlier session keeps its role until it expires.

`discovery.kubernetes.enabled` runs the exporter as a Deployment `<fullname>-discovery` of one replica, from Studio's image and with a ServiceAccount of its own.
It gets `list` on each kind it discovers (`clusters.postgresql.cnpg.io` for `cnpg`, `clusters.postgresql.k8s.enterprisedb.io` for `edbpg`, `postgresclusters.postgres-operator.crunchydata.com` for `pgo`, `mongodbcommunity.mongodbcommunity.mongodb.com` for `mongo`) and `get` on Secrets and Services in each namespace of `discovery.kubernetes.namespaces`, through a Role and RoleBinding `<namespace>.<fullname>-discovery` there, named by the release namespace so two releases may discover one namespace, so those namespaces must exist first, and `get` and `update` on the export Secret by name; no rule lists or watches Secrets or Services.
The chart creates that Secret, `<fullname>-discovery-export`, with no data, so an upgrade keeps what the exporter wrote, and Studio mounts it read-only for `SEED_KUBERNETES_DISCOVERY_PATH`.
`discovery.kubernetes.intervalMs` (30000), `discovery.kubernetes.kinds` (`cnpg` alone when empty; `edbpg`, `pgo` and `mongo` are opted in, each needing its CRD on the cluster), `discovery.kubernetes.maxAgeMs` and `discovery.kubernetes.resources` tune it, and `seedConnections.cacheTTL` is written as `SEED_CACHE_TTL_MS` with discovery on, outside openshift sign-in mode.
`discovery.kubernetes.clusterDomain` writes `SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN` for a cluster whose kubelets run with a domain other than `cluster.local`.
Without the access review, the discovered databases are listed for admins only.
The render fails with no namespace, with `governance.enabled`, and with an `extraEnv` entry named `SEED_KUBERNETES_DISCOVERY*`.

The access review and discovery each run one replica, because the groups of each sign-in and the review and export caches live in one process: `replicaCount` above 1 or `autoscaling.enabled` fails the render.
The ClusterRole, the Roles in other namespaces and the `NavLink` need a cluster owner to install.
Rancher's Apps page draws a form for these values from `questions.yaml`; the form cannot name a list entry, so set the ingress host and TLS in its YAML view.
Rancher mode is not offered through the OLM operator in this release: its role grants no `ui.cattle.io` `NavLink`, no ClusterRole or ClusterRoleBinding and no read on CloudNativePG Clusters, so the API server refuses the exporter's Roles as an escalation; set these values with Helm or Rancher's Apps page.

## Governance

Governance runs Studio under a control plane: the governance source in PostgreSQL becomes the only catalog of connections and grants, and the identity provider the only way to sign in ([docs/GOVERNANCE.md](https://github.com/libredb/libredb-studio/blob/main/docs/GOVERNANCE.md)).
Until `governance.enabled` is true the chart writes no `GOVERNANCE_*` variable.

```yaml
authProvider: oidc
governance:
  enabled: true
config:
  authBootstrap: "off"
  oidcIssuer: https://auth.example.com/realms/libredb
  oidcRoleClaim: libredb_roles
  oidcUserRoles: user
  storageProvider: postgres
  storagePostgresSchema: studio
secrets:
  existingSecret: libredb-studio
```

An installer writes the Secret with the usual keys plus two for governance:

- `governance-postgres-url`: the governance source URL for Studio's own role, written to `GOVERNANCE_POSTGRES_URL` through a `secretKeyRef`.
- `governance-private-keys`: the keyring document, mounted read-only at `/etc/libredb/governance/keyring.json` with mode 0400 and never an environment variable; `GOVERNANCE_PRIVATE_KEYS_FILE` points at it.

Without `secrets.existingSecret`, `secrets.governancePostgresUrl` and `secrets.governancePrivateKeys` put the same two values in the chart's own Secret.
The pod keeps `podSecurityContext.fsGroup` 1001, because the keyring file is root-owned and uid 1001 reads it through the group.
The readiness probe moves to `/api/ready`, which answers 503 until the first snapshot loads, and liveness stays on `/api/db/health`.

The instance id that Studio reports in its heartbeat (`GOVERNANCE_INSTANCE_ID`) is `governance.instanceId`, or the chart's fullname when it is empty, so a rollout updates the same heartbeat row.
With more than one replica every pod reports its own name instead, and a set `governance.instanceId` fails the render.

The render fails, naming the value to fix, for every combination Studio would refuse to start with: `authProvider` other than `oidc`, an empty `config.oidcRoleClaim`, `config.oidcUserRoles` or `config.storagePostgresSchema`, a governance URL or keyring with neither an inline value nor `secrets.existingSecret`, `seedConnections.enabled`, `config.allowCustomConnections=true`, `mcp.enabled` or `agent.enabled=true`, a set `secrets.adminPassword` or `secrets.userPassword`, or an `extraEnv` entry named `GOVERNANCE_*`.
Under governance the chart also writes no `ADMIN_PASSWORD`, `USER_EMAIL` or `USER_PASSWORD` from `secrets.existingSecret`.
More than one replica, or `autoscaling.enabled`, renders only with `stickySessions.enabled=true`, which records that cookie affinity is configured at the ingress, because Studio keeps transactions, rate limits and per-user providers in process memory.
The chart renders no affinity annotation itself.

## Trusting a private CA

When the OIDC issuer or Vault uses a certificate from an internal CA, Node.js rejects it unless the CA is added to `NODE_EXTRA_CA_CERTS`.
A database connection takes its CA in its own TLS settings instead, except where the provider's page under [docs/providers](https://github.com/libredb/libredb-studio/tree/main/docs/providers) says `ssl.caCert` is not honoured; such a database needs this too.
Mount the CA from a ConfigMap or Secret already in the namespace with `extraVolumes` and `extraVolumeMounts`, and point the variable at the file through `extraEnv`:

```yaml
extraVolumes:
  - name: internal-ca
    configMap:
      name: internal-ca          # holds ca.crt
extraVolumeMounts:
  - name: internal-ca
    mountPath: /etc/ssl/internal
    readOnly: true
extraEnv:
  - name: NODE_EXTRA_CA_CERTS
    value: /etc/ssl/internal/ca.crt
```

Without it the OIDC login fails with a TLS error such as `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
From the first application release after 1.1.0, Studio refuses to boot when the file `NODE_EXTRA_CA_CERTS` names is missing, unreadable, empty, whitespace only or holds no PEM certificate, where Node itself would only warn and trust nothing extra.

When the CA sits in a Secret that also holds a private key, such as a cert-manager or Elasticsearch certificate Secret, project only the CA key so the private key never reaches the pod:

```yaml
extraVolumes:
  - name: internal-ca
    secret:
      secretName: elasticsearch-master-certs
      items:
        - key: ca.crt
          path: ca.crt
```

Node reads the file only when the container starts, and the chart's restart-on-change checksums cover only the ConfigMap and Secret it renders itself, so after the CA changes, run `kubectl rollout restart` on the Deployment.

## AI Configuration

```bash
helm install libredb libredb/libredb-studio \
  --set config.llmProvider=openai \
  --set config.llmModel=gpt-4o \
  --set secrets.llmApiKey=sk-your-key \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

With `config.llmProvider=openai`, `config.llmModelEffort` sets the model's reasoning effort, for example `--set config.llmModelEffort=low`.
Leave it empty for the model's own default; the values table below lists the accepted values.

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
somewhere else: the chart writes it before `extraEnv`, so your entry wins, but only under client-side
apply, see [Overriding a variable the chart writes](#overriding-a-variable-the-chart-writes). When the agent cannot run,
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

### Overriding a variable the chart writes

An `extraEnv` entry whose name the chart also writes renders a second entry of that name after the chart's, and Kubernetes uses the last one.
Helm 3, Helm 4 with `--server-side=false` and the OLM operator apply it that way.
Helm 4 installs and upgrades with server-side apply by default, and the API server refuses a container `env` with a repeated name (`duplicate entries for key [name="..."]`), so with Helm 4 pass `--server-side=false` when `extraEnv` overrides one of the chart's variables, or set the chart's own value where one exists.

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

| `config.basePath` | Must match `BASE_PATH` baked into your custom image; prefixes default health probes | `""` |
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
- Optional: `admin-email`, `user-email`, `user-password` (the non-admin account exists only when `user-password` is set), `admin-totp-secret`, `user-totp-secret`, `llm-api-key`, `oidc-client-id`, `oidc-client-secret`, `storage-postgres-url`
- With `governance.enabled`: `governance-postgres-url` and `governance-private-keys` (see [Governance](#governance))

To ship the `ExternalSecret` with the release, so it is installed, upgraded and removed with it, list it in `extraObjects`:

```yaml
config:
  authBootstrap: "off"
secrets:
  existingSecret: libredb-secrets
extraObjects:
  - apiVersion: external-secrets.io/v1
    kind: ExternalSecret
    metadata:
      name: libredb-secrets
    spec:
      secretStoreRef:
        kind: SecretStore
        name: vault
      target:
        name: libredb-secrets
      dataFrom:
        - extract:
            key: libredb/studio
```

Strict mode (`config.authBootstrap: "off"`) matters here: it makes the pod wait for the Secret the ExternalSecret creates, where zero-config mode would start without it and generate credentials of its own first.

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

> **Behavior change (chart 0.1.83):** `serviceAccount.automountServiceAccountToken` is now set on the pod spec too.
> With `serviceAccount.create=false`, the pod used to mount the API token of the account it ran as, usually the namespace's `default` one; it now mounts none.
> Studio reads that token only for Vault Kubernetes auth (`VAULT_ROLE`), so an install with `serviceAccount.create=false` that logs in to Vault this way loses its Vault-backed seed connections on upgrade unless it takes one of two steps.
> Set `serviceAccount.automountServiceAccountToken=true`, or project a token through `extraVolumes` and `extraVolumeMounts` and point `VAULT_K8S_TOKEN_PATH` at it through `extraEnv`.

> **Behavior change (chart 0.1.109):** a release with a volume claim on `/app/data` (`persistence.enabled`, or `config.storageProvider=sqlite`) and one replica now stops the old pod before it creates the new one, on every upgrade and restart.
> The rollout used to keep the old pod until the new one was ready, which never happens when the new pod cannot mount a ReadWriteOnce volume attached to another node, so such an upgrade failed once `helm --wait` gave up.
> Expect a short outage while the new pod starts; a release with more than one replica rolls as before.

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
| `authProvider` | Auth mode: `local`, `oidc` or `openshift` ([OpenShift sign-in](#openshift-sign-in)) | `local` |
| `config.authBootstrap` | Auth bootstrap: `""` (zero-config, app default), `on` (explicit zero-config), `off` (strict) | `""` |
| `config.authCookieSecure` | Whether auth cookies carry the `Secure` flag (`AUTH_COOKIE_SECURE`). Unset writes nothing and the app decides (Secure in production, except a loopback host reached over plain http); `false` drops the flag, which is what a browser reaching a non-loopback host over plain http needs - it rejects a Secure cookie and login silently loops; `true` forces it on. TLS terminated at an ingress does not need this | unset |
| `config.passkeyOrigin` | The public origin people open Studio at, written to `PASSKEY_ORIGIN` when set: scheme, host and port, no path (so no `config.basePath`), such as `https://studio.example.com`. Passkeys also need `config.storageProvider` `sqlite` or `postgres` and `authProvider` `local`; browsers offer them only over https or on `http://localhost`, and the app validates the value. Changing the host means users register their passkeys again. Needs an application image that includes passkey sign-in (#785): appVersion 0.17.0 does not read it. Guide: [`docs/PASSKEYS.md`](https://github.com/libredb/libredb-studio/blob/main/docs/PASSKEYS.md) | `""` |
| `secrets.jwtSecret` | JWT signing secret: empty (zero-config) or >= 32 chars (schema-enforced) | `""` |
| `secrets.adminEmail` | Admin email | `admin@libredb.org` |
| `secrets.adminPassword` | Admin password | `""` |
| `secrets.userEmail` | User email | `user@libredb.org` |
| `secrets.userPassword` | User password (optional; enables the non-admin account) | `""` |
| `secrets.adminTotpSecret` | Base32 TOTP secret for the admin account (optional second factor) | `""` |
| `secrets.userTotpSecret` | Base32 TOTP secret for the user account (optional second factor) | `""` |
| `secrets.existingSecret` | Use existing Secret | `""` |
| `config.bindAddress` | Container bind address (`HOSTNAME`): empty lets the image resolve one, preferring a verified dual-stack `::`; `::` forces it; `0.0.0.0` pins IPv4 | `""` |
| `config.storageProvider` | Storage: local, sqlite, postgres | `local` |
| `config.storagePostgresSchema` | Schema of the PostgreSQL storage tables (`STORAGE_POSTGRES_SCHEMA`); empty writes nothing. Studio never creates it. Required under governance | `""` |
| `config.oidcUserRoles` | Role values that make a user (`OIDC_USER_ROLES`); empty writes nothing. Required under governance | `""` |
| `config.oidcPrompt` | Prompt sent on sign-in (`OIDC_PROMPT`): `login`, `omit`, `consent` or `select_account`; empty writes nothing | `""` |
| `config.oidcAutoRedirect` | `true` writes `OIDC_AUTO_REDIRECT=true`, sending a signed-out visitor of `/login` to the identity provider | `false` |
| `config.oidcLogoutHint` | `true` writes `OIDC_LOGOUT_HINT=true`, sending `id_token_hint` on logout | `false` |
| `config.sessionTtlSeconds` | Session lifetime in seconds, 300 to 86400 (`AUTH_SESSION_TTL_SECONDS`); unset keeps the app's 86400, or 28800 with `authProvider=openshift` | unset |
| `governance.enabled` | Run Studio under governance (`GOVERNANCE_SOURCE=postgres`); see [Governance](#governance) | `false` |
| `governance.postgresSchema` | Schema of the governance source (`GOVERNANCE_POSTGRES_SCHEMA`) | `bridge` |
| `governance.instanceId` | Heartbeat instance id; empty uses the chart's fullname with one replica and each pod's name with more | `""` |
| `governance.refreshMs` | `GOVERNANCE_REFRESH_MS`, 1000 to 600000; unset keeps the app's 30000 | unset |
| `governance.maxStalenessMs` | `GOVERNANCE_MAX_STALENESS_MS`, up to 3600000; unset keeps the app's 120000 | unset |
| `governance.allowedEngines` | `GOVERNANCE_ALLOWED_ENGINES`, comma-separated type ids; empty keeps the app's default list | `""` |
| `secrets.governancePostgresUrl` | Governance source URL, stored in the chart's Secret under `governance-postgres-url` | `""` |
| `secrets.governancePrivateKeys` | Keyring document, stored in the chart's Secret under `governance-private-keys` and mounted as a file | `""` |
| `stickySessions.enabled` | Records that cookie affinity is configured at the ingress; under governance, more than one replica or autoscaling renders only with it. Renders nothing itself | `false` |
| `config.llmProvider` | AI provider | `""` |
| `config.llmModelEffort` | `LLM_MODEL_EFFORT`, the reasoning effort for `config.llmProvider=openai` only: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Empty writes nothing and the model keeps its own default. Which values a model takes is the model's own (GPT-6.1 Sol has no `none`). Needs an application image after 1.0.0 | `""` |
| `agent.enabled` | Explicit off-switch for the agent runtime. Unset writes nothing and the app derives availability (a configured model plus a writable ledger); `false` writes `LIBREDB_AGENT_ENABLED=false`; `true` declines the off-switch but cannot conjure a model. Rendering fails when an agent could run above one replica | unset |
| `agent.modelTuning.existingConfigMap` | A ConfigMap holding measured per-model settings to layer over the ones the image ships with. Naming a source is what enables the feature — there is no separate flag — and this one is the natural home for a document you were handed: `kubectl create configmap my-tuning --from-file=model-tuning.json`. Mounted read-only at `/app/model-tuning` and named to the app through `AGENT_MODEL_TUNING_PATH` | `""` |
| `agent.modelTuning.document` | The same document inline, rendered into a ConfigMap by this chart and converted to JSON. For a short overlay; `existingConfigMap` wins when both are given | `{}` |
| `agent.modelTuning.configMapKey` | The key the document sits under, which is also the file name it is mounted as | `model-tuning.json` |
| `mcp.enabled` | Serve the MCP endpoint at `/api/mcp` (docs/MCP.md). `false` writes no `LIBREDB_MCP_*` variable; `true` writes all four as strings and requires `mcp.url` and `mcp.tokenLabel`, and the render fails without them | `false` |
| `mcp.url` | The address MCP clients use, which every token is bound to: an absolute http(s) URL ending in `/api/mcp`, with `config.basePath` when one is set | `""` |
| `mcp.tokenLabel` | Any non-empty value; changing it revokes every MCP token at once, which is the only revocation | `""` |
| `mcp.tokenTtlDays` | Days a minted MCP token stays valid, 1 to 365 | `30` |
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
| `networkPolicy.enabled` | Render the NetworkPolicy: `true` always, `false` never, unset only in openshift sign-in mode with discovery on, where it confines database egress to the discovered namespaces. On OpenShift, and in openshift mode, it also allows egress on UDP and TCP 5353 (DNS) and TCP 6443 (API server) | unset |
| `serviceAccount.create` | Create a ServiceAccount for the pod; `false` runs it as `serviceAccount.name`, or the namespace's `default` account when that is empty, and fails the render under the OLM operator | `true` |
| `serviceAccount.automountServiceAccountToken` | Mount an API token into the pod. Set on the pod spec as well as on the created ServiceAccount, so it also holds for an account the chart does not create; only `true` mounts one. Studio reads the token only for Vault Kubernetes auth (`VAULT_ROLE`) | `false` |
| `postgresql.enabled` | Deploy PostgreSQL subchart | `false` |
| `postgresql.tls.enabled` | Serve the subchart over TLS. Off, the chart adds `sslmode=disable` to the storage URL; on, it adds none and Studio connects with TLS | `false` |
| `extraVolumes` | Additional pod volumes (Kubernetes `Volume` objects), such as a private CA from a ConfigMap or Secret | `[]` |
| `extraVolumeMounts` | Additional volume mounts for the app container (Kubernetes `VolumeMount` objects). With a CA mounted, set `NODE_EXTRA_CA_CERTS` to the file through `extraEnv` so an OIDC issuer or Vault on an internal CA is trusted | `[]` |
| `extraObjects` | Additional Kubernetes manifests deployed with the release, each rendered through `tpl` so it can use release values and the chart's helpers; a string item is taken as a template as it is. Write a literal `{{`, such as one in a Prometheus alert, as `{{ "{{" }}`, or the install fails. Not available through the OpenShift operator, whose CRD refuses it | `[]` |
| `global.compatibility.openshift.adaptSecurityContext` | Drop fixed UID/GID fields for the OpenShift SCC: `auto`, `force`, or `disabled` | `auto` |
| `global.compatibility.openshift.apis` | How OpenShift objects detect their API: `auto` asks the API server, `force` renders them without detection (GitOps, offline `helm template`) | `auto` |
| `openshiftRoute.enabled` | Render an OpenShift Route to the Service's `http` port; needs `route.openshift.io/v1` or `apis=force` | `false` |
| `openshiftRoute.host` | Route host; empty lets the router generate one. A set host needs `routes/custom-host` | `""` |
| `openshiftRoute.tls.termination` | TLS termination; only `edge` (schema-enforced) | `edge` |
| `openshiftRoute.tls.insecureEdgeTerminationPolicy` | Plain HTTP handling: `Redirect`, `Allow` or `None` | `Redirect` |
| `openshiftRoute.timeout` | `haproxy.router.openshift.io/timeout`; must exceed the largest `queryTimeout` an admin allows. Empty omits it and the router's 30s applies | `120s` |
| `openshiftRoute.hstsHeader` | `haproxy.router.openshift.io/hsts_header`; empty omits it | `""` |
| `openshiftRoute.annotations` | Extra Route annotations | `{}` |
| `openshiftRoute.labels` | Extra Route labels (chart labels win on a collision) | `{}` |
| `openshift.trustedCABundle.enabled` | Mount the cluster's injected trusted CA bundle and set `NODE_EXTRA_CA_CERTS`; needs `config.openshift.io/v1` or `apis=force`, and refuses an `extraEnv` `NODE_EXTRA_CA_CERTS` | `false` |
| `openshift.topology.partOf` | `app.kubernetes.io/part-of` on every Deployment and pod template; empty renders none | `""` |
| `openshift.topology.runtime` | `app.openshift.io/runtime` on every Deployment and pod template; empty renders none | `""` |
| `openshift.signIn.tokenExpirationSeconds` | openshift mode: lifetime of the projected token, audience `libredb-studio-oauth-client`, Studio sends to the OAuth server as its client secret, 600 to 86400 | `600` |
| `openshift.signIn.reviewCacheSeconds` | openshift mode: `KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS`, 0 to 60; unset keeps the app's 15 | unset |
| `openshift.signIn.review` | openshift mode: `KUBERNETES_ACCESS_REVIEW_SIGN_IN`, a review a person must also pass to sign in, as `oc auth can-i` takes it; empty writes nothing | `""` |
| `openshift.consoleLink.enabled` | Render a `console.openshift.io/v1` ConsoleLink to `https://<openshiftRoute.host><config.basePath>`; needs `console.openshift.io/v1` or `apis=force`, `openshiftRoute.host` and a cluster admin | `false` |
| `openshift.consoleLink.location` | `ApplicationMenu` or `NamespaceDashboard` | `ApplicationMenu` |
| `openshift.consoleLink.section` | The `ApplicationMenu` section | `LibreDB` |
| `openshift.consoleLink.text` | The link's text | `LibreDB Studio` |
| `openshift.consoleLink.imageUrl` | The `ApplicationMenu` icon, an https URL or a `data:image/` URI; empty renders none | `""` |
| `openshift.consoleLink.namespaces` | `NamespaceDashboard`: the namespaces whose dashboard shows the link | `[]` |
| `openshift.consoleLink.namespaceSelector` | `NamespaceDashboard`: a label selector for those namespaces | `{}` |
| `discovery.kubernetes.clusterDomain` | `SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN`, the cluster's DNS domain every discovered host ends in; unset keeps `cluster.local` | unset |
| `operator.managed` | Set by the OLM operator only: cross-namespace and cluster-scoped objects then render only for the release in `operator.clusterStudioNamespace` | `false` |
| `operator.clusterStudioNamespace` | Set by the OLM operator only, to the namespace it is installed in, the only one it reconciles; empty allows no cross-namespace or cluster-scoped object | `""` |

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

### Exposing Studio on OpenShift

Three ways expose the Service, each independent of the others:

| Values | Object | Where it works |
|--------|--------|----------------|
| `ingress.*` | Ingress | Any cluster with an Ingress controller; the OpenShift router also turns an Ingress into a Route, and reads `route.openshift.io/termination` from its annotations |
| `route.*` | Gateway API HTTPRoute | Any cluster with a Gateway API implementation |
| `openshiftRoute.*` | OpenShift Route (`route.openshift.io/v1`) | OpenShift |

A typical OpenShift install, with the Route, the cluster's trusted CA bundle and the Topology labels:

```bash
helm install studio libredb/libredb-studio \
  --version 0.1.117 \
  --set openshiftRoute.enabled=true \
  --set openshift.trustedCABundle.enabled=true \
  --set openshift.topology.partOf=libredb \
  --set openshift.topology.runtime=nodejs
```

The Route terminates TLS at the router (`edge`) and redirects plain HTTP.
`openshiftRoute.tls.termination` accepts `edge` only; re-encrypt and passthrough need a TLS listener in the image, which it does not have.
With `openshiftRoute.host` empty the router generates a host; setting one needs the `routes/custom-host` permission in the namespace.
The router cuts a request after 30s by default, so the chart sets `haproxy.router.openshift.io/timeout` to `120s`: `openshiftRoute.timeout` must exceed the largest per-connection `queryTimeout` an admin allows, or a long query is cut at the router while the database still runs it.
The symptom of a cut is a JSON parse error in the query UI after about 30 seconds: the router answers with its own 504 page instead of Studio's JSON, so raise `openshiftRoute.timeout` above the query timeout.
`openshiftRoute.hstsHeader` adds the router's `hsts_header` annotation, for example `max-age=31536000`.

The Route and the trusted CA bundle each check that their OpenShift API is served, and the render fails otherwise, naming the value to change; the Topology labels render on any cluster.

With `networkPolicy.enabled` on OpenShift, and in openshift sign-in mode wherever it renders, the policy also allows egress on UDP and TCP 5353, where the `dns-default` Service forwards DNS to the CoreDNS pods, and on TCP 6443, where `kubernetes.default.svc` lands on the API server.
An existing OpenShift install with the policy on gains these two egress ports on the upgrade to 0.1.110 without setting any new value.

### OpenShift sign-in

`authProvider=openshift` signs people in with their OpenShift account through the cluster's OAuth server, with Studio's ServiceAccount as the OAuth client, and reviews every database and admin request with the signed-in user's own token.
It needs an application image after 1.1.0: release 1.1.0 and earlier have no openshift sign-in, so the render fails while the effective `image.tag` (`appVersion` when unset) is a version at or below 1.1.0, and accepts a tag that is not a version, such as `latest` or a branch tag.
A typical install, with discovery of two namespaces:

```yaml
authProvider: openshift
image:
  tag: "1.2.0"                     # a release after 1.1.0; drop it once appVersion is past 1.1.0
openshiftRoute:
  enabled: true
  host: studio-data.apps.example.com
discovery:
  kubernetes:
    enabled: true
    namespaces: [team-a, team-b]
    kinds: [cnpg, pgo]
openshift:
  consoleLink:
    enabled: true                  # a link in the console's application menu
```

```bash
helm install studio libredb/libredb-studio --version 0.1.117 --namespace data -f openshift-values.yaml
```

The chart annotates the ServiceAccount with `serviceaccounts.openshift.io/oauth-redirectreference.first`, naming the Route, and `serviceaccounts.openshift.io/oauth-redirecturi.first`, the callback path under `config.basePath`, so the OAuth server accepts that one callback.
It mounts a projected token of that account with the audience `libredb-studio-oauth-client`, never the API server's, for `openshift.signIn.tokenExpirationSeconds` (600), and the cluster's CA from the `kube-root-ca.crt` ConfigMap, read-only at `/var/run/secrets/libredb/openshift`; the pod's own API token mount stays off.
It writes `OPENSHIFT_OAUTH_CLIENT_ID` (`system:serviceaccount:<namespace>:<account>`), `OPENSHIFT_PUBLIC_URL` (`https://<openshiftRoute.host><config.basePath>`), `OPENSHIFT_OAUTH_TOKEN_FILE` and `OPENSHIFT_API_CA_FILE`, all before `extraEnv`, so an `extraEnv` entry of the same name wins under client-side apply (see [Overriding a variable the chart writes](#overriding-a-variable-the-chart-writes)).
A Studio admin is whoever may `update` Studio's Deployment, or, under the OLM operator, the `LibreDBStudio` resource, which may not move that target through a `KUBERNETES_ACCESS_REVIEW_ADMIN_*` entry of `extraEnv`.
The session lasts the app's 28800 seconds in this mode unless `config.sessionTtlSeconds` is set, and the review cache the app's 15 seconds unless `openshift.signIn.reviewCacheSeconds` is.
No `ADMIN_PASSWORD`, `USER_EMAIL`, `USER_PASSWORD` or `SEED_CACHE_TTL_MS` is written, so `seedConnections.cacheTTL` is ignored in this mode: the browser refreshes the connection list every 10 seconds instead.

The render fails, naming the value, for every values set this mode cannot run: `openshiftRoute.enabled` off or `openshiftRoute.host` empty (the host must be fixed at install time), `serviceAccount.create=false`, `serviceAccount.name=default` or, with discovery on, the exporter's `<fullname>-discovery`, `serviceAccount.automountServiceAccountToken=true`, `replicaCount` above 1 or `autoscaling.enabled` (the users' tokens and the caches live in one process), `config.oidcRoleClaim`, `mcp.enabled`, `agent.enabled=true`, `accessReview.enabled`, `accessReview.cacheSeconds` or `accessReview.signIn` (use `openshift.signIn.*`), `secrets.adminPassword` or `secrets.userPassword`, `governance.enabled`, a `serviceAccount.annotations` entry registering another OAuth redirect, and an `extraVolumes` entry named `openshift-oauth` or an `extraVolumeMounts` entry at `/var/run/secrets/libredb/openshift`.
Moving an install wired by hand to this mode: drop the hand-wired `extraVolumes`, `extraVolumeMounts`, the `OPENSHIFT_*`, `KUBERNETES_ACCESS_REVIEW_ADMIN_*` and `NEXT_PUBLIC_AUTH_PROVIDER` entries of `extraEnv`, and the two `serviceAccount.annotations`, in the same upgrade that sets `authProvider=openshift`.
In every mode, an `extraEnv` entry `NEXT_PUBLIC_AUTH_PROVIDER` that names another mode than `authProvider` fails the render, and so do `OPENSHIFT_OAUTH_CLIENT_ID` and `OPENSHIFT_OAUTH_TOKEN_FILE` outside this mode, because every guard and default of the mode keys on `authProvider`.

With discovery on, each person lists only the discovered databases whose credential Secret they may `get`, and the chart writes `ALLOW_CUSTOM_CONNECTIONS=false` unless `config.allowCustomConnections` is set.
Setting it to `true` is accepted, but a connection of a user's own then reaches any database the pod can reach, past the review of every discovered one, so weigh it as a network pivot.
The NetworkPolicy renders by default in this mode with discovery on: its database-port rule allows only the discovered namespaces, and the release namespace while `postgresql.enabled` holds Studio's storage, while DNS (53, 5353), 443 and the API server (6443) stay open to every destination.
It also confines ingress, as every render of the policy does, to TCP `service.targetPort` from anywhere plus `networkPolicy.additionalIngress`, which the router and the chart's test pod use.
Only the six database ports are confined: a policy matches after the Service rewrite, so a principal who may write EndpointSlices in a discovered namespace (the default `edit` role may not) could still point a Service at another address on 53, 5353, 443 or 6443.
An upgrade with `--reuse-values` from chart 0.1.113 or earlier carries that release's `networkPolicy.enabled: false` and so opts out silently: upgrade with `--reset-then-reuse-values`, or set `networkPolicy.enabled=true`; the install notes warn when the policy is off in this mode.
An external storage database or any other destination goes in `networkPolicy.additionalEgress`, and `networkPolicy.enabled=false` is the opt-out.
On a cluster that serves `config.openshift.io/v1`, discovery with `authProvider=oidc` fails the render, because the review would ask the cluster about the identity provider's subject; use `openshift` or `local` there.

Run one Studio with discovery per cluster, in a namespace only cluster admins hold RoleBindings in.
A team's own Studio runs without discovery, behind a `NamespaceDashboard` link.

### The console link

`openshift.consoleLink.enabled` renders a cluster-scoped `console.openshift.io/v1` ConsoleLink to `https://<openshiftRoute.host><config.basePath>`, so installing it needs a cluster admin; it needs `console.openshift.io/v1` (or `apis=force`) and `openshiftRoute.host`, served by this release's Route (`openshiftRoute.enabled`) or by one of its `ingress.hosts`, so the link never points at a host anyone else could claim.
Every authenticated user can read ConsoleLinks, so the chart ships no reader role and the link carries its address, its name and the chart's common labels (release name and version), never a discovered namespace.
`ApplicationMenu` lists it in the console's application launcher under `openshift.consoleLink.section`, with `openshift.consoleLink.imageUrl` as its icon.
With discovery on, that link is named `libredb-studio` and labelled `app.kubernetes.io/name: libredb-studio`, which locates the cluster's Studio; any other link is named `<namespace>.<fullname>` and carries no such label.
`NamespaceDashboard` shows the link on the dashboard of `openshift.consoleLink.namespaces` or of the namespaces `openshift.consoleLink.namespaceSelector` selects, and fails the render with neither, or with discovery on.
The OpenShift console plugin is not part of this release.

Under the OLM operator, a ConsoleLink, a discovered namespace other than the release's, the access review's ClusterRole and ClusterRoleBinding and a Rancher NavLink render only for the `LibreDBStudio` in `operator.clusterStudioNamespace`, which the operator sets to the namespace it is installed in, the only one it reconciles; elsewhere the render fails naming the value.
Studio's pod shares that namespace with the operator, so under the operator the render also fails with `serviceAccount.create=false`: the pod always runs as the ServiceAccount its release creates.

### The cluster's trusted CA bundle

`openshift.trustedCABundle.enabled` renders an empty ConfigMap labelled `config.openshift.io/inject-trusted-cabundle: "true"`, which the Cluster Network Operator fills with the cluster's trusted bundle (the proxy's `trustedCA` plus the system roots).
The chart mounts it read-only at `/etc/libredb-studio/trusted-ca` and sets `NODE_EXTRA_CA_CERTS=/etc/libredb-studio/trusted-ca/ca-bundle.crt`, so Studio trusts every CA the cluster trusts.
Choose it when the private CA is already in the cluster's trusted bundle; otherwise use the recipe in [Trusting a private CA](#trusting-a-private-ca).
The two do not combine: `NODE_EXTRA_CA_CERTS` takes one file, so the render fails when `extraEnv` also sets it.
Studio refuses to boot while `NODE_EXTRA_CA_CERTS` names a file that is missing, unreadable, empty, whitespace only or holds no PEM certificate, so a first start that races the injection exits and the restart picks the bundle up.
That boot check is application code that needs an application release after 1.1.0; with the default `appVersion` 1.1.0 the bundle is mounted, but a first start that races the injection runs without it, with no error, and nothing restarts the pod on its own: run `oc rollout restart` on the Deployment once the ConfigMap holds `ca-bundle.crt`.

### Topology

`openshift.topology.partOf` sets `app.kubernetes.io/part-of`, and `openshift.topology.runtime` sets `app.openshift.io/runtime`, the node icon.
Both land on every Deployment the chart renders and on its pod template; empty renders no label.
In a Helm install the console's Topology view groups the workloads by the Helm release, not by `app.kubernetes.io/part-of`: the part-of value appears only as an application in the Application selector.
The bundled PostgreSQL carries the same label through the subchart's own `postgresql.commonLabels`, for example `--set 'postgresql.commonLabels.app\.kubernetes\.io/part-of=libredb'`.
With `postgresql.enabled` the Studio Deployment also carries `app.openshift.io/connects-to` naming the PostgreSQL StatefulSet, so Topology draws the arrow from Studio to its storage database.

### GitOps and offline rendering

`helm template` without a cluster cannot detect OpenShift, so set both switches explicitly:

```bash
helm template studio libredb/libredb-studio \
  --set global.compatibility.openshift.apis=force \
  --set global.compatibility.openshift.adaptSecurityContext=force \
  --set openshiftRoute.enabled=true
```

`apis=force` treats every OpenShift API as served for the OpenShift objects; `adaptSecurityContext=force` drops the fixed IDs.

### Checking an install

`helm test studio` runs one pod that asks `/api/db/health` through the Service, with the Deployment's image, security context, pull secrets, scheduling and resources.

## Deployment under a subpath

Build a custom image with `docker build --build-arg BASE_PATH=/tools/libredb ...`, then set
`config.basePath: /tools/libredb` and the matching image repository/tag. This prefixes the default
startup, readiness and liveness probes. It does not change routes in an already-built image.
Explicit custom probe paths are preserved. Set Ingress paths or HTTPRoute matches to the same
prefix and preserve it when forwarding; do not strip or rewrite it.

See [subpath deployment](https://github.com/libredb/libredb-studio/blob/main/docs/SUBPATH.md)
for complete build, reverse-proxy and OIDC examples.
