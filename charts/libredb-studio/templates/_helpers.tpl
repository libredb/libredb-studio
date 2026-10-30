{{/*
Expand the name of the chart.
*/}}
{{- define "libredb-studio.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
*/}}
{{- define "libredb-studio.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "libredb-studio.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "libredb-studio.labels" -}}
helm.sh/chart: {{ include "libredb-studio.chart" . }}
{{ include "libredb-studio.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "libredb-studio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "libredb-studio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "libredb-studio.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "libredb-studio.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Return the secret name (existing or generated)
*/}}
{{- define "libredb-studio.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "libredb-studio.fullname" . }}
{{- end }}
{{- end }}

{{/*
Return the configmap name
*/}}
{{- define "libredb-studio.configMapName" -}}
{{- printf "%s-config" (include "libredb-studio.fullname" .) }}
{{- end }}

{{/*
Return the PVC name (existing or generated)
*/}}
{{- define "libredb-studio.pvcName" -}}
{{- if .Values.persistence.existingClaim }}
{{- .Values.persistence.existingClaim }}
{{- else }}
{{- printf "%s-data" (include "libredb-studio.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Determine if persistence should be enabled.
Returns "true" if persistence.enabled OR storageProvider is sqlite.
*/}}
{{- define "libredb-studio.persistenceEnabled" -}}
{{- if or .Values.persistence.enabled (eq .Values.config.storageProvider "sqlite") }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Determine if strict auth mode is active (config.authBootstrap disables the
app's zero-config first run). values.schema.json accepts "", "on", "off" and
the app's isBootstrapEnabled() synonyms ("true"/"false"/"1"/"0",
case-insensitive, optionally whitespace-wrapped); this helper mirrors the
same off-synonyms so any accepted spelling - or an install that bypasses
schema validation (helm --skip-schema-validation) - stays strict in both the
chart and the app instead of splitting into a half-strict state.
*/}}
{{- define "libredb-studio.authStrict" -}}
{{- if has (.Values.config.authBootstrap | toString | trim | lower) (list "off" "false" "0") }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Determine if the local email/password provider is in use (issue #170). Only
that provider logs anybody in with ADMIN_PASSWORD: under authProvider=oidc the
app authenticates against the issuer and the password is never read, so
requiring it - or referencing it from a Secret that has no such key - would
block an OIDC install for no reason. Anything other than "local" is treated as
"not local", so an unknown provider never silently re-enables the password
requirements. JWT_SECRET is deliberately NOT scoped: both providers end up
issuing the app's own session cookie.
*/}}
{{- define "libredb-studio.localAuth" -}}
{{- if eq (.Values.authProvider | toString | trim | lower) "local" }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Return the effective storage provider.
If postgresql subchart is enabled and storageProvider is "local", auto-switch to "postgres".
*/}}
{{- define "libredb-studio.storageProvider" -}}
{{- if and .Values.postgresql.enabled (eq .Values.config.storageProvider "local") }}
{{- "postgres" }}
{{- else }}
{{- .Values.config.storageProvider }}
{{- end }}
{{- end }}

{{/*
Determine if autoscaling is effectively enabled. SQLite storage is
single-writer, so a multi-replica HPA would corrupt the shared database
file: autoscaling.enabled is ignored (the HPA is not rendered and the
deployment falls back to replicaCount) when the effective storage provider
is sqlite. NOTES.txt warns when this happens.
*/}}
{{- define "libredb-studio.autoscalingEnabled" -}}
{{- if and .Values.autoscaling.enabled (ne (include "libredb-studio.storageProvider" .) "sqlite") }}
{{- true }}
{{- end }}
{{- end }}

{{/*
The explicit agent off-switch, when the operator set one. Empty means "unset":
the chart then writes no LIBREDB_AGENT_ENABLED and the app derives availability
itself (#331 T5), which is the whole point of the derived default and the one
thing this chart must not undo by hard-coding a value.

Absent, present-but-null and a key deleted by a user's `agent: null` all land on
"unset", so the caller never has to tell those three apart.
*/}}
{{- define "libredb-studio.agentFlagSet" -}}
{{- $agent := .Values.agent | default dict }}
{{- if and (hasKey $agent "enabled") (not (kindIs "invalid" (get $agent "enabled"))) }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Whether the operator supplied a model-tuning document, from either source.

One definition for four call sites - the ConfigMap, the env var, the volume and the mount - because
the rule that either source counts is exactly the kind of condition that drifts when it is spelled
out in each place. Naming a source is what enables the feature: there is no separate flag to leave
inconsistent with it, so no values combination renders a pod that mounts a ConfigMap nobody created.
*/}}
{{- define "libredb-studio.agentTuningSet" -}}
{{- $tuning := get (.Values.agent | default dict) "modelTuning" | default dict }}
{{- if or (get $tuning "existingConfigMap") (get $tuning "document") }}
{{- true }}
{{- end }}
{{- end }}

{{/*
The file name the tuning document is mounted under, and therefore the tail of the path the app is
told to read. One definition so the ConfigMap key, the mount and the env var cannot disagree.
*/}}
{{- define "libredb-studio.agentTuningKey" -}}
{{- $tuning := get (.Values.agent | default dict) "modelTuning" | default dict }}
{{- get $tuning "configMapKey" | default "model-tuning.json" }}
{{- end }}

