#!/usr/bin/env bash
# Warm model endpoints on KServe, on a laptop: a kind cluster with
# cert-manager, metrics-server and KServe in Standard mode, the Helm chart's
# serving objects (templates/serving.yaml), and an identity for an app that
# runs OUTSIDE the cluster (a dev server) and reaches it through the API
# server. Then deploy a model from the app's Deployment panel and watch
# Kubernetes scale it under load.
#
#   bash deploy/kind/kserve/run.sh up                # cluster, KServe, serving namespace
#   bash deploy/kind/kserve/run.sh app-env <file>    # the dev server's settings, to a file
#   bash deploy/kind/kserve/run.sh load <name> [seconds] [workers]
#   bash deploy/kind/kserve/run.sh watch             # pods and the HPA, every 5 s
#   bash deploy/kind/kserve/run.sh down              # delete the cluster
#
# Needs Docker, kind, Helm 3 and kubectl (KIND, HELM and KUBECTL name them
# when they are not on PATH). Every version is pinned below.
#
# A predictor pod gets its model from the app, which here runs on this
# machine: APP_URL is the app as a pod reaches it (default
# http://host.docker.internal:8102, a dev server on :8102). Pods hold no
# storage credential, so there is nothing to give them.
#
# SCORER_IMAGE is the runtime image holding score_server.py (default
# agentswarms-notebook-runtime:r532, built from docker/notebook-runtime); it
# is loaded into the cluster, never pulled.
set -euo pipefail
export MSYS_NO_PATHCONV=1

KIND_VERSION=v0.33.0
CERT_MANAGER_VERSION=v1.21.3
METRICS_SERVER_VERSION=v0.9.1
KSERVE_VERSION=v0.21.0

CLUSTER="${CLUSTER:-agentswarms-kserve}"
API_PORT="${API_PORT:-6445}"
SERVING_NS=agentswarms-serving
APP_NS=agentswarms
APP_SA=agentswarms
SCORER_IMAGE="${SCORER_IMAGE:-agentswarms-notebook-runtime:r532}"
APP_URL="${APP_URL:-http://host.docker.internal:8102}"
STATE="${STATE:-$HOME/.agentswarms/kind-kserve}"
KIND="${KIND:-kind}"
HELM="${HELM:-helm}"
KUBECTL="${KUBECTL:-kubectl}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
# Helm's repositories are the rig's own: `--repo` reads every repository in
# the user's Helm config, and one without a cached index fails the install.
export HELM_REPOSITORY_CONFIG="$STATE/helm/repositories.yaml"
export HELM_REPOSITORY_CACHE="$STATE/helm/cache"
mkdir -p "$STATE/helm/cache"

win() { command -v cygpath >/dev/null 2>&1 && cygpath -m "$1" || echo "$1"; }
k() { "$KUBECTL" --context "kind-$CLUSTER" "$@"; }
h() { "$HELM" --kube-context "kind-$CLUSTER" "$@"; }
say() { echo "== $*"; }

