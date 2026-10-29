# LibreDB Studio on OpenShift

## Sign-in with the OpenShift OAuth server

With `NEXT_PUBLIC_AUTH_PROVIDER=openshift`, people sign in to Studio with their OpenShift account, through the cluster's built-in OAuth server.
Studio runs the authorization code flow with PKCE (S256) and a signed state, with its own ServiceAccount as the OAuth client, and asks for exactly the scope `user:info user:check-access`.
The OAuth server is not an OpenID Connect provider, so this mode is separate from `oidc` ([docs/OIDC.md](OIDC.md)).

### Requirements

- OpenShift 4.14 or later, signing in through its built-in OAuth server (an identity provider such as htpasswd, LDAP or a GitHub or OIDC provider configured in the cluster's OAuth resource is fine).
- A cluster that uses direct external OIDC authentication has no built-in OAuth server, and this mode cannot run there: Studio answers `openshift_external_oidc` and the cluster's own identity provider should be used through [OIDC sign-in](OIDC.md) instead.
- One Studio replica: the signed-in users' tokens live in the memory of the Studio process (see [Restart and replicas](#restart-and-replicas)).
- The Helm chart does not render this mode yet, so the ServiceAccount annotations, the projected volume and the variables below are set on the release by hand.

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
| `openshift_config` | A variable above is invalid, the token file or CA file cannot be read, the session secret is missing, or the OAuth metadata failed a check. The server log names the variable or the failed metadata field. |
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

The exporter, its RBAC, the contract per kind and the checks it runs are in [docs/SEED_CONNECTIONS.md](SEED_CONNECTIONS.md#platform-discovery-kubernetes).