{{/*
Whether an agent run could start in this deployment - the chart's own, deliberately
conservative reading of the runtime's rule (a configured model plus a writable
ledger). It answers "true" only for what this chart can see in its values:

  - agent.enabled=true  -> the operator said so, model or not
  - agent.enabled=false -> never, whatever else is set
  - unset               -> true when the AI configuration in these values would
                           validate: an inline llmApiKey, or one of the providers
                           that needs no key at all

KEY-OPTIONAL PROVIDERS are taken from the app, not guessed: validateConfig
(src/lib/llm/utils/config.ts) requires an API key for "gemini" and "openai" only.
"ollama" needs neither key nor URL, and "custom" needs LLM_API_URL rather than a
key - so requiring an inline llmApiKey of either would miss a model that is fully
configured, and a multi-replica install would render and then derive an available
agent on every pod. Both therefore count on their own. Any provider added to the
llmProvider enum in values.schema.json must be classified into this list or the
one above it.

BLIND SPOTS - the complete list, because a partial one tells the reader the rest
were checked. This helper reads .Values and nothing else, so a model configured
in any of these three places passes it unseen:

  - secrets.existingSecret - a Secret the chart does not create and cannot read
  - extraEnvFrom           - envFrom sources, whose keys are not visible here
  - extraEnv               - rendered verbatim, and NOT inspected for LLM_API_KEY,
                             LLM_API_URL or LLM_PROVIDER (the one entry it does
                             look for is WORKFLOW_TARGET_WORLD, in
                             agentPostgresWorld, which is a different question)

None of the three is counted, and that is a deliberate trade rather than an
oversight: counting what cannot be read would refuse to render every existing HA
install that keeps a JWT secret in an existingSecret and configures no AI at all.
The cost is that a multi-replica release configuring its model any of those ways
needs agent.enabled=false set by hand.
*/}}
{{- define "libredb-studio.agentPossible" -}}
{{- $agent := .Values.agent | default dict }}
{{- $keyless := list "ollama" "custom" }}
{{- if include "libredb-studio.agentFlagSet" . }}
{{- if get $agent "enabled" }}{{- true }}{{- end }}
{{- else if or .Values.secrets.llmApiKey (has (.Values.config.llmProvider | toString | trim | lower) $keyless) }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Whether this release can run more than one pod. The HPA governs when it is
effectively enabled (the deployment then renders no replicas at all), so its
ceiling is the number that matters there; otherwise replicaCount is.
*/}}
{{- define "libredb-studio.multiReplica" -}}
{{- if include "libredb-studio.autoscalingEnabled" . }}
{{- if gt (int .Values.autoscaling.maxReplicas) 1 }}{{- true }}{{- end }}
{{- else if gt (int .Values.replicaCount) 1 }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Whether extraEnv selects the multi-replica durable backend. There is no values
field for it on purpose: that backend also needs WORKFLOW_POSTGRES_URL, which
belongs in a Secret and therefore in an extraEnv entry with valueFrom - so the
chart reads the operator's own entry rather than adding a second way to say it.
*/}}
{{- define "libredb-studio.agentPostgresWorld" -}}
{{- range .Values.extraEnv }}
{{- if and (eq (.name | default "") "WORKFLOW_TARGET_WORLD") (eq (.value | default "" | toString) "@workflow/world-postgres") }}
{{- true }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Whether the chart's fixed UID/GID fields must be dropped for OpenShift.
OpenShift's restricted-v2 SCC assigns runAsUser/fsGroup from a per-namespace
range, so a pod that hard-codes IDs outside that range is rejected at
admission. Controlled by global.compatibility.openshift.adaptSecurityContext
(the same contract the Bitnami postgresql subchart honours, so one value
adapts both charts): "auto" adapts when the API server exposes
security.openshift.io/v1, "force" always adapts, "disabled" never does.
*/}}
{{- define "libredb-studio.adaptOpenShiftSecurityContext" -}}
{{- $mode := dig "compatibility" "openshift" "adaptSecurityContext" "auto" (.Values.global | default dict) }}
{{- if or (eq $mode "force") (and (eq $mode "auto") (.Capabilities.APIVersions.Has "security.openshift.io/v1")) }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Whether an OpenShift API is served, for the OpenShift-only objects the chart
renders. Called as
  include "libredb-studio.openshiftApiServed" (dict "ctx" $ "api" "route.openshift.io/v1")
and returns "true" or empty. global.compatibility.openshift.apis "auto" asks
.Capabilities.APIVersions for the named API; "force" treats every OpenShift API
as served, so a GitOps or offline `helm template` with no cluster to ask can
still render the objects. Independent of adaptSecurityContext above, which
speaks only of the pod security context. Read with dig over a defaulted dict,
so a --reuse-values upgrade from a chart without the value behaves as "auto".
*/}}
{{- define "libredb-studio.openshiftApiServed" -}}
{{- $mode := dig "compatibility" "openshift" "apis" "auto" (.ctx.Values.global | default dict) }}
{{- if or (eq $mode "force") (.ctx.Capabilities.APIVersions.Has .api) }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Whether openshift.trustedCABundle is on. Read with dig over a defaulted dict,
so a --reuse-values upgrade from a chart without the openshift block renders
as off.
*/}}
{{- define "libredb-studio.trustedCABundleEnabled" -}}
{{- if dig "trustedCABundle" "enabled" false (.Values.openshift | default dict) }}
{{- true }}
{{- end }}
{{- end }}

{{/*
OpenShift Topology labels, each only when set: app.kubernetes.io/part-of names
the console's Topology application (a Helm install is still grouped by its
release) and app.openshift.io/runtime picks the node icon. Added to the metadata and pod template labels of every Deployment the
chart renders, never to a selector. A key that podLabels also sets fails the
render: the pod template would carry it twice. Read with dig over a defaulted dict, never
`with .Values.openshift.topology.partOf`, which fails on a nil openshift block
under --reuse-values.
*/}}
{{- define "libredb-studio.topologyLabels" -}}
{{- $openshift := .Values.openshift | default dict }}
{{- $podLabels := .Values.podLabels | default dict }}
{{- range $value, $label := dict "partOf" "app.kubernetes.io/part-of" "runtime" "app.openshift.io/runtime" }}
{{- with dig "topology" $value "" $openshift }}
{{- if hasKey $podLabels $label }}
{{- fail (printf "openshift.topology.%s=%s and podLabels %s=%v both set the pod label %s; set it in one place" $value . $label (get $podLabels $label) $label) }}
{{- end }}
{{ $label }}: {{ . | quote }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Pod security context with OpenShift adaptation applied: the fixed
runAsUser/runAsGroup/fsGroup are omitted so the SCC can inject range-valid
IDs (runAsNonRoot and seccompProfile are kept). The app image supports
arbitrary UIDs: all writable paths are volume mounts and the entrypoint
execs directly when not running as root.
*/}}
{{- define "libredb-studio.podSecurityContext" -}}
{{- $psc := .Values.podSecurityContext }}
{{- if include "libredb-studio.adaptOpenShiftSecurityContext" . }}
{{- $psc = omit $psc "runAsUser" "runAsGroup" "fsGroup" }}
{{- end }}
{{- toYaml $psc }}
{{- end }}