up() {
  "$KIND" version | grep -q "$KIND_VERSION" || echo "note: this rig is tested with kind $KIND_VERSION"
  if ! "$KIND" get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    say "creating the kind cluster $CLUSTER (API server on 127.0.0.1:$API_PORT)"
    "$KIND" create cluster --name "$CLUSTER" --config "$(win "$HERE/kind.yaml")" --wait 15m
  fi

  say "cert-manager $CERT_MANAGER_VERSION (KServe's webhooks need it)"
  h upgrade --install cert-manager cert-manager --repo https://charts.jetstack.io \
    --version "$CERT_MANAGER_VERSION" --namespace cert-manager --create-namespace \
    --set crds.enabled=true --wait --timeout 10m >/dev/null

  say "metrics-server $METRICS_SERVER_VERSION (the HPA's CPU readings)"
  k apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/$METRICS_SERVER_VERSION/components.yaml" >/dev/null
  # kind's kubelets serve self-signed certificates.
  if ! k -n kube-system get deploy metrics-server -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q kubelet-insecure-tls; then
    k -n kube-system patch deploy metrics-server --type=json \
      -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null
  fi
  k -n kube-system rollout status deploy/metrics-server --timeout=5m >/dev/null

  say "KServe $KSERVE_VERSION, Standard mode, no ingress (the app calls the predictor's Service)"
  h upgrade --install kserve-crd oci://ghcr.io/kserve/charts/kserve-crd --version "$KSERVE_VERSION" \
    --namespace kserve --create-namespace --wait >/dev/null
  h upgrade --install kserve oci://ghcr.io/kserve/charts/kserve-resources --version "$KSERVE_VERSION" \
    --namespace kserve \
    --set kserve.controller.deploymentMode=Standard \
    --set kserve.controller.gateway.disableIngressCreation=true \
    --wait --timeout 10m >/dev/null

  say "the chart's serving objects (namespace, quota, role, predictor account, network policy)"
  k get ns "$APP_NS" >/dev/null 2>&1 || k create ns "$APP_NS" >/dev/null
  k -n "$APP_NS" get sa "$APP_SA" >/dev/null 2>&1 || k -n "$APP_NS" create sa "$APP_SA" >/dev/null
  h template agentswarms "$(win "$REPO/deploy/helm/agentswarms")" --namespace "$APP_NS" \
    --show-only templates/serving.yaml \
    --set serving.kserve.enabled=true \
    --set serving.kserve.quota.pods=6 --set serving.kserve.quota.cpu=6 --set serving.kserve.quota.memory=12Gi \
    --set aws.region=us-east-1 |
    k apply -f - >/dev/null

  # The app is OUTSIDE the cluster here, so it reaches predictors through the
  # API server's service proxy: its account needs services/proxy (the chart's
  # Role, for an app in the cluster calling the Service directly, does not
  # grant it), and the proxy's requests come from a node, not an app pod.
  # The load generator is a pod of this rig's own. Both are let in on 8080,
  # and predictors may reach the app on this machine for their model.
  # In a real install the app runs in the cluster and none of this applies.
  k apply -f - >/dev/null <<YAML
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: rig-service-proxy, namespace: $SERVING_NS }
rules:
  - apiGroups: [""]
    resources: ["services/proxy"]
    verbs: ["get", "create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: rig-service-proxy, namespace: $SERVING_NS }
subjects: [{ kind: ServiceAccount, name: $APP_SA, namespace: $APP_NS }]
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: rig-service-proxy }
YAML
  local nodes
  nodes="$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -v ':' | head -1)"
  k apply -f - >/dev/null <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: rig-apiserver-and-load, namespace: $SERVING_NS }
