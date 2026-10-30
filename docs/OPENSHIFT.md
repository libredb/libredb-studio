# LibreDB Studio on OpenShift

On OpenShift, Studio installs through its operator from the community catalog or with its Helm chart, signs people in with their OpenShift account, lists the databases of the cluster's database operators, and links itself from the web console.
This release ships no OpenShift console plugin.

## Supported versions

- The chart's openshift mode, the operator installed from OperatorHub (OLM v0), the console link and openshift sign-in are tested on OpenShift 4.22 (CRC 4.22.14).
  OLM v1 installs the operator only where the `NewOLMOwnSingleNamespace` feature gate is on, which OpenShift 4.19 to 4.22 enable only in the TechPreviewNoUpgrade and DevPreviewNoUpgrade feature sets; that path has not run (see [OLM v1](#olm-v1)).
- The operator bundle declares OpenShift 4.16 as its oldest release; 4.14 and 4.15 are untested.
- Sign-in with OpenShift accounts needs the cluster's built-in OAuth server.
  A cluster that uses direct external OIDC authentication has none: there, Studio signs people in with [OIDC sign-in](OIDC.md) against the cluster's identity provider, without Kubernetes discovery, because on a cluster that serves `config.openshift.io/v1` the access review of an OIDC session denies every request, and the chart refuses discovery with `authProvider=oidc`.
- The calls of openshift sign-in never go through a proxy (see [Variables](#variables)), so the operator does not declare itself proxy-aware.
  Its other `features.operators.openshift.io` annotations are false as well: no disconnected install, no FIPS build, no cluster TLS profile and no cloud token authentication ([DISTRIBUTION.md](DISTRIBUTION.md#openshift-operator-operatorhub)).

## Install from OperatorHub

A cluster admin installs the operator once per cluster, into the namespace of the cluster's Studio, and creates one `LibreDBStudio` there.
The operator manages only its own namespace: it reconciles the `LibreDBStudio` there and no other.

1. Install **LibreDB Studio** (package `libredb-studio-operator`) from the Community catalog in the console's OperatorHub, or from the CLI.
   Its only install mode is **A specific namespace on the cluster**.
   Keep **Operator recommended Namespace** at `libredb-studio`, which the console creates when it does not exist, and choose Manual approval, as [Upgrading the operator](#upgrading-the-operator) explains.
   When the form says that the namespace already exists and will be used, check it as step 2 shows before you install, or pick another name.
   From the CLI, as a cluster admin, create the namespace, an OperatorGroup for it and a Subscription in it:

   ```sh
   oc create namespace libredb-studio
   ```

   ```yaml
   apiVersion: operators.coreos.com/v1
   kind: OperatorGroup
   metadata:
     name: libredb-studio
     namespace: libredb-studio
   spec:
     targetNamespaces:
       - libredb-studio
   ---
   apiVersion: operators.coreos.com/v1alpha1
   kind: Subscription
   metadata:
     name: libredb-studio-operator
     namespace: libredb-studio
   spec:
     name: libredb-studio-operator
     channel: alpha
     source: community-operators
     sourceNamespace: openshift-marketplace
     installPlanApproval: Manual
   ```

   `oc create namespace` fails when the namespace already exists; do not reuse an existing one, because any user may request a project, and the user who requested it administers it.
   With Manual approval, OLM installs nothing until the first InstallPlan is approved as well:

   ```sh
   oc -n libredb-studio get installplan
   oc -n libredb-studio patch installplan <name> --type merge -p '{"spec":{"approved":true}}'
   ```

2. Check that only cluster admins may write in the namespace:

   ```sh
   oc get rolebindings -n libredb-studio
   oc get namespace libredb-studio -o jsonpath='{.metadata.annotations.openshift\.io/requester}'
   ```

   Only the default ServiceAccount bindings and the ones OLM made for the operator should be listed, and the second command should print nothing: a project a user requested names that user, and that user administers it.
   RoleBindings do not show a ClusterRoleBinding that gives a group `edit` or `admin` in every namespace, so check who may write there as well:

   ```sh
   oc adm policy who-can create pods -n libredb-studio
   oc adm policy who-can update secrets -n libredb-studio
   ```

   Only cluster admins, the operator's service account and system accounts should be named.
3. Create one `LibreDBStudio` in that namespace with openshift-mode values, and keep its RoleBindings to cluster admins only (see [The cluster Studio namespace](#the-cluster-studio-namespace)).
   The spec takes the chart's values, which the [chart README](../charts/libredb-studio/README.md#openshift-sign-in) documents:

   ```yaml
   apiVersion: studio.libredb.org/v1alpha1
   kind: LibreDBStudio
   metadata:
     name: studio
     namespace: libredb-studio
   spec:
     authProvider: openshift
     openshiftRoute:
       enabled: true
       host: studio.apps.example.com
     discovery:
       kubernetes:
         enabled: true
         namespaces: [team-a, team-b]
         kinds: [cnpg]
     openshift:
       consoleLink:
         enabled: true
   ```

   Under the operator, a Studio admin is whoever may `update` this `LibreDBStudio`.

The operator reconciles only the `LibreDBStudio` resources of its own namespace.
A resource in any other namespace gets no status, no finalizer and no objects, and deleting it completes at once.
Any user who may edit a namespace may still create one, because OLM adds the kind to the default `edit` and `admin` roles; the operator ignores it.
A team's own Studio is a [Helm install](#install-with-helm) in the team's namespace.
The resource cannot move the operator to another namespace: the operator sets `operator.managed` and `operator.clusterStudioNamespace`, its own namespace, over the resource's spec.
It still chooses the namespaces discovery covers, which is why the next section keeps the namespace to cluster admins.

Installing the operator is a cluster admin's act, done once, into that one namespace, and the cluster keeps one install:

```sh
oc get csv -A | grep libredb-studio-operator
```

This should list one namespace, the operator's.
OLM lets anyone who may edit a namespace create a Subscription there, and where an OperatorGroup in that namespace names no `serviceAccountName`, OLM installs the subscribed operator with every right its CSV asks for, this one's cluster-wide rights included.
So an OperatorGroup in a namespace that users other than cluster admins edit names a `serviceAccountName`, whose rights then bound what OLM installs there.

### The cluster Studio namespace

The cluster Studio namespace is also the operator's namespace, so whoever may write in it controls what the operator does in the cluster.
Whoever may edit the `LibreDBStudio` there chooses the namespaces Studio discovers and is a Studio admin, and the operator carries out that choice with its own service account.
So only cluster admins may hold RoleBindings in that namespace: the operator's limits rest on it.
Create it with the console's recommended namespace or with `oc create namespace` as a cluster admin, never through a project request, since the user who requests a project administers it; a namespace that already existed needs its RoleBindings and requester checked first, as step 2 shows.
Run the one Studio with discovery there.

### What the operator may do

The operator applies the `LibreDBStudio` as a Helm release with its own service account.
In its own namespace, a Role lets it:

- create, read, change and delete Secrets, ConfigMaps, Services, ServiceAccounts, Pods, PersistentVolumeClaims, Endpoints, Deployments, StatefulSets, DaemonSets, ReplicaSets, Ingresses, NetworkPolicies, HorizontalPodAutoscalers, PodDisruptionBudgets, Jobs, CronJobs, Gateway API HTTPRoutes, the monitoring ServiceMonitors and PrometheusRules, and the `LibreDBStudio` resources with their status;
- create, read, change and delete `route.openshift.io` Routes, and `create` and `update` on `routes/custom-host`, so the resource's Route may carry the host it sets;
- `create` Events.

Across the cluster, a ClusterRole lets it:

- create, read, change and delete Roles and RoleBindings, which discovery renders in each discovered namespace;
- `get` Secrets and Services, and `get`, `list` and `watch` the four kinds discovery lists, because Kubernetes lets the operator create the exporter's Roles only with verbs it holds itself;
- create, read, change and delete the cluster-scoped `console.openshift.io` ConsoleLinks;
- `get` Namespaces.

Outside its namespace the operator can create no workload, Service, Secret, ConfigMap, NetworkPolicy, Route or Job, and it can neither list nor watch Secrets.
Its roles hold no ClusterRole, ClusterRoleBinding or ConsolePlugin rule, so a resource with `accessReview.enabled` or a Rancher NavLink fails to reconcile.
Its service account creates token and subject access reviews only through the metrics auth role that guards its metrics endpoint.

### Upgrading the operator

With Automatic approval, the console's default, OLM upgrades the operator as soon as a release reaches the channel, before an admin can check the resources it already runs.
So install with Manual approval (`installPlanApproval: Manual`, or Manual in the console's install form), and before approving an upgrade's InstallPlan, as in step 1, check every `LibreDBStudio` against the upgrade checks in [DISTRIBUTION.md](DISTRIBUTION.md#openshift-operator-operatorhub):

```sh
oc get libredbstudios -A
```

- A `postgresql` key outside the operator's allow-list is dropped, and with `postgresql.backup.enabled` the backup CronJob and its PersistentVolumeClaim go with it, dumps included: copy the dumps out first.
- Clear `postgresql.extraDeploy`, `postgresql.namespaceOverride`, `postgresql.metrics.serviceMonitor.namespace` and `postgresql.metrics.prometheusRule.namespace` first, or on OpenShift 4.16 the resource stops reconciling and its delete never completes.
- The bundled PostgreSQL's ServiceMonitor and PrometheusRule move into the resource's namespace, so a monitoring stack that selected them in another namespace must select that one.

### Moving from operator 1.1.0

Operator 1.1.0 installs for all namespaces, in `openshift-operators`, and OLM cannot move an install to another install mode.
An upgrade InstallPlan for a later version applies the new CRD and CSV, but the new CSV fails with the reason `UnsupportedOperatorGroup` and 1.1.0 keeps running; installing the new version in another namespace while 1.1.0 is installed fails as well.
So 1.1.0 is uninstalled first, keeping its resources, each team's `LibreDBStudio` becomes a Helm release, and the new version is installed for the namespace of the cluster's Studio.
This procedure follows from OLM's and the operator's behaviour and has not yet run end to end on a cluster.

1. List the resources:

   ```sh
   oc get libredbstudios -A
   ```

   The cluster's Studio is the one in the namespace only cluster admins write; the others are team Studios.
2. Approve no InstallPlan of the new version, and install it in no other namespace yet.
   An approved InstallPlan, which Automatic approval approves at once, applies the new CRD even though the new CSV shows `Failed`, and so does an install in another namespace: 1.1.0 then runs on under the new CRD, so make the [upgrade checks](#upgrading-the-operator) on every resource at once, copying backup dumps out first.
   Then go on with step 3.
3. Uninstall 1.1.0 and keep its resources: in Installed Operators in `openshift-operators`, Uninstall Operator, with "Delete all operand instances for this operator" left unchecked, its default.
   From the CLI, delete the Subscription and every `libredb-studio-operator` CSV in `openshift-operators`:

   ```sh
   oc delete subscription libredb-studio-operator -n openshift-operators
   oc get csv -n openshift-operators -o name | grep libredb-studio-operator | xargs oc delete -n openshift-operators
   ```

   Keep the CRD: deleting it deletes every `LibreDBStudio` and what each one owns.
   The Studios keep running, and nothing reconciles them until step 5.
4. Move each team Studio to a Helm release of the same name in the same namespace.
   Helm applies a release with the rights of whoever runs it, and the values file is the resource's spec, which anyone who may edit the namespace wrote, so the team runs these commands with its own rights, never a cluster admin.
   First a cluster admin removes what the release placed outside the team's namespace, which the team's rights cannot change: the discovery Roles and RoleBindings in other namespaces, the ConsoleLink, and what `postgresql.extraDeploy`, `postgresql.namespaceOverride` or the `postgresql.metrics` ServiceMonitor and PrometheusRule namespaces put elsewhere, each named in its `meta.helm.sh/release-name` and `meta.helm.sh/release-namespace` annotations; a PostgreSQL moved to another namespace holds the team's data, so its data is copied out first.
   Then a user with `edit` or `admin` in the team's namespace runs:

   ```sh
   oc patch libredbstudio <name> -n <namespace> --type merge -p '{"metadata":{"finalizers":null},"spec":{"postgresql":{"extraDeploy":null,"namespaceOverride":null,"metrics":{"serviceMonitor":{"namespace":null},"prometheusRule":{"namespace":null}}}}}'
   oc get libredbstudio <name> -n <namespace> -o jsonpath='{.spec}' > <name>-values.json
   oc delete libredbstudio <name> -n <namespace> --cascade=orphan
   helm upgrade <name> libredb/libredb-studio --version 0.1.117 -n <namespace> -f <name>-values.json --set discovery.kubernetes.enabled=false --set openshift.consoleLink.enabled=false
   ```

   The patch removes the finalizer while nothing reconciles, so the operator cannot add it back, and clears the four values the new CRD refuses in the same write, since on OpenShift 4.16 a resource that still holds one takes no write once the new CRD is applied; add to it any `route` entry the new CRD refuses.
   The orphaning delete then leaves the Studio's objects and its data claim in place, and Helm upgrades the same release, whose objects already carry Helm's ownership labels and annotations, because the operator installs through Helm.
   The two `--set` flags keep the release to the team's namespace: a team Studio discovers no other namespace and renders no ConsoleLink.
5. Install the new version for a specific namespace, as [Install from OperatorHub](#install-from-operatorhub) shows; the install applies the new CRD, so make the [upgrade checks](#upgrading-the-operator) on the cluster's Studio first.
   Prefer the recommended `libredb-studio` with a new `LibreDBStudio` there, moving the old cluster Studio to Helm as in step 4, since an existing namespace's RoleBindings and requester show only who may write there now.
   Keep the namespace that holds the old cluster Studio only when it has been one only cluster admins write since it was created: the operator then takes the existing resource over in place, the same release name and history in that namespace, upgraded to the new chart at its first reconcile.
6. A `LibreDBStudio` left in another namespace is ignored.
   One that still carries the 1.1.0 finalizer blocks its own deletion, and its namespace's, until the finalizer is removed as in step 4.

### OLM v1

OLM v1 installs a bundle whose only install mode is OwnNamespace only behind the `NewOLMOwnSingleNamespace` feature gate.
OpenShift 4.19 to 4.22 enable it only in the TechPreviewNoUpgrade and DevPreviewNoUpgrade feature sets, and 4.18 does not define it.
Where it is on, a `ClusterExtension` from a `ClusterCatalog` installs the bundle with `spec.config.inline.watchNamespace` set to the install namespace, and a service account whose rights cover the bundle's.
This path has not run.

## Install with Helm

A cluster admin installs the chart's openshift mode with Helm as the [chart README](../charts/libredb-studio/README.md#openshift-sign-in) shows, from the repository `https://libredb.org/libredb-studio/` or from `oci://ghcr.io/libredb/charts/libredb-studio`.
The chart refuses openshift mode until `image.tag` names a release after 1.1.0, while its `appVersion` is 1.1.0 or earlier.
Discovery of other namespaces creates Roles there and a ConsoleLink is cluster-scoped, so such an install needs a cluster admin, and the [cluster Studio namespace](#the-cluster-studio-namespace) rule applies to the release's namespace.
Teams install their own Studio this way, in their own namespace and with their own rights; it discovers no other namespace and renders no ConsoleLink.

The console's Helm catalog lists the chart once its repository is added.
Anyone with `edit` in a namespace may add it for that namespace with a ProjectHelmChartRepository, and a cluster admin for every namespace with a cluster-scoped HelmChartRepository of the same `spec`:

```yaml
apiVersion: helm.openshift.io/v1beta1
kind: ProjectHelmChartRepository
metadata:
  name: libredb
  namespace: team-a
spec:
  name: LibreDB
  connectionConfig:
    url: https://libredb.org/libredb-studio/
```

The chart then appears under Helm Charts in the console's software catalog, with its README and a values form.

## Links from the web console

With `openshift.consoleLink.enabled`, the console links to Studio; the [chart README](../charts/libredb-studio/README.md#the-console-link) has the values.

- An `ApplicationMenu` ConsoleLink lists Studio in the console's application launcher, under the section `LibreDB` by default, and opens it in a new tab, leaving the console tab as it was.
- A `NamespaceDashboard` ConsoleLink shows on the dashboard of the namespaces it names or selects, and nowhere else.
  It is for a team's Studio without discovery; with discovery on, the chart refuses it and renders the `ApplicationMenu` link named `libredb-studio` that locates the cluster's Studio.
- Every authenticated user may read every ConsoleLink, so a link carries Studio's address and name and never a discovered namespace.
- Under the operator there is only the cluster's Studio; a team's `NamespaceDashboard` link is a Helm install by a cluster admin.

A signed-out visit from the link goes to the cluster's login page, which may ask for the OpenShift password again even when the console tab is signed in (it does with htpasswd): the OAuth server keeps no login session that another client could reuse, while an identity provider that signs people in on its own page may keep one.
Studio never asks for a password of its own in this mode.

## Sign-in with the OpenShift OAuth server

With `NEXT_PUBLIC_AUTH_PROVIDER=openshift`, people sign in to Studio with their OpenShift account, through the cluster's built-in OAuth server.
Studio runs the authorization code flow with PKCE (S256) and a signed state, with its own ServiceAccount as the OAuth client, and asks for exactly the scope `user:info user:check-access`.
The OAuth server is not an OpenID Connect provider, so this mode is separate from `oidc` ([docs/OIDC.md](OIDC.md)).

### Requirements

- OpenShift 4.16 or later ([Supported versions](#supported-versions)), signing in through its built-in OAuth server (an identity provider such as htpasswd, LDAP or a GitHub or OIDC provider configured in the cluster's OAuth resource is fine).
- A cluster that uses direct external OIDC authentication has no built-in OAuth server, and this mode cannot run there: Studio answers `openshift_external_oidc` and the cluster's own identity provider should be used through [OIDC sign-in](OIDC.md) instead.
- One Studio replica: the signed-in users' tokens live in the memory of the Studio process (see [Restart and replicas](#restart-and-replicas)).
- The Helm chart renders this mode with `authProvider: openshift` ([chart README](../charts/libredb-studio/README.md#openshift-sign-in)), and so does the operator for a `LibreDBStudio` ([Install from OperatorHub](#install-from-operatorhub)): both write the ServiceAccount annotations, the projected volume and the variables below.

### The OAuth client: Studio's ServiceAccount

OpenShift lets a ServiceAccount act as an OAuth client.
Its client id is `system:serviceaccount:<namespace>:<ServiceAccount name>`, and its redirect URI comes from two annotations on the ServiceAccount:

```yaml
metadata:
  annotations:
    serviceaccounts.openshift.io/oauth-redirectreference.first: '{"kind":"OAuthRedirectReference","apiVersion":"v1","reference":{"kind":"Route","name":"<Studio Route>"}}'
    serviceaccounts.openshift.io/oauth-redirecturi.first: api/auth/openshift/callback
```

With a base path, the second annotation is the callback path under it without the leading slash, such as `studio/api/auth/openshift/callback`.
Studio answers the callback at that exact path only: a code delivered to any longer path under it gets a 404.

The client secret is a ServiceAccount token.
Mount a projected `serviceAccountToken` with an audience of its own, such as `libredb-studio-oauth-client`, never the API server's audience, with `expirationSeconds` of at least 600, and name the file in `OPENSHIFT_OAUTH_TOKEN_FILE`.
Studio reads the file again at every sign-in, so a rotated token is used at once.

### Variables

The chart and the operator write these from their values; set them by hand only for an install that uses neither.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_AUTH_PROVIDER` | Yes | `local` | `openshift` turns this mode on. It is read when the server starts, and any value other than `local`, `oidc`, `openshift` or unset stops the server at boot. |
| `OPENSHIFT_OAUTH_CLIENT_ID` | Yes | | `system:serviceaccount:<namespace>:<name>` of Studio's ServiceAccount. |
| `OPENSHIFT_PUBLIC_URL` | Yes | | The https URL people open Studio at, the Route host plus the base path when the build has one. The OAuth `redirect_uri` and every redirect of this mode are built from it, never from request headers. |
| `OPENSHIFT_OAUTH_TOKEN_FILE` | Yes | | The projected token file Studio presents as its client secret. |
| `OPENSHIFT_API_URL` | No | `https://kubernetes.default.svc` | The API server Studio reads the OAuth metadata and the signed-in user from. |
| `OPENSHIFT_API_CA_FILE` | No | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | The CA file of the API server, the `ca.crt` key of the `kube-root-ca.crt` ConfigMap. |
| `AUTH_SESSION_TTL_SECONDS` | No | `28800` in this mode | The session lifetime, capped by the access token's own expiry. |
| `KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT` | One of the two | | Studio's Deployment as `<namespace>/<name>`, for a Helm install: whoever may update it is a Studio admin. |
| `KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO` | One of the two | | Studio's LibreDBStudio resource as `<namespace>/<name>`, for an operator install. |

Studio reads the OAuth metadata from the API server's `/.well-known/oauth-authorization-server`, checks that the issuer is https and that both endpoints are on the issuer's origin, and caches it for five minutes.
Every call to the API server trusts the `OPENSHIFT_API_CA_FILE` certificates only.
The token call to the OAuth route trusts Node's bundled roots, the `NODE_EXTRA_CA_CERTS` file and the `OPENSHIFT_API_CA_FILE` certificates, because the route's certificate may come from the cluster's ingress CA or a corporate one.
No call of this mode goes through a proxy, whatever `HTTPS_PROXY` and `NODE_USE_ENV_PROXY` say.

The server refuses to boot in this mode when a variable above is invalid, the token file is missing, unreadable or empty, the CA file holds no certificate, or any of `ADMIN_PASSWORD`, `USER_PASSWORD`, `OIDC_ROLE_CLAIM`, `OIDC_ADMIN_ROLES`, `OIDC_USER_ROLES` or `OIDC_ROLE_PREFIX` is set, or `LIBREDB_MCP_ENABLED` or `LIBREDB_AGENT_ENABLED` is switched on.
It also refuses to boot in `local` or `oidc` mode when `OPENSHIFT_OAUTH_CLIENT_ID`, `OPENSHIFT_OAUTH_TOKEN_FILE` or `OPENSHIFT_PUBLIC_URL` is set, because whoever set them meant this mode.

### Signing in

A signed-out visit to Studio goes straight to the cluster's login page, and the password is asked on every sign-in: the OAuth server does not keep a session Studio could reuse.
The first time a user signs in, OpenShift shows its Authorize Access page with two checkboxes, `user:info` and `user:check-access`; both must stay checked.
The choice is remembered per user, so the page does not appear again.
A user who unchecked one is refused with `openshift_scope`, and the page may not come back on its own: an administrator resets the choice by deleting the user's OAuth client authorization.

```sh
oc delete oauthclientauthorization <user>:system:serviceaccount:<namespace>:<ServiceAccount name>
```

Virtual accounts such as `kube:admin` and `system:admin` cannot sign in: the cluster gives them no user id, and Studio keys every session by it.

Every user signs in with the `user` role in this release.
No role comes from OpenShift groups, an identity provider claim, a request header or a cookie field.

### Sessions and sign-out

A session lasts 8 hours by default, or the `AUTH_SESSION_TTL_SECONDS` value, and never longer than the access token the cluster issued.
The access token lives only in the Studio process's memory, in a record keyed by a random handle that the signed session cookie carries; it never reaches a cookie, a log, an audit record, storage or a response.
A session whose record is gone reads as signed out.

Sign-out ends the record and the session at once, so a copied session cookie stops working, and sends nothing to the cluster.
The access token itself stays valid at the API server until it expires, after the cluster's `accessTokenMaxAgeSeconds` (a year on some clusters), but it can only read the user's own name and ask the API server what the user may do.
A user revokes it with `oc delete useroauthaccesstoken <name>` or on the console's API tokens page, `<name>` being `sha256~` followed by the unpadded base64url SHA-256 of the token without its `sha256~` prefix.

Server storage (saved connections and preferences with a server storage provider) is filed under the user's uid, not the user name.
A user deleted and re-created under the same name starts over, and rows filed under a user name in an earlier sign-in mode are not carried over.

MCP and the agent are off in this mode, whatever their switches say, because their credentials cannot carry the user's cluster sign-in.
Password sign-in is off as well: `POST /api/auth/login` answers 403.

### Restart and replicas

A restart empties the token records, so every signed-in user meets the cluster's login page once on their next action.
If a record goes missing again right after the sign-in that wrote it, Studio stops on its own login page with `openshift_session_lost` instead of sending the browser around again.
That happens when Studio runs as more than one replica, because each replica holds its own records: run one.

### Troubleshooting

Every refused sign-in lands on the login page with one of these codes, which the audit trail records as the `login_failure` reason.

| Code | Cause and fix |
| --- | --- |
| `openshift_config` | A variable above is invalid, the token file or CA file cannot be read, the session secret is missing, or the OAuth metadata failed a check. The server log names the variable for a CA file it cannot use and the check for metadata that failed one; for any other cause it names no variable: the login step logs that sign-in is not configured correctly, and the callback that the client secret file cannot be read or that sign-in failed for a configuration reason (`reason: config`), so check the variables, the token file and the session secret. |
| `openshift_unreachable` | The API server or the OAuth route did not answer: a network or DNS failure, a deadline, a TLS failure (the log says `tls`: check `OPENSHIFT_API_CA_FILE`, and `NODE_EXTRA_CA_CERTS` for the OAuth route), or a 3xx or 5xx answer. |
| `openshift_external_oidc` | The cluster answers 404 for the OAuth metadata or for users/~, so it uses direct external OIDC authentication. Use OIDC sign-in instead. |
| `openshift_state_missing` | The callback arrived without the state cookie, for example in another browser or after more than five minutes. Sign in again. |
| `openshift_state_invalid` | The state cookie did not verify or had expired, or the callback came from an older sign-in of another tab. Sign in again. |
| `openshift_denied` | The user pressed Deny on the Authorize Access page. |
| `openshift_scope` | The user unchecked a permission on the Authorize Access page. Delete the user's OAuth client authorization (see above) and sign in again with both checked. |
| `openshift_no_uid` | users/~ gave no user id or a `system:` name, as for `kube:admin`. Sign in with a regular user. |
| `openshift_no_access` | The account was refused access to this Studio: `KUBERNETES_ACCESS_REVIEW_SIGN_IN` is set and its review, made with the user's own token, did not allow them. |
| `openshift_failed` | Anything else, such as a code the OAuth server refused or a token answer Studio could not use. Sign in again; the server log names the step. |
| `openshift_session_lost` | The loop guard tripped: the session's token record went missing twice in a row. Check that Studio runs as one replica. |

A query that fails with a JSON parse error after about 30 seconds was cut by the router, which answers with its own 504 page instead of Studio's JSON: raise `openshiftRoute.timeout` above the largest query timeout, as the [chart README](../charts/libredb-studio/README.md#exposing-studio-on-openshift) says.

## Database access and Studio admins

In this mode Studio decides who may use a database it discovered in the cluster, and who is a Studio admin, by asking the cluster with the signed-in user's own token.
Every such request is a SelfSubjectAccessReview the sign-in scope `user:check-access` allows, so Studio's ServiceAccount needs no review rights at all in this mode.

- A discovered database is listed and opened only for a user whose own RBAC allows `get` on the Secret its credentials come from, the same answer `oc auth can-i get secret/<name> -n <namespace>` gives that user.
- A Studio admin is a user whose own RBAC allows `update` on Studio's Deployment (`KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT`, a Helm install) or on its LibreDBStudio resource (`KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO`, an operator install); exactly one of the two is set.
  It is checked again on every request of an admin session, so no group, claim or password makes an admin.
- Removing a RoleBinding takes effect within 15 seconds, the review's cache lifetime in this mode, and an open tab drops a database at its next refresh, every 10 seconds by default.
- Deleting a user's Studio token (`oc delete useroauthaccesstoken` for the user's own, `oc delete oauthaccesstoken` for a cluster admin, or the console's API tokens page) makes the API server refuse it: Studio ends that session at its next request, and the user signs in again through the cluster's login page.
- The API server caches token authentication, groups included, for up to about two minutes, so a group-membership change or a deleted OAuth access token can keep answering for that long, while a RoleBinding change takes effect within Studio's decision cache.
  Studio cannot shorten the platform's cache; to cut a user off at once, remove the RoleBinding that grants them.

The review is always on in this mode; setting `KUBERNETES_ACCESS_REVIEW` to `off` stops the server at boot, and so does `KUBERNETES_ACCESS_REVIEW_API_URL`, `KUBERNETES_ACCESS_REVIEW_TOKEN_PATH` or `KUBERNETES_ACCESS_REVIEW_CA_PATH`, which only configure the review of OIDC mode.
[SEED_CONNECTIONS.md](./SEED_CONNECTIONS.md#on-openshift-openshift-sign-in) has the detail: which failures deny, what is logged, and the known limits.

## Supported database operators

Studio's Kubernetes discovery lists the databases of four operators as managed connections, read by an exporter with a ServiceAccount of its own, so Studio's pod never holds a token that can read a database Secret.

| Operator | Kind in `KUBERNETES_DISCOVERY_KINDS` | Resource | TLS |
| --- | --- | --- | --- |
| CloudNativePG | `cnpg` (the default) | `postgresql.cnpg.io/v1` `Cluster` | `require` |
| EDB Postgres for Kubernetes | `edbpg` | `postgresql.k8s.enterprisedb.io/v1` `Cluster` | `require` |
| Crunchy PGO | `pgo` | `postgres-operator.crunchydata.com/v1beta1` `PostgresCluster` | `require` |
| MongoDB Community | `mongo` | `mongodbcommunity.mongodb.com/v1` `MongoDBCommunity` | `require` when `spec.security.tls.enabled` is true, else `disable` |

CloudNativePG alone is discovered by default; each other kind is opt-in, because a kind whose CRD the cluster does not serve withdraws every discovered namespace.
Name only the operators the cluster runs, and every operator kind that runs in a discovered namespace.
The PostgreSQL rows encrypt without verifying the server's certificate, because each operator signs it with a CA of its own whose Secret also holds the CA's private key; Crunchy PGO refuses a connection without TLS.
The EDB row was checked against the discovery contract and its tests, but not run on a live EDB cluster.
For each opted-in kind the exporter's Role needs `list` on that kind, `get` on `secrets`, which it requests only by name, and `get` on `services`, in each discovered namespace.
MongoDB Controllers for Kubernetes 1.14.0, which serves the `MongoDBCommunity` kind on OpenShift, needs a ServiceAccount named `mongodb-kubernetes-appdb` in each namespace that holds a `MongoDBCommunity`, and its OLM install does not create one: `oc create serviceaccount mongodb-kubernetes-appdb -n <namespace>`.

The exporter, its RBAC, the contract per kind and the checks it runs are in [docs/SEED_CONNECTIONS.md](SEED_CONNECTIONS.md#platform-discovery-kubernetes).

## Browsing the cluster with the Kubernetes provider

To browse the cluster itself with the Kubernetes provider, as a seeded connection or as a connection of one's own where custom connections are allowed, give it a ServiceAccount token bound to `view` or a reader role, as [the Kubernetes provider](providers/kubernetes.md#45-a-serviceaccount-token-view-and-studio-reader) shows.
Never paste a personal `sha256~` token, such as `oc whoami -t` prints: it carries every right of that user, stays valid until the cluster expires it, and is saved with the connection.

## Running the image with an arbitrary user id

OpenShift runs Studio's image with an arbitrary user id whose group is 0, and the image is built for it.
With Docker, `--user <uid>:0` does the same, with one trap: a named volume that a start as root used first is owned by `nextjs:nodejs` afterwards, because the entrypoint hands the data directory to that user before it drops root, so a later `--user <uid>:0` start on the same volume fails with `EACCES`.
Use a new volume for the arbitrary user, or give group 0 the owner's access first:

```sh
docker run --rm -v <volume>:/app/data --entrypoint sh ghcr.io/libredb/libredb-studio:latest \
  -c 'chgrp -R 0 /app/data && chmod -R g=u /app/data'
```

## Uninstall

Delete the `LibreDBStudio` in the operator's namespace first and uninstall the operator after it: the operator's finalizer uninstalls the resource's release, its ConsoleLink and the Roles in the discovered namespaces with it, and without the operator the resource's deletion, and its namespace's, never completes.
Resources in other namespaces carry no finalizer of this operator, except ones left from 1.1.0 (see [Moving from operator 1.1.0](#moving-from-operator-110)).
Remove the Subscription and the CSV only once the second `get` lists nothing:

```sh
oc get libredbstudios -n libredb-studio
oc delete libredbstudios --all -n libredb-studio --wait
oc get libredbstudios -n libredb-studio
oc delete subscription libredb-studio-operator -n libredb-studio
oc get csv -n libredb-studio -o name | grep libredb-studio-operator | xargs oc delete -n libredb-studio
```

The console's Uninstall Operator action in Installed Operators in that namespace replaces the last two commands.
OLM leaves the CRD and the four ClusterRoles it generated for the kind (`libredbstudios.studio.libredb.org-v1alpha1-admin`, `-edit`, `-view` and `-crdview`); once no `LibreDBStudio` is left anywhere, deleting the CRD removes them too:

```sh
oc delete crd libredbstudios.studio.libredb.org
```

OLM also leaves the bundle's own ClusterRoles, which deleting the CRD does not remove:

```sh
oc delete clusterrole libredb-studio-operator-libredbstudio-admin-role libredb-studio-operator-libredbstudio-editor-role libredb-studio-operator-libredbstudio-viewer-role libredb-studio-operator-metrics-reader
```

Deleting the operator's namespace last removes its OperatorGroup with it, and the data claims below as well, so delete it only once they are no longer needed:

```sh
oc delete namespace libredb-studio
```

This release ships no console plugin, so its uninstall leaves nothing in the console's configuration.
When `libredb-studio` is listed in `spec.plugins` of `consoles.operator.openshift.io/cluster`, from a plugin enabled by hand or a release that ships one, uninstalling the operator from the CLI leaves the entry there.
A stale entry is harmless: the console stays Available and not Degraded, and the console operator logs that the plugin is not found every few seconds.
Remove it by its index in the list, `0` below; the `test` operation refuses the patch when that index holds another plugin:

```sh
oc get consoles.operator.openshift.io cluster -o jsonpath='{.spec.plugins}'
oc patch consoles.operator.openshift.io cluster --type json \
  -p '[{"op":"test","path":"/spec/plugins/0","value":"libredb-studio"},{"op":"remove","path":"/spec/plugins/0"}]'
```

A Helm install uninstalls with `helm uninstall`, which removes its ConsoleLink and the Roles in the discovered namespaces as well.

Either way, three things outlive the release.
The bundled PostgreSQL's data claims, which its StatefulSet created, stay; delete them once the data is no longer needed, `<name>` being the release name, which under the operator is the `LibreDBStudio` name:

```sh
oc delete pvc -l app.kubernetes.io/instance=<name> -n <namespace>
```

Each user's OAuth client authorization for Studio's client stays, and so do the users' Studio access tokens, which stay valid at the API server until they expire, after the cluster's `accessTokenMaxAgeSeconds`.
A cluster admin deletes both for Studio's client id, the `OPENSHIFT_OAUTH_CLIENT_ID` of its Deployment, so note it before the uninstall:

```sh
oc get oauthclientauthorizations -o jsonpath='{range .items[?(@.clientName=="system:serviceaccount:<namespace>:<ServiceAccount name>")]}{.metadata.name}{"\n"}{end}' \
  | xargs -r oc delete oauthclientauthorization
oc get oauthaccesstokens -o jsonpath='{range .items[?(@.clientName=="system:serviceaccount:<namespace>:<ServiceAccount name>")]}{.metadata.name}{"\n"}{end}' \
  | xargs -r oc delete oauthaccesstoken
```