{{/*
The bind address this release pins the container to, or empty when it leaves
the choice to the image. An explicit env entry beats the same key delivered by
the ConfigMap through envFrom, so an extraEnv HOSTNAME wins over
config.bindAddress; both are read here, value included, because the value is
now what matters - empty means "the image resolves it and prefers a verified
dual-stack ::".

Blind spot, same as agentPossible: a HOSTNAME whose value the chart cannot read
at template time is invisible here, so such a release is treated as unpinned and
sees no warning. Two shapes reach that: extraEnvFrom, and an extraEnv entry using
valueFrom (a secretKeyRef or configMapKeyRef - legal, since extraEnv items are
free-form EnvVar objects). Neither is new; the key-presence check this replaced
stayed silent on them too. It is left silent rather than warned on because the
value may perfectly well be "::", and a warning aimed at a deliberate IPv4 pin
should not fire at someone who supplied the right answer through a secret. An
operator who does pin IPv4 that way keeps the diagnosis: the container prints the
address it bound and why.
*/}}
{{- define "libredb-studio.effectiveBindAddress" -}}
{{- $bind := .Values.config.bindAddress | default "" | toString | trim }}
{{- range .Values.extraEnv }}
{{- if eq (.name | default "" | toString) "HOSTNAME" }}
{{- $bind = .value | default "" | toString | trim }}
{{- end }}
{{- end }}
{{- $bind }}
{{- end }}

