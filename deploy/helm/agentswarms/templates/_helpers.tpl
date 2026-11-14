{{/* The release the images come from. */}}
{{- define "as.release" -}}
{{- default .Chart.AppVersion .Values.release -}}
{{- end -}}

{{- define "as.image" -}}
{{- printf "%s/%s:%s" .root.Values.registry .name (include "as.release" .root) -}}
{{- end -}}

{{- define "as.labels" -}}
app.kubernetes.io/name: agentswarms
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "as.release" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* One key of the deployment's Secret, as an env entry. */}}
{{- define "as.secretEnv" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ .root.Values.secrets.name }}
      key: {{ .key }}
{{- end -}}

{{- define "as.publicHost" -}}
{{- default (trimPrefix "https://" .Values.publicUrl) .Values.ingress.host -}}
{{- end -}}

{{- define "as.db" -}}
{{- printf "%s:%v/postgres?sslmode=%s" .Values.database.host .Values.database.port .Values.database.sslmode -}}
{{- end -}}

{{- define "as.webUrl" -}}
{{- printf "http://agentswarms-web.%s.svc.cluster.local" .Release.Namespace -}}
{{- end -}}

{{/* The app's settings, shared by web and analytics. */}}
{{- define "as.appEnv" -}}
- { name: PORT, value: "8080" }
- { name: PUBLIC_APP_URL, value: {{ .Values.publicUrl | quote }} }
- { name: SITE_URL, value: {{ .Values.publicUrl | quote }} }
- { name: SUPABASE_URL, value: {{ .Values.publicUrl | quote }} }
- { name: PUBLIC_SUPABASE_URL, value: {{ .Values.publicUrl | quote }} }
- { name: PUBLIC_SUPABASE_REALTIME, value: "off" }
- { name: ADMIN_EMAIL, value: {{ .Values.adminEmail | quote }} }
- { name: PUBLIC_ADMIN_EMAIL, value: {{ .Values.adminEmail | quote }} }
- { name: NOTEBOOK_RUNTIME_ENABLED, value: "true" }
- { name: NOTEBOOK_RUNTIME_BACKEND, value: k8s }
- { name: NOTEBOOK_K8S_NAMESPACE, value: {{ .Values.sandboxes.namespace | quote }} }
- { name: NOTEBOOK_RUNTIME_IMAGE, value: {{ include "as.image" (dict "root" . "name" "notebook-runtime") | quote }} }
- { name: NOTEBOOK_APP_INTERNAL_URL, value: {{ include "as.webUrl" . | quote }} }
- { name: NOTEBOOK_EGRESS_PROXY, value: {{ printf "http://egress-proxy.%s.svc.cluster.local:3128" .Values.sandboxes.namespace | quote }} }
- { name: NOTEBOOK_EGRESS_MODE, value: pull }
- { name: NOTEBOOK_GATEWAY_URL, value: {{ printf "wss://%s/nbgw" (include "as.publicHost" .) | quote }} }
- { name: NOTEBOOK_K8S_NODE_SELECTOR, value: {{ .Values.sandboxes.nodeSelector | toJson | quote }} }
- { name: NOTEBOOK_K8S_TOLERATIONS, value: {{ .Values.sandboxes.tolerations | toJson | quote }} }
# The API server's certificate, for the k8s backend's calls.
- { name: NODE_EXTRA_CA_CERTS, value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt }
- { name: DOCGEN_SERVICE_URL, value: "http://docgen:8099" }
- { name: JS_SANDBOX_URL, value: "http://js-sandbox:8091" }
- { name: VECTOR_STORE, value: pgvector }
- { name: LAKEHOUSE_CATALOG_URL, value: {{ printf "postgres://lakehouse@%s:%v/lakehouse_catalog?sslmode=%s" .Values.database.host .Values.database.port .Values.database.sslmode | quote }} }
- { name: LAKEHOUSE_DATA_URL, value: {{ printf "s3://%s/main" .Values.aws.lakeBucket | quote }} }
- { name: LAKEHOUSE_S3_REGION, value: {{ .Values.aws.region | quote }} }
- { name: LAKEHOUSE_S3_URL_STYLE, value: vhost }
- { name: LAKEHOUSE_SSE_KMS, value: {{ .Values.aws.kmsKeyArn | quote }} }
- { name: AWS_REGION, value: {{ .Values.aws.region | quote }} }
- { name: HTTP_KEEPALIVE_TIMEOUT_MS, value: "125000" }
{{ include "as.secretEnv" (dict "root" . "env" "SUPABASE_PUBLISHABLE_KEY" "key" "anon_key") }}
{{ include "as.secretEnv" (dict "root" . "env" "PUBLIC_SUPABASE_PUBLISHABLE_KEY" "key" "anon_key") }}
{{ include "as.secretEnv" (dict "root" . "env" "SUPABASE_SERVICE_ROLE_KEY" "key" "service_role_key") }}
{{ include "as.secretEnv" (dict "root" . "env" "PROVIDER_CREDS_SECRET" "key" "provider_creds_secret") }}
{{ include "as.secretEnv" (dict "root" . "env" "INTERNAL_RUN_SECRET" "key" "internal_run_secret") }}
{{ include "as.secretEnv" (dict "root" . "env" "NOTEBOOK_RUNTIME_SECRET" "key" "notebook_runtime_secret") }}
{{ include "as.secretEnv" (dict "root" . "env" "NOTEBOOK_EGRESS_PULL_TOKEN" "key" "egress_pull_token") }}
{{ include "as.secretEnv" (dict "root" . "env" "DOCGEN_TOKEN" "key" "docgen_token") }}
{{ include "as.secretEnv" (dict "root" . "env" "PROVENANCE_SIGNING_SECRET" "key" "provenance_signing_secret") }}
{{ include "as.secretEnv" (dict "root" . "env" "METRICS_TOKEN" "key" "metrics_token") }}
{{ include "as.secretEnv" (dict "root" . "env" "LAKEHOUSE_CATALOG_PASSWORD" "key" "lakehouse_catalog_password") }}
{{- range $k, $v := .Values.extraEnv }}
- { name: {{ $k }}, value: {{ $v | quote }} }
{{- end }}
{{- end -}}

