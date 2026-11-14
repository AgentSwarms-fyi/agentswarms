#!/usr/bin/env bash
# Rehearse a deploy/aws/terraform root against AWS Emulator
# (https://github.com/aws/aws-emulator): every AWS API call goes to an
# emulator on this machine, in an emulated account (000000000000), and nothing
# reaches AWS. It finds what a plan cannot: requests AWS would refuse, wrong
# references between resources, an order that does not work. It cannot prove
# what needs real infrastructure (containers starting, DNS, a Kubernetes API),
# and the emulator is not AWS: a difference may be its own (see its fidelity
# scores and issues/ directory).
#
#   bash deploy/aws/emulator/run.sh <ecs|vm|eks> [plan|apply|destroy] [work dir]
#
# Needs Docker, Terraform 1.6+, curl, Python 3.9+. The Terraform is copied
# into a work directory (a new temporary one unless given) with a provider
# override that points it at the emulator; the repository is never changed.
# Terraform reaches the emulator through shim.py, a local proxy for two of the
# emulator's open issues (see its docstring).
set -uo pipefail
export MSYS_NO_PATHCONV=1
ROOT_NAME="${1:?usage: run.sh <ecs|vm|eks> [plan|apply|destroy] [work dir]}"
ACTION="${2:-apply}"
WORK="${3:-$(mktemp -d)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PORT=9297
IMAGE="agentswarms-aws-emulator:1.0.365"
NAME="agentswarms-aws-emulator"
case "$ROOT_NAME" in ecs | vm | eks) ;; *) echo "root must be ecs, vm or eks" >&2; exit 2 ;; esac
case "$ACTION" in plan | apply | destroy) ;; *) echo "action must be plan, apply or destroy" >&2; exit 2 ;; esac

win() { command -v cygpath >/dev/null 2>&1 && cygpath -m "$1" || echo "$1"; }
EMU_HOME="$HOME/.aws/emulator"
FILES="$EMU_HOME/$PORT"
mkdir -p "$EMU_HOME"

# One image build on the machine at a time: wait for anyone else's.
BUILD_LOCK_DIR="${BUILD_LOCK_DIR:-${TMPDIR:-/tmp}/agentswarms-build.lock}"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  until mkdir "$BUILD_LOCK_DIR" 2>/dev/null; do
    echo "waiting for another build: $(cat "$BUILD_LOCK_DIR/owner" 2>/dev/null)"
    sleep 15
  done
  echo "emulator image build (pid $$)" >"$BUILD_LOCK_DIR/owner"
  echo "== building $IMAGE"
  docker build -q -t "$IMAGE" "$(win "$HERE")" || { rm -rf "$BUILD_LOCK_DIR"; echo "image build failed" >&2; exit 1; }
  rm -rf "$BUILD_LOCK_DIR"
fi