{{/*
Whether this release pins the container to an IPv4-only listener. True when the
effective bind address is set and carries no ":" - "0.0.0.0", "127.0.0.1" and
any other IPv4 literal - which is the one combination a dual-stack Service must
not be paired with. "::" and "::1" are IPv6 forms and are left alone, and empty
is the image-resolved default, which is dual-stack wherever the namespace
allows it.
*/}}
{{- define "libredb-studio.bindPinnedToIPv4" -}}
{{- $bind := include "libredb-studio.effectiveBindAddress" . }}
{{- if and $bind (not (contains ":" $bind)) }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Whether these values ask the Service for an IPv6 address: either a dual-stack
policy, or an explicit IPv6 entry in service.ipFamilies (which needs no policy
when it is the only family, so templates/service.yaml's guard never sees it).

Kubernetes populates the IPv6 EndpointSlice from the pod's own IPv6 address
without ever checking what the process bound, so this is the condition under
which an IPv4-only listener turns into a silent misconfiguration: a green
install whose IPv6 address refuses every connection, on a pod that - probed
only on its primary IP - stays Ready. Since chart 0.1.42 the container resolves
its own address and prefers a verified dual-stack "::", so this can only happen
when the release pins IPv4 explicitly; NOTES.txt warns about exactly that
pairing.
*/}}
{{- define "libredb-studio.serviceWantsIPv6" -}}
{{- if or (has .Values.service.ipFamilyPolicy (list "PreferDualStack" "RequireDualStack")) (has "IPv6" (default (list) .Values.service.ipFamilies)) }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Return the full image reference (repository:tag)
*/}}
{{- define "libredb-studio.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag }}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}

{{/*
Return the PostgreSQL subchart fullname.
Bitnami subchart names resources as: <release>-postgresql (not <release>-<chart>-postgresql).
*/}}
{{- define "libredb-studio.postgresql.fullname" -}}
{{- printf "%s-postgresql" .Release.Name }}
{{- end }}

{{/*
Return the PostgreSQL URL when subchart is enabled.
The subchart serves plain TCP unless postgresql.tls.enabled is set, and Studio turns
TLS on for any non-local host whose URL names no sslmode, so sign-in failed with
"server does not support SSL". sslmode=disable is written only while the subchart's
TLS is off; with it on the URL keeps no sslmode and Studio's TLS default applies.
*/}}
{{- define "libredb-studio.postgresql.url" -}}
{{- $url := printf "postgresql://%s:$(POSTGRES_PASSWORD)@%s:5432/%s" .Values.postgresql.auth.username (include "libredb-studio.postgresql.fullname" .) .Values.postgresql.auth.database }}
{{- if dig "tls" "enabled" false (.Values.postgresql | default dict) }}
{{- $url }}
{{- else }}
{{- printf "%s?sslmode=disable" $url }}
{{- end }}
{{- end }}

{{/* Prefix only the shipped health path; preserve explicit HTTP/exec/TCP probes. With `ready` set
(the readiness probe under governance) the shipped path moves to /api/ready (docs/HELM_CHART.md#11-governance). */}}
{{- define "libredb-studio.probe" -}}
{{- $probe := deepCopy .probe -}}
{{- if and $probe.httpGet (eq ($probe.httpGet.path | default "") "/api/db/health") -}}
{{- $_ := set $probe.httpGet "path" (printf "%s%s" .basePath (ternary "/api/ready" "/api/db/health" (.ready | default false))) -}}
{{- end -}}
{{- toYaml $probe -}}
{{- end -}}

{{/*
Whether this release runs Studio under governance (GOVERNANCE_SOURCE=postgres, docs/GOVERNANCE.md).
`default dict` keeps a values set that predates the block, as an upgrade with --reuse-values carries,
rendering as before.
*/}}
{{- define "libredb-studio.governanceEnabled" -}}
{{- if get (.Values.governance | default dict) "enabled" }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Whether the governance release may run more than one pod: replicaCount above 1, or autoscaling.enabled
as the operator set it. The raw value rather than autoscalingEnabled, because governance needs
PostgreSQL storage, so the sqlite exception that helper makes never applies here.
*/}}
{{- define "libredb-studio.governanceMultiReplica" -}}
{{- if or .Values.autoscaling.enabled (gt (int .Values.replicaCount) 1) }}
{{- true }}
{{- end }}
{{- end }}

{{/*
The Secret key of a governance value, `governancePostgresUrl` or `governancePrivateKeys`, as
secrets.existingSecretKeys maps it. The documented default stands in for a key the map lacks, as a
values set from before these keys carries.
*/}}
{{- define "libredb-studio.governanceSecretKey" -}}
{{- $defaults := dict "governancePostgresUrl" "governance-postgres-url" "governancePrivateKeys" "governance-private-keys" }}
{{- get (.root.Values.secrets.existingSecretKeys | default dict) .name | default (get $defaults .name) }}
{{- end }}

{{/* Where the keyring Secret is mounted, and the file GOVERNANCE_PRIVATE_KEYS_FILE names. */}}
{{- define "libredb-studio.governanceKeyringDir" -}}
/etc/libredb/governance
{{- end }}

{{/*
The governance render guards (docs/HELM_CHART.md#11-governance). Each mirrors a refusal of the boot preflight
(src/lib/governance/preflight.ts) or a v1 constraint, so a values set Studio would refuse to start
with fails the render instead, naming the value to fix. Included from deployment.yaml.
*/}}
{{- define "libredb-studio.governanceGuards" -}}
{{- if include "libredb-studio.governanceEnabled" . }}
{{- $gov := .Values.governance }}
{{- $sticky := get (.Values.stickySessions | default dict) "enabled" }}
{{- if ne (.Values.authProvider | toString | trim | lower) "oidc" }}
{{- fail (printf "governance.enabled requires authProvider=oidc, not %q: under governance the identity provider is the only way to sign in" (.Values.authProvider | toString)) }}
{{- end }}
{{- if not .Values.config.oidcRoleClaim }}
{{- fail "governance.enabled requires config.oidcRoleClaim, the ID-token claim that carries the roles, such as libredb_roles" }}
{{- end }}
{{- if not (get .Values.config "oidcUserRoles") }}
{{- fail "governance.enabled requires config.oidcUserRoles, the role values that make a user, such as user" }}
{{- end }}
{{- if not (get .Values.config "storagePostgresSchema") }}
{{- fail "governance.enabled requires config.storagePostgresSchema, the schema of Studio's storage tables, such as studio" }}
{{- end }}
{{- if and (not (get .Values.secrets "governancePostgresUrl")) (not .Values.secrets.existingSecret) }}
{{- fail "governance.enabled requires secrets.governancePostgresUrl, or secrets.existingSecret with the governance URL under its governancePostgresUrl key (default governance-postgres-url)" }}
{{- end }}
{{- if and (not (get .Values.secrets "governancePrivateKeys")) (not .Values.secrets.existingSecret) }}
{{- fail "governance.enabled requires secrets.governancePrivateKeys, or secrets.existingSecret with the keyring under its governancePrivateKeys key (default governance-private-keys)" }}
{{- end }}
{{- if .Values.seedConnections.enabled }}
{{- fail "governance.enabled refuses seedConnections.enabled: the governance source is the only catalog of connections" }}
{{- end }}
{{- if .Values.config.oidcRolePrefix }}
{{- fail "governance.enabled refuses config.oidcRolePrefix: governance mode reads connections from the governance source only" }}
{{- end }}
{{- if eq (get .Values.config "allowCustomConnections" | toString) "true" }}
{{- fail "governance.enabled refuses config.allowCustomConnections=true: governance mode serves only the connections of the governance source; leave it unset or set it to false" }}
{{- end }}
{{- if get (.Values.mcp | default dict) "enabled" }}
{{- fail "governance.enabled refuses mcp.enabled: MCP under governance is not supported in this release" }}
{{- end }}
{{- if eq (get (.Values.agent | default dict) "enabled" | toString) "true" }}
{{- fail "governance.enabled refuses agent.enabled=true: the agent under governance is not supported in this release; leave agent.enabled unset or set it to false" }}
{{- end }}
{{- if .Values.secrets.adminPassword }}
{{- fail "governance.enabled refuses secrets.adminPassword: under governance nobody signs in with a password" }}
{{- end }}
{{- if .Values.secrets.userPassword }}
{{- fail "governance.enabled refuses secrets.userPassword: under governance nobody signs in with a password" }}
{{- end }}
{{- range .Values.extraEnv }}
{{- if hasPrefix "GOVERNANCE_" (.name | default "" | toString) }}
{{- fail (printf "governance.enabled refuses extraEnv entry %s: the chart writes every GOVERNANCE_ variable from the governance values" .name) }}
{{- end }}
{{- end }}
{{- if and (include "libredb-studio.governanceMultiReplica" .) (not $sticky) }}
{{- fail "governance.enabled with replicaCount above 1 or autoscaling.enabled requires stickySessions.enabled: Studio keeps transactions, rate limits and per-user providers in process memory, so configure cookie affinity at the ingress and then set stickySessions.enabled=true" }}
{{- end }}
{{- if and (include "libredb-studio.governanceMultiReplica" .) (get $gov "instanceId") }}
{{- fail "governance.instanceId must stay empty with replicaCount above 1 or autoscaling.enabled: every pod then reports its own name as instance id, and one shared id would merge their heartbeats" }}
{{- end }}
{{- $fsGroup := get .Values.podSecurityContext "fsGroup" }}
{{- if and (or (kindIs "invalid" $fsGroup) (eq (toString $fsGroup) "")) (not (include "libredb-studio.adaptOpenShiftSecurityContext" .)) }}
{{- fail "governance.enabled requires podSecurityContext.fsGroup (1001): the keyring Secret file is root-owned, and uid 1001 reads it only through the group" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Guards for the values a Rancher-mode install sets (seedConnections.existingSecret,
secrets.oidcExistingSecret, rancher.navLink, accessReview, discovery.kubernetes). Each refuses a
combination whose meaning would otherwise depend on a precedence nobody chose, or that Studio would
refuse to start with, naming the value to fix. Included from deployment.yaml.
*/}}
{{- define "libredb-studio.rancherModeGuards" -}}
{{- $seed := .Values.seedConnections }}
{{- if and $seed.enabled (get $seed "existingSecret") (or $seed.existingConfigMap $seed.config) }}
{{- fail "seedConnections.existingSecret refuses seedConnections.existingConfigMap and seedConnections.config beside it: set one seed source only" }}
{{- end }}
{{- if get .Values.secrets "oidcExistingSecret" }}
{{- if ne (.Values.authProvider | toString | trim | lower) "oidc" }}
{{- fail (printf "secrets.oidcExistingSecret requires authProvider=oidc, not %q: no other provider reads the OIDC client credentials" (.Values.authProvider | toString)) }}
{{- end }}
{{- if .Values.secrets.existingSecret }}
{{- fail "secrets.oidcExistingSecret refuses secrets.existingSecret beside it: put the OIDC client credentials in one of the two Secrets only" }}
{{- end }}
{{- if or .Values.secrets.oidcClientId .Values.secrets.oidcClientSecret }}
{{- fail "secrets.oidcExistingSecret refuses secrets.oidcClientId and secrets.oidcClientSecret beside it: the client credentials come from that Secret only" }}
{{- end }}
{{- end }}
{{- include "libredb-studio.accessReviewGuards" . }}
{{- include "libredb-studio.discoveryGuards" . }}
{{- if or (include "libredb-studio.accessReviewEnabled" .) (include "libredb-studio.discoveryEnabled" .) }}
{{- if or .Values.autoscaling.enabled (gt (int .Values.replicaCount) 1) }}
{{- fail "accessReview.enabled and discovery.kubernetes.enabled run one replica only: the groups record of each sign-in and the review and export caches live in one process, so set replicaCount=1 and leave autoscaling.enabled false" }}
{{- end }}
{{- end }}
{{- $navLink := get (get (.Values.rancher | default dict) "navLink" | default dict) "enabled" }}
{{- if $navLink }}
{{- if not .Values.ingress.enabled }}
{{- fail "rancher.navLink.enabled requires ingress.enabled with a host: the NavLink points at the first ingress host" }}
{{- end }}
{{- if not (include "libredb-studio.navLinkHost" .) }}
{{- fail "rancher.navLink.enabled requires ingress.hosts[0].host, the host the NavLink points at" }}
{{- end }}
{{- if contains "*" (include "libredb-studio.navLinkHost" .) }}
{{- fail "rancher.navLink.enabled requires a concrete first ingress host, not a wildcard" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
The host the NavLink points at: the first ingress host, empty when there is none.
*/}}
{{- define "libredb-studio.navLinkHost" -}}
{{- with .Values.ingress.hosts }}{{ (first .).host | default "" }}{{ end }}
{{- end }}


{{/*
Whether the Kubernetes access review is on (accessReview.enabled). `default dict` keeps a values set
that predates the block, as an upgrade with --reuse-values carries, rendering as before.
*/}}
{{- define "libredb-studio.accessReviewEnabled" -}}
{{- if get (.Values.accessReview | default dict) "enabled" }}
{{- true }}
{{- end }}
{{- end }}

{{/* Whether Kubernetes discovery is on (discovery.kubernetes.enabled). */}}
{{- define "libredb-studio.discoveryEnabled" -}}
{{- if get (get (.Values.discovery | default dict) "kubernetes" | default dict) "enabled" }}
{{- true }}
{{- end }}
{{- end }}

{{/*
The discovery exporter's kinds, in the contract's order (src/lib/seed/kubernetes-discovery-contract.ts and CONTRACT in
docker/discover-kubernetes.mjs): each slug with the API group and resource its Role lists. A unit test holds this table
to the contract.
*/}}
{{- define "libredb-studio.discoveryKindRules" -}}
- slug: cnpg
  group: postgresql.cnpg.io
  resource: clusters
- slug: edbpg
  group: postgresql.k8s.enterprisedb.io
  resource: clusters
- slug: pgo
  group: postgres-operator.crunchydata.com
  resource: postgresclusters
- slug: mongo
  group: mongodbcommunity.mongodb.com
  resource: mongodbcommunity
{{- end }}

{{/* The kinds the exporter discovers: discovery.kubernetes.kinds, else cnpg alone, the exporter's own default. */}}
{{- define "libredb-studio.discoveryKinds" -}}
{{- $kinds := get (get (.Values.discovery | default dict) "kubernetes" | default dict) "kinds" | default (list "cnpg") }}
{{- toYaml $kinds }}
{{- end }}

{{/* The ClusterRole and ClusterRoleBinding of the access review: cluster-scoped, so the namespace keeps two releases apart. */}}
{{- define "libredb-studio.accessReviewName" -}}
{{- printf "%s.%s-access-review" .Release.Namespace (include "libredb-studio.fullname" .) }}
{{- end }}

{{/* Where the access review's projected token and CA are mounted. */}}
{{- define "libredb-studio.accessReviewDir" -}}
/var/run/secrets/libredb/access-review
{{- end }}

{{/* The exporter's Deployment and ServiceAccount, and its Role and RoleBinding in the release namespace. */}}
{{- define "libredb-studio.discoveryName" -}}
{{- printf "%s-discovery" (include "libredb-studio.fullname" .) }}
{{- end }}

{{/*
The exporter's Role and RoleBinding in each discovered namespace. Another release of the same name in
another namespace may discover the same namespace, so the release namespace keeps the two apart, as
for accessReviewName.
*/}}
{{- define "libredb-studio.discoveryRoleName" -}}
{{- printf "%s.%s" .Release.Namespace (include "libredb-studio.discoveryName" .) }}
{{- end }}

{{/* The export Secret the exporter writes and Studio mounts. */}}
{{- define "libredb-studio.discoveryExportSecret" -}}
{{- printf "%s-discovery-export" (include "libredb-studio.fullname" .) }}
{{- end }}

{{/* Where Studio mounts the export Secret; its export.json is SEED_KUBERNETES_DISCOVERY_PATH. */}}
{{- define "libredb-studio.discoveryMountDir" -}}
/var/run/libredb/kubernetes-discovery
{{- end }}

{{/*
The exporter's selector labels. Its app.kubernetes.io/name is not Studio's, so Studio's Service,
PodDisruptionBudget and NetworkPolicy, which select on Studio's name and instance, never match it.
The name is cut to 53 characters before the suffix, so a long nameOverride never truncates the
suffix away and leaves the two names equal.
*/}}
{{- define "libredb-studio.discoverySelectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-discovery" (include "libredb-studio.name" . | trunc 53 | trimSuffix "-") }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "libredb-studio.discoveryLabels" -}}
helm.sh/chart: {{ include "libredb-studio.chart" . }}
{{ include "libredb-studio.discoverySelectorLabels" . }}
app.kubernetes.io/component: discovery-exporter
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
The access review guards (docs/SEED_CONNECTIONS.md, "Kubernetes access review"). Each mirrors a refusal
of Studio's boot check with the review on (src/lib/kubernetes-access/preflight.ts), so a values set
Studio would refuse to start with fails the render instead, naming the value to fix.
*/}}
{{- define "libredb-studio.accessReviewGuards" -}}
{{- if include "libredb-studio.accessReviewEnabled" . }}
{{- if ne (.Values.authProvider | toString | trim | lower) "oidc" }}
{{- fail (printf "accessReview.enabled requires authProvider=oidc, not %q: a review asks about the identity provider subject of an OIDC sign-in" (.Values.authProvider | toString)) }}
{{- end }}
{{- if .Values.config.oidcRoleClaim }}
{{- fail "accessReview.enabled refuses config.oidcRoleClaim: with the review on, a Studio admin is whoever may update Studio's Deployment, and no identity provider claim may grant it; leave it empty" }}
{{- end }}
{{- if get (.Values.mcp | default dict) "enabled" }}
{{- fail "accessReview.enabled refuses mcp.enabled: this version does not run MCP under the access review" }}
{{- end }}
{{- if eq (get (.Values.agent | default dict) "enabled" | toString) "true" }}
{{- fail "accessReview.enabled refuses agent.enabled=true: this version does not run the agent under the access review; leave agent.enabled unset or set it to false" }}
{{- end }}
{{- if include "libredb-studio.governanceEnabled" . }}
{{- fail "accessReview.enabled refuses governance.enabled: governance decides who opens a connection from its own grants; switch one of the two off" }}
{{- end }}
{{- if .Values.secrets.adminPassword }}
{{- fail "accessReview.enabled refuses secrets.adminPassword: with the review on, every sign-in goes through the identity provider" }}
{{- end }}
{{- if .Values.secrets.userPassword }}
{{- fail "accessReview.enabled refuses secrets.userPassword: with the review on, every sign-in goes through the identity provider" }}
{{- end }}
{{- $ttl := get .Values.config "sessionTtlSeconds" }}
{{- if or (kindIs "invalid" $ttl) (eq (toString $ttl) "") (gt (int $ttl) 900) }}
{{- fail "accessReview.enabled requires config.sessionTtlSeconds of at most 900: a session keeps the groups of its sign-in, and signing out of the identity provider does not end it" }}
{{- end }}
{{- if and (not .Values.serviceAccount.create) (not .Values.serviceAccount.name) }}
{{- fail "accessReview.enabled requires serviceAccount.create=true or a serviceAccount.name: otherwise the namespace's default ServiceAccount, which every other pod there runs as, would be granted the review" }}
{{- end }}
{{- $account := include "libredb-studio.serviceAccountName" . }}
{{- if eq $account "default" }}
{{- fail "accessReview.enabled refuses serviceAccount.name=default: the namespace's default ServiceAccount, which every other pod there runs as, would be granted the review; name an account of Studio's own" }}
{{- end }}
{{- if and (include "libredb-studio.discoveryEnabled" .) (eq $account (include "libredb-studio.discoveryName" .)) }}
{{- fail (printf "accessReview.enabled refuses serviceAccount.name=%s: that is the discovery exporter's account, which may read Secrets in the discovered namespaces, and Studio's own process never holds a token that can read a database Secret" $account) }}
{{- end }}
{{- range .Values.extraEnv }}
{{- if hasPrefix "KUBERNETES_ACCESS_REVIEW" (.name | default "" | toString) }}
{{- fail (printf "accessReview.enabled refuses extraEnv entry %s: the chart writes every KUBERNETES_ACCESS_REVIEW variable from the accessReview values" .name) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/* The Kubernetes discovery guards (docs/SEED_CONNECTIONS.md, "Platform discovery (Kubernetes)"). */}}
{{- define "libredb-studio.discoveryGuards" -}}
{{- if include "libredb-studio.discoveryEnabled" . }}
{{- if not .Values.discovery.kubernetes.namespaces }}
{{- fail "discovery.kubernetes.enabled requires discovery.kubernetes.namespaces, the namespaces to discover, such as {team-a,team-b}" }}
{{- end }}
{{- if include "libredb-studio.governanceEnabled" . }}
{{- fail "discovery.kubernetes.enabled refuses governance.enabled: the governance source is the only catalog of connections" }}
{{- end }}
{{- range .Values.extraEnv }}
{{- if hasPrefix "SEED_KUBERNETES_DISCOVERY" (.name | default "" | toString) }}
{{- fail (printf "discovery.kubernetes.enabled refuses extraEnv entry %s: the chart writes every SEED_KUBERNETES_DISCOVERY variable from the discovery values" .name) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Whether Studio signs people in with their OpenShift account (authProvider: openshift, trimmed and
lower-cased as the app reads NEXT_PUBLIC_AUTH_PROVIDER). Every openshift-mode object and variable
gates on it.
*/}}
{{- define "libredb-studio.openshiftSignIn" -}}
{{- if eq (.Values.authProvider | toString | trim | lower) "openshift" }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Where openshift mode mounts its projected volume: the OAuth client token is oauth-client-token
(OPENSHIFT_OAUTH_TOKEN_FILE) and the cluster's CA is ca.crt (OPENSHIFT_API_CA_FILE).
*/}}
{{- define "libredb-studio.openshiftSignInDir" -}}
/var/run/secrets/libredb/openshift
{{- end }}