spec:
  podSelector:
    matchExpressions: [{ key: serving.kserve.io/inferenceservice, operator: Exists }]
  policyTypes: [Ingress, Egress]
  egress:
    - ports: [{ protocol: TCP, port: ${APP_URL##*:} }]
  ingress:
    - from:
        - ipBlock: { cidr: ${nodes:-172.18.0.0/16} }
        - ipBlock: { cidr: 10.244.0.0/16 }
        - podSelector: { matchLabels: { agentswarms.dev/rig: load } }
      ports: [{ protocol: TCP, port: 8080 }]
YAML

  if docker image inspect "$SCORER_IMAGE" >/dev/null 2>&1; then
    say "loading $SCORER_IMAGE into the cluster (a few minutes for the ML stack)"
    "$KIND" load docker-image "$SCORER_IMAGE" --name "$CLUSTER" >/dev/null
  else
    echo "note: $SCORER_IMAGE is not built; build docker/notebook-runtime with that tag and run up again."
  fi
  say "ready. Next: bash deploy/kind/kserve/run.sh app-env <file>"
}

app_env() {
  local out="${1:?usage: run.sh app-env <file>}"
  mkdir -p "$STATE"
  chmod 700 "$STATE" 2>/dev/null || true
  # The app's own identity: a token for its ServiceAccount, bound by the
  # chart's agentswarms-serving Role, so the rig tests the chart's RBAC.
  k -n "$APP_NS" create token "$APP_SA" --duration=12h >"$STATE/token"
  "$KIND" get kubeconfig --name "$CLUSTER" |
    sed -n 's/^ *certificate-authority-data: //p' | head -1 | base64 -d >"$STATE/ca.crt"
  chmod 600 "$STATE/token" "$STATE/ca.crt" 2>/dev/null || true
  cat >"$out" <<ENV
ML_SERVING_BACKEND=kserve
KSERVE_NAMESPACE=$SERVING_NS
KSERVE_ACCESS=apiserver
KSERVE_SERVICE_ACCOUNT=agentswarms-predictor
KSERVE_APP_URL=$APP_URL
KSERVE_SCORER_IMAGE=$SCORER_IMAGE
KSERVE_MEMORY_REQUEST=512Mi
KSERVE_MEMORY_LIMIT=1536Mi
KUBERNETES_API_URL=https://127.0.0.1:$API_PORT
KUBERNETES_TOKEN_FILE=$(win "$STATE/token")
NODE_EXTRA_CA_CERTS=$(win "$STATE/ca.crt")
ENV
  say "wrote $out (the token in it is a file path; the token itself is in $STATE)"
}

load() {
  local name="${1:?usage: run.sh load <inferenceservice name> [seconds] [workers]}"
  local seconds="${2:-180}" workers="${3:-16}"
  say "load on $name for ${seconds}s with $workers workers, from inside the cluster"
  k -n "$SERVING_NS" delete job rig-load --ignore-not-found >/dev/null
  # The token comes from the predictor's own Secret, inside the cluster; it is
  # never printed or written outside it.
  k apply -f - >/dev/null <<YAML
apiVersion: batch/v1
kind: Job
metadata: { name: rig-load, namespace: $SERVING_NS }
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata: { labels: { agentswarms.dev/rig: load } }
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      containers:
        - name: load
          image: $SCORER_IMAGE
          imagePullPolicy: IfNotPresent
          command: ["python", "-c"]
          args:
            - |
              import json, os, threading, time, urllib.request
              url = "http://$name-predictor.$SERVING_NS.svc.cluster.local/score"
              tok = os.environ["TOKEN"]
              body = json.dumps({"rows": [{} for _ in range(200)]}).encode()
              end = time.time() + $seconds
              seen = {"ok": 0, "refused": 0, "failed": 0}
              lock = threading.Lock()
              def work():
                  while time.time() < end:
                      req = urllib.request.Request(url, data=body, headers={"X-Port-Token": tok, "Content-Type": "application/json"})
                      try:
                          urllib.request.urlopen(req, timeout=30).read()
                          k = "ok"
                      except urllib.error.HTTPError as e:
                          k = "refused" if e.code == 401 else "failed"
                      except Exception:
                          k = "failed"
                      with lock:
                          seen[k] += 1
              ts = [threading.Thread(target=work) for _ in range($workers)]
              [t.start() for t in ts]
              while any(t.is_alive() for t in ts):
                  time.sleep(15)
                  with lock:
                      print(time.strftime("%H:%M:%S"), json.dumps(seen), flush=True)
              print("done", json.dumps(seen), flush=True)
          env:
            - name: TOKEN
              valueFrom: { secretKeyRef: { name: $name-token, key: token } }
          resources:
            requests: { cpu: 200m, memory: 256Mi }
            limits: { cpu: "1", memory: 512Mi }
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            runAsUser: 1000
            capabilities: { drop: [ALL] }
            seccompProfile: { type: RuntimeDefault }
YAML
  say "follow it: kubectl --context kind-$CLUSTER -n $SERVING_NS logs -f job/rig-load"
}

watch_it() {
  while true; do
    date +%H:%M:%S
    k -n "$SERVING_NS" get hpa 2>/dev/null || true
    k -n "$SERVING_NS" get pods -l serving.kserve.io/inferenceservice --no-headers 2>/dev/null || true
    sleep 5
  done
}

down() {
  say "deleting the kind cluster $CLUSTER"
  # Docker can time out stopping a busy node on a slow disk; the second
  # attempt finds it stopped and removes it.
  "$KIND" delete cluster --name "$CLUSTER" || "$KIND" delete cluster --name "$CLUSTER"
  rm -rf "$STATE"
}

case "${1:-}" in
  up) up ;;
  app-env) shift; app_env "$@" ;;
  load) shift; load "$@" ;;
  watch) watch_it ;;
  down) down ;;
  *) echo "usage: run.sh up | app-env <file> | load <name> [seconds] [workers] | watch | down" >&2; exit 2 ;;
esac