# Request authentication is off because shim.py changes signed bodies. A
# container started otherwise (an older run.sh) is replaced, and with it the
# emulator's state, which lives only in memory.
EMU_ARGS="-p $PORT --telemetry off -a off"
if [ "$(docker inspect -f '{{.State.Running}} {{index .Config.Labels "agentswarms.emulator.args"}}' "$NAME" 2>/dev/null)" != "true $EMU_ARGS" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1
  echo "== starting the emulator on 127.0.0.1:$PORT"
  # shellcheck disable=SC2086 # EMU_ARGS is words on purpose
  docker run -d --name "$NAME" --label "agentswarms.emulator.args=$EMU_ARGS" \
    --memory=2g --memory-swap=2g -p "127.0.0.1:$PORT:$PORT" \
    -v "$(win "$EMU_HOME"):/home/emulator/.aws/emulator" \
    "$IMAGE" $EMU_ARGS >/dev/null || exit 1
fi
for _ in $(seq 1 60); do
  [ -f "$FILES/ca.pem" ] && curl -sf --cacert "$(win "$FILES/ca.pem")" "https://127.0.0.1:$PORT/__admin/health" >/dev/null && break
  sleep 2
done
curl -sf --cacert "$(win "$FILES/ca.pem")" "https://127.0.0.1:$PORT/__admin/health" >/dev/null \
  || { echo "the emulator did not answer"; docker logs --tail 20 "$NAME"; exit 1; }
echo "== emulator ready"

# The proxy Terraform reaches the emulator through (shim.py), for this run only.
SHIM_PORT=9298
PYTHON=""
for p in python3 python; do
  "$p" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null && PYTHON="$p" && break
done
[ -n "$PYTHON" ] || { echo "needs Python 3.9 or later" >&2; exit 1; }
mkdir -p "$WORK"
"$PYTHON" -I "$(win "$HERE/shim.py")" "$SHIM_PORT" "https://127.0.0.1:$PORT" "$(win "$FILES/ca.pem")" >"$WORK/shim.log" 2>&1 &
SHIM_PID=$!
trap 'kill $SHIM_PID 2>/dev/null' EXIT
for _ in $(seq 1 30); do
  [ "$(curl -s -x "http://127.0.0.1:$SHIM_PORT" http://aws.emulator.invalid/__admin/health)" = ok ] && break
  sleep 1
done
[ "$(curl -s -x "http://127.0.0.1:$SHIM_PORT" http://aws.emulator.invalid/__admin/health)" = ok ] \
  || { echo "the proxy did not answer"; cat "$WORK/shim.log"; exit 1; }

# The work copy, laid out as the repository's deploy/ is (the modules reach
# the Lambdas, the spec and the chart by relative path), and the override that
# sends it to the emulator. Copied again on every run, so a rerun tests the
# code as it is now; the state in the work directory is kept.
mkdir -p "$WORK/deploy"
cp -r "$REPO/deploy/aws" "$REPO/deploy/helm" "$WORK/deploy/"
rm -rf "$WORK/deploy/aws/emulator"
DIR="$WORK/deploy/aws/terraform/$ROOT_NAME"
override() {
  sed -e "s#__ENDPOINT__#http://aws.emulator.invalid#g" \
    -e "s#__PROXY__#http://127.0.0.1:$SHIM_PORT#" \
    -e "s#__CREDENTIALS__#$(win "$FILES/emulator_credentials")#" \
    -e "s#__CONFIG__#$(win "$FILES/config")#" \
    -e "s#__CA__#$(win "$FILES/ca.pem")#" \
    "$HERE/emulator_override.tf.tmpl"
}
override >"$DIR/emulator_override.tf"
# Where the emulator differs from AWS in a way no root should bend to, the
# work copy's modules get an override each (overrides/<module>.tf.tmpl), and
# the deploy Lambda a stand-in (run_task_stand_in.py).
for f in "$HERE"/overrides/*.tf.tmpl; do
  cp "$f" "$WORK/deploy/aws/terraform/modules/$(basename "$f" .tf.tmpl)/emulator_override.tf"
done
cp "$HERE/run_task_stand_in.py" "$WORK/deploy/aws/lambda/run-task/run_task.py"

# Nothing of the caller's own AWS identity reaches Terraform.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE
export AWS_SHARED_CREDENTIALS_FILE="$(win "$FILES/emulator_credentials")"
export AWS_CONFIG_FILE="$(win "$FILES/config")"
export AWS_CA_BUNDLE="$(win "$FILES/ca.pem")"
export AWS_EC2_METADATA_DISABLED=true AWS_DISABLE_HOST_PREFIX_INJECTION=true
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
export TF_IN_AUTOMATION=1 TF_INPUT=0

# What AWS manages in every account and the emulator does not hold
# (seed.tf.tmpl), in a state of its own so that destroying a root leaves it.
# One per emulator, as AWS has one per region, whichever work directory runs:
# kept beside the emulator's files, and made again if the emulator restarted.
if [ "$ACTION" != destroy ]; then
  SEED="$EMU_HOME/agentswarms-seed-$PORT"
  mkdir -p "$SEED"
  cp "$HERE/seed.tf.tmpl" "$SEED/main.tf"
  cp "$DIR/.terraform.lock.hcl" "$SEED/"
  override >"$SEED/emulator_override.tf"
  echo "== seeding what AWS manages ($SEED)"
  # (win: Terraform on Windows reads /c/Users as C:\c\Users.)
  (cd "$SEED" && export TF_DATA_DIR="$(win "$SEED")/.terraform" \
    && terraform init -no-color -input=false && terraform apply -no-color -auto-approve) >"$SEED/seed.log" 2>&1 \
    || { tail -20 "$SEED/seed.log"; exit 1; }
fi

VARS=(-var release=1.7.0 -var admin_email=emulated@example.com -var size=dev -var deletion_protection=false)
# A Fargate sandbox's image is copied into ECR with docker buildx at apply;
# against the emulator, name one instead.
[ "$ROOT_NAME" != "eks" ] && VARS+=(-var sandbox_image_override=000000000000.dkr.ecr.us-east-1.amazonaws.com/agentswarms/notebook-runtime:1.7.0)
TARGETS=()
if [ "$ROOT_NAME" = "eks" ]; then
  # The emulator has no Kubernetes API behind its EKS clusters, so the Helm
  # releases cannot be installed; everything AWS is. The roles are named too:
  # a targeted destroy removes what depends on a target, not what it uses.
  for t in module.network module.data module.secrets module.edge aws_iam_role.cluster \
    aws_iam_role_policy_attachment.cluster aws_iam_role.node aws_iam_role_policy_attachment.node aws_eks_cluster.this \
    aws_eks_node_group.app aws_eks_node_group.sandboxes aws_eks_addon.this aws_iam_role.pod \
    aws_iam_role_policy.pod aws_eks_pod_identity_association.this aws_budgets_budget.this; do
    TARGETS+=(-target="$t")
  done
fi

cd "$DIR" || exit 1
echo "== terraform init ($DIR)"
terraform init -no-color -input=false >init.log 2>&1 || { tail -20 init.log; exit 1; }
case "$ACTION" in
  plan) terraform plan -no-color "${VARS[@]}" "${TARGETS[@]}" ;;
  apply) terraform apply -no-color -auto-approve "${VARS[@]}" "${TARGETS[@]}" ;;
  destroy) terraform destroy -no-color -auto-approve "${VARS[@]}" "${TARGETS[@]}" ;;
esac
rc=$?
echo "== terraform $ACTION exited $rc (work dir: $WORK)"
exit $rc