{{/*
The audience of the projected token Studio sends to the OAuth server as its client secret. Fixed,
not a value: the one requirement is that it is not the API server's audience, so the token can do
nothing at the API server.
*/}}
{{- define "libredb-studio.openshiftOAuthAudience" -}}
libredb-studio-oauth-client
{{- end }}

{{/*
The OAuth client id of a ServiceAccount client, system:serviceaccount:<namespace>:<account>. The
chart annotates the account with the redirect it accepts, so it must be an account the chart
creates, and never the namespace's default one, which every other pod there runs as.
*/}}
{{- define "libredb-studio.openshiftClientId" -}}
{{- if not .Values.serviceAccount.create }}
{{- fail "authProvider=openshift requires serviceAccount.create=true: Studio's ServiceAccount is the OAuth client, and the chart can annotate only an account it creates" }}
{{- end }}
{{- $account := include "libredb-studio.serviceAccountName" . }}
{{- if eq $account "default" }}
{{- fail "authProvider=openshift refuses serviceAccount.name=default: the namespace's default ServiceAccount, which every other pod there runs as, would become the OAuth client; name an account of Studio's own or leave serviceAccount.name empty" }}
{{- end }}
{{- printf "system:serviceaccount:%s:%s" .Release.Namespace $account }}
{{- end }}

