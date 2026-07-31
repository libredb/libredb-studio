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