{{/* GoTrue's settings (the service and the deploy Job). */}}
{{- define "as.gotrueEnv" -}}
- { name: GOTRUE_API_HOST, value: 0.0.0.0 }
- { name: GOTRUE_API_PORT, value: "9999" }
- { name: API_EXTERNAL_URL, value: {{ printf "%s/auth/v1" .Values.publicUrl | quote }} }
- { name: GOTRUE_DB_DRIVER, value: postgres }
- { name: GOTRUE_DB_DATABASE_URL, value: {{ printf "postgres://supabase_auth_admin@%s" (include "as.db" .) | quote }} }
- { name: GOTRUE_SITE_URL, value: {{ .Values.publicUrl | quote }} }
- { name: GOTRUE_URI_ALLOW_LIST, value: {{ printf "%s/**" .Values.publicUrl | quote }} }
- { name: GOTRUE_JWT_AUD, value: authenticated }
- { name: GOTRUE_JWT_DEFAULT_GROUP_NAME, value: authenticated }
- { name: GOTRUE_JWT_ADMIN_ROLES, value: service_role }
- { name: GOTRUE_JWT_EXP, value: "3600" }
- { name: GOTRUE_EXTERNAL_EMAIL_ENABLED, value: "true" }
- { name: GOTRUE_MAILER_AUTOCONFIRM, value: {{ .Values.supabase.mailerAutoconfirm | quote }} }
{{- with .Values.supabase.smtp }}
{{- if .host }}
- { name: GOTRUE_SMTP_HOST, value: {{ .host | quote }} }
- { name: GOTRUE_SMTP_PORT, value: {{ .port | quote }} }
- { name: GOTRUE_SMTP_USER, value: {{ .user | quote }} }
- { name: GOTRUE_SMTP_ADMIN_EMAIL, value: {{ .from | quote }} }
- { name: GOTRUE_SMTP_SENDER_NAME, value: AgentSwarms }
{{ include "as.secretEnv" (dict "root" $ "env" "GOTRUE_SMTP_PASS" "key" (default "smtp_password" .passwordKey)) }}
{{- end }}
{{- end }}
{{ include "as.secretEnv" (dict "root" . "env" "GOTRUE_JWT_SECRET" "key" "jwt_secret") }}
{{ include "as.secretEnv" (dict "root" . "env" "PGPASSWORD" "key" "auth_admin_password") }}
{{- end -}}

{{- define "as.restEnv" -}}
- { name: PGRST_DB_URI, value: {{ printf "postgres://authenticator@%s" (include "as.db" .) | quote }} }
- { name: PGRST_DB_SCHEMAS, value: "public,storage" }
- { name: PGRST_DB_ANON_ROLE, value: anon }
- { name: PGRST_SERVER_PORT, value: "3000" }
{{ include "as.secretEnv" (dict "root" . "env" "PGRST_JWT_SECRET" "key" "jwt_secret") }}
{{ include "as.secretEnv" (dict "root" . "env" "PGPASSWORD" "key" "authenticator_password") }}
{{- end -}}

{{- define "as.storageEnv" -}}
- { name: POSTGREST_URL, value: {{ .postgrest | quote }} }
- { name: DATABASE_URL, value: {{ printf "postgres://supabase_storage_admin@%s" (include "as.db" .root) | quote }} }
- { name: STORAGE_BACKEND, value: s3 }
- { name: GLOBAL_S3_BUCKET, value: {{ .root.Values.aws.storageBucket | quote }} }
- { name: REGION, value: {{ .root.Values.aws.region | quote }} }
- { name: TENANT_ID, value: stub }
- { name: FILE_SIZE_LIMIT, value: {{ .root.Values.supabase.fileSizeLimit | quote }} }
- { name: SERVER_PORT, value: "5000" }
{{ include "as.secretEnv" (dict "root" .root "env" "ANON_KEY" "key" "anon_key") }}
{{ include "as.secretEnv" (dict "root" .root "env" "SERVICE_KEY" "key" "service_role_key") }}
{{ include "as.secretEnv" (dict "root" .root "env" "AUTH_JWT_SECRET" "key" "jwt_secret") }}
{{ include "as.secretEnv" (dict "root" .root "env" "PGPASSWORD" "key" "storage_admin_password") }}
{{- end -}}

{{- define "as.podSecurity" -}}
seccompProfile: { type: RuntimeDefault }
{{- end -}}

{{- define "as.containerSecurity" -}}
allowPrivilegeEscalation: false
capabilities: { drop: ["ALL"] }
{{- end -}}