{{/*
Whether the OLM operator renders this release (operator.managed, which only operator/watches.yaml
sets). Read with dig over a defaulted dict, so a --reuse-values upgrade from a chart without the
block renders as a Helm install, and compared as text, so only true counts.
*/}}
{{- define "libredb-studio.operatorManaged" -}}
{{- if eq (dig "managed" false (.Values.operator | default dict) | toString) "true" }}
{{- true }}
{{- end }}
{{- end }}

{{/*
Whether this release may render cross-namespace and cluster-scoped objects (O14): always for a Helm
install, and under operator.managed only for the release in operator.clusterStudioNamespace, which
the operator sets to its own namespace (WATCH_NAMESPACE in its Deployment), the only one it
reconciles. The operator never renders another namespace's resource, so this holds in a correct
install and stays as defense in depth: an empty or other value lets no such object render.
*/}}
{{- define "libredb-studio.clusterStudioNamespaceOK" -}}
{{- if not (include "libredb-studio.operatorManaged" .) }}
{{- true }}
{{- else }}
{{- $namespace := dig "clusterStudioNamespace" "" (.Values.operator | default dict) | toString | trim }}
{{- if and $namespace (eq $namespace .Release.Namespace) }}
{{- true }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Fails the render, naming operator.clusterStudioNamespace, when clusterStudioNamespaceOK does not
hold. Called as include "libredb-studio.clusterStudioNamespaceGuard" (dict "ctx" $ "what" "<the
object>").
*/}}
{{- define "libredb-studio.clusterStudioNamespaceGuard" -}}
{{- if not (include "libredb-studio.clusterStudioNamespaceOK" .ctx) }}
{{- $namespace := dig "clusterStudioNamespace" "" (.ctx.Values.operator | default dict) | toString | trim }}
{{- fail (printf "operator.managed is set and %s: the operator renders cross-namespace and cluster-scoped objects only for the LibreDBStudio in the namespace operator.clusterStudioNamespace names, which the operator sets to its own namespace (WATCH_NAMESPACE in its Deployment), and which is %s, not this release's namespace %s" .what (ternary (printf "%q" $namespace) "unset" (ne $namespace "")) .ctx.Release.Namespace) }}
{{- end }}
{{- end }}

