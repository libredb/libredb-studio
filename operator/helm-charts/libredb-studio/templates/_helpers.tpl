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
Return the PostgreSQL URL when subchart is enabled
*/}}
{{- define "libredb-studio.postgresql.url" -}}
{{- printf "postgresql://%s:$(POSTGRES_PASSWORD)@%s:5432/%s" .Values.postgresql.auth.username (include "libredb-studio.postgresql.fullname" .) .Values.postgresql.auth.database }}
{{- end }}
