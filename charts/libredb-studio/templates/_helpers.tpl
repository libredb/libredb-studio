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
Return the full image reference (repository:tag)
*/}}
{{- define "libredb-studio.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag }}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}

{{/*
Return the PostgreSQL host when subchart is enabled
*/}}
{{- define "libredb-studio.postgresql.host" -}}
{{- printf "%s-postgresql" (include "libredb-studio.fullname" .) }}
{{- end }}

{{/*
Return the PostgreSQL URL when subchart is enabled
*/}}
{{- define "libredb-studio.postgresql.url" -}}
{{- printf "postgresql://%s:$(POSTGRES_PASSWORD)@%s:5432/%s" .Values.postgresql.auth.username (include "libredb-studio.postgresql.host" .) .Values.postgresql.auth.database }}
{{- end }}