{{/*
The openshift-mode render guards. Each mirrors a refusal of Studio's openshift preflight or a
constraint of this mode, so a values set Studio would refuse to start with fails the render
instead, naming the value to fix. Included from deployment.yaml.
*/}}
{{- define "libredb-studio.openshiftModeGuards" -}}
{{- if include "libredb-studio.openshiftSignIn" . }}
{{- $route := .Values.openshiftRoute | default dict }}
{{- if not (get $route "enabled") }}
{{- fail "authProvider=openshift requires openshiftRoute.enabled=true: the ServiceAccount's redirect reference names the Route, so the OAuth server accepts no callback without it" }}
{{- end }}
{{- if not (get $route "host") }}
{{- fail "authProvider=openshift requires openshiftRoute.host: OPENSHIFT_PUBLIC_URL and the ConsoleLink need the public host at install time, so set the host the router serves, such as studio-<namespace>.apps.<cluster domain>" }}
{{- end }}
{{- $_ := include "libredb-studio.openshiftClientId" . }}
{{- $account := include "libredb-studio.serviceAccountName" . }}
{{- if and (include "libredb-studio.discoveryEnabled" .) (eq $account (include "libredb-studio.discoveryName" .)) }}
{{- fail (printf "authProvider=openshift refuses serviceAccount.name=%s: that is the discovery exporter's account, which may read Secrets in the discovered namespaces, and Studio's own process never holds a token that can read a database Secret" $account) }}
{{- end }}
{{- /* The OAuth server accepts every redirect any oauth-redirect annotation of the account names, so
       one more reference or URI would let it send the code past Studio's callback. The chart's own
       two keys may still collide: serviceaccount.yaml lets the chart's value win. */}}
{{- range $key, $_ := .Values.serviceAccount.annotations | default dict }}
{{- if and (hasPrefix "serviceaccounts.openshift.io/oauth-redirect" $key) (not (has $key (list "serviceaccounts.openshift.io/oauth-redirectreference.first" "serviceaccounts.openshift.io/oauth-redirecturi.first"))) }}
{{- fail (printf "authProvider=openshift refuses the serviceAccount.annotations entry %s: the chart registers Studio's one callback itself, and another redirect annotation would let the OAuth server send the code elsewhere, so remove it" $key) }}
{{- end }}
{{- end }}
{{- if include "libredb-studio.operatorManaged" . }}
{{- range .Values.extraEnv }}
{{- if hasPrefix "KUBERNETES_ACCESS_REVIEW_ADMIN_" (.name | default "" | toString) }}
{{- fail (printf "authProvider=openshift with operator.managed refuses extraEnv entry %s: under the operator a Studio admin is whoever may update this LibreDBStudio, and the resource may not move that target" .name) }}
{{- end }}
{{- end }}
{{- end }}
{{- if .Values.serviceAccount.automountServiceAccountToken }}
{{- fail "authProvider=openshift refuses serviceAccount.automountServiceAccountToken=true: Studio's process holds only the OAuth client token, whose audience the API server rejects, and reviews every request with the signed-in user's own token; leave it false" }}
{{- end }}
{{- if gt (int .Values.replicaCount) 1 }}
{{- fail "authProvider=openshift requires replicaCount=1: the OpenShift tokens of signed-in users, the review cache and the export cache live in one process" }}
{{- end }}
{{- if .Values.autoscaling.enabled }}
{{- fail "authProvider=openshift refuses autoscaling.enabled: the OpenShift tokens of signed-in users, the review cache and the export cache live in one process, so leave it false" }}
{{- end }}
{{- if .Values.config.oidcRoleClaim }}
{{- fail "authProvider=openshift refuses config.oidcRoleClaim: a Studio admin is whoever may update Studio's Deployment, or the LibreDBStudio resource under the operator, and no claim may grant it; leave it empty" }}
{{- end }}
{{- if get (.Values.mcp | default dict) "enabled" }}
{{- fail "authProvider=openshift refuses mcp.enabled: this version does not run MCP with openshift sign-in" }}
{{- end }}
{{- if eq (get (.Values.agent | default dict) "enabled" | toString) "true" }}
{{- fail "authProvider=openshift refuses agent.enabled=true: this version does not run the agent with openshift sign-in; leave agent.enabled unset or set it to false" }}
{{- end }}
{{- $review := .Values.accessReview | default dict }}
{{- if get $review "enabled" }}
{{- fail "authProvider=openshift refuses accessReview.enabled: openshift sign-in reviews every request with the signed-in user's own token, never Studio's ServiceAccount; leave it false" }}
{{- end }}
{{- $reviewCache := get $review "cacheSeconds" }}
{{- if and (not (kindIs "invalid" $reviewCache)) (ne (toString $reviewCache) "") }}
{{- fail "authProvider=openshift refuses accessReview.cacheSeconds, a setting of the ServiceAccount review it does not run: set openshift.signIn.reviewCacheSeconds instead" }}
{{- end }}
{{- if trim (get $review "signIn" | default "" | toString) }}
{{- fail "authProvider=openshift refuses accessReview.signIn, a setting of the ServiceAccount review it does not run: set openshift.signIn.review instead" }}
{{- end }}
{{- if .Values.secrets.adminPassword }}
{{- fail "authProvider=openshift refuses secrets.adminPassword: everyone signs in with an OpenShift account, and Studio refuses to start with ADMIN_PASSWORD set" }}
{{- end }}
{{- if .Values.secrets.userPassword }}
{{- fail "authProvider=openshift refuses secrets.userPassword: everyone signs in with an OpenShift account, and Studio refuses to start with USER_PASSWORD set" }}
{{- end }}
{{- if include "libredb-studio.governanceEnabled" . }}
{{- fail "authProvider=openshift refuses governance.enabled: governance signs people in through an OIDC identity provider; switch one of the two off" }}
{{- end }}
{{- $dir := include "libredb-studio.openshiftSignInDir" . }}
{{- range .Values.extraVolumes }}
{{- if eq (.name | default "" | toString) "openshift-oauth" }}
{{- fail "authProvider=openshift refuses the extraVolumes entry openshift-oauth: the chart renders that volume itself, so remove the hand-wired entry (and its extraVolumeMounts, extraEnv and serviceAccount.annotations)" }}
{{- end }}
{{- end }}
{{- range .Values.extraVolumeMounts }}
{{- if eq (.mountPath | default "" | toString | trimSuffix "/") $dir }}
{{- fail (printf "authProvider=openshift refuses the extraVolumeMounts entry %s at %s: the chart mounts the OAuth client token and the cluster CA there itself, so remove the hand-wired entry" (.name | default "" | toString) $dir) }}
{{- end }}
{{- end }}
{{- /* Release 1.1.0 and earlier have no openshift sign-in and run password sign-in under it, so a
       semver tag at or below 1.1.0 fails; a tag that is not a semver (latest, a branch, a digest)
       cannot be compared and is accepted. A pre-release or build of 1.1.0 counts as 1.1.0. */}}
{{- $tag := default .Chart.AppVersion .Values.image.tag | toString }}
{{- if regexMatch `^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]*)?$` $tag }}
{{- if semverCompare "<=1.1.0" (regexReplaceAll "[-+].*$" (trimPrefix "v" $tag) "") }}
{{- fail (printf "authProvider=openshift needs an application image after 1.1.0, and image.tag is %s: release 1.1.0 and earlier have no openshift sign-in and would sign people in with a generated password; set image.tag to a later release" $tag) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Every mode guard and mode object keys on authProvider, but the app reads its sign-in mode from
NEXT_PUBLIC_AUTH_PROVIDER, which the ConfigMap writes from authProvider and an extraEnv entry of the
same name overrides. So an extraEnv NEXT_PUBLIC_AUTH_PROVIDER must name the same mode (trimmed and
lower-cased, as the app reads it), and the two variables only openshift sign-in reads are refused in
every other mode: the hand wiring of the first verify windows (authProvider local and openshift in
extraEnv) would otherwise run openshift sign-in with none of the mode's guards, egress policy or
custom-connection default. Every mode, so included from deployment.yaml before the mode guards. An
extraEnvFrom source carrying the name is a blind spot, as in effectiveBindAddress.
*/}}
{{- define "libredb-studio.authProviderGuard" -}}
{{- $provider := .Values.authProvider | toString | trim | lower }}
{{- range .Values.extraEnv }}
{{- $name := .name | default "" | toString }}
{{- if and (eq $name "NEXT_PUBLIC_AUTH_PROVIDER") (ne (.value | default "" | toString | trim | lower) $provider) }}
{{- fail (printf "extraEnv entry NEXT_PUBLIC_AUTH_PROVIDER must name the same sign-in mode as authProvider (%q): set the mode in authProvider, which every mode guard and object keys on, and remove the extraEnv entry" $provider) }}
{{- end }}
{{- if and (has $name (list "OPENSHIFT_OAUTH_CLIENT_ID" "OPENSHIFT_OAUTH_TOKEN_FILE")) (ne $provider "openshift") }}
{{- fail (printf "extraEnv entry %s is read only by openshift sign-in, and authProvider is %q: set authProvider=openshift, which writes it, and remove the hand-wired extraEnv entries" $name $provider) }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Kubernetes discovery on OpenShift (config.openshift.io/v1 served, or global.compatibility.openshift.apis=force)
needs openshift or local sign-in: with oidc the review would ask about the identity provider's subject,
which the cluster's RBAC does not know. Every mode, so included from deployment.yaml beside the
openshift-mode guards. The same values on another cluster, the Rancher path, still render.
*/}}
{{- define "libredb-studio.discoveryOnOpenShiftGuard" -}}
{{- if and (include "libredb-studio.discoveryEnabled" .) (include "libredb-studio.openshiftApiServed" (dict "ctx" . "api" "config.openshift.io/v1")) }}
{{- if not (has (.Values.authProvider | toString | trim | lower) (list "openshift" "local")) }}
{{- fail (printf "discovery.kubernetes.enabled on OpenShift requires authProvider=openshift or local, not %q: the review would ask the cluster about the identity provider's subject, which its RBAC does not know" (.Values.authProvider | toString)) }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Whether the NetworkPolicy renders: networkPolicy.enabled true always, false never, and unset (null,
"" or absent, as Helm 4.2 drops a null default) only in openshift sign-in mode with Kubernetes
discovery on, where it is the network control that holds even against a forged Service in a
discovered namespace.
*/}}
{{- define "libredb-studio.networkPolicyEnabled" -}}
{{- $enabled := get (.Values.networkPolicy | default dict) "enabled" }}
{{- if or (kindIs "invalid" $enabled) (eq (toString $enabled) "") }}
{{- if and (include "libredb-studio.openshiftSignIn" .) (include "libredb-studio.discoveryEnabled" .) }}
{{- true }}
{{- end }}
{{- else if eq (toString $enabled) "true" }}
{{- true }}
{{- end }}
{{- end }}
