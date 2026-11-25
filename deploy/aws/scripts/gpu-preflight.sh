#!/usr/bin/env bash
# Can this AWS account run the GPU training pool? (R537)
#
#   deploy/aws/scripts/gpu-preflight.sh [region] [instance type] [max nodes] [ON_DEMAND|SPOT] [AZs]
#   deploy/aws/scripts/gpu-preflight.sh us-east-1 g6.xlarge 2
#
# Run it before `terraform apply -var gpu_node_max=N` on deploy/aws/terraform/eks.
# A GPU node group applies fine with a quota of 0 and then never starts a
# node: the training job just waits. New accounts usually start at 0 for GPU
# instances. It checks, and says what to do when one fails:
#   1. the instance type exists in the region, has an NVIDIA GPU and is x86
#      (the pool's AMI is AL2023_x86_64_NVIDIA);
#   2. it is offered in at least one of the availability zones the cluster
#      uses: the region's first AZs (2, or 3 on the larger sizes);
#   3. the account's vCPU quota for that instance family covers max nodes.
# Read-only: describe and get calls only. Needs the AWS CLI, signed in.
# Exits 0 when everything passes, 1 when something would stop the pool.
set -uo pipefail
REGION="${1:-${AWS_REGION:-us-east-1}}"
TYPE="${2:-g6.xlarge}"
MAX="${3:-2}"
CAPACITY="${4:-ON_DEMAND}"
AZ_COUNT="${5:-2}"
fail=0
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fail=1; }
warn() { printf '  note  %s\n' "$*"; }

command -v aws >/dev/null 2>&1 || { echo "gpu-preflight: the AWS CLI is not installed here." >&2; exit 1; }
case "$MAX" in '' | *[!0-9]*) echo "gpu-preflight: max nodes must be a whole number, not '$MAX'." >&2; exit 1 ;; esac
case "$CAPACITY" in ON_DEMAND | SPOT) ;; *) echo "gpu-preflight: capacity is ON_DEMAND or SPOT, not '$CAPACITY'." >&2; exit 1 ;; esac

echo "GPU pool preflight: $MAX x $TYPE ($CAPACITY) in $REGION"

echo "1. The instance type"
read -r VCPUS GPUS GPU_NAME GPU_MAKER GPU_MIB ARCH < <(
  aws ec2 describe-instance-types --region "$REGION" --instance-types "$TYPE" \
    --query 'InstanceTypes[0].[VCpuInfo.DefaultVCpus, GpuInfo.Gpus[0].Count, GpuInfo.Gpus[0].Name, GpuInfo.Gpus[0].Manufacturer, GpuInfo.Gpus[0].MemoryInfo.SizeInMiB, ProcessorInfo.SupportedArchitectures[0]]' \
    --output text 2>/dev/null || echo "ERROR"
)
if [ "${VCPUS:-ERROR}" = "ERROR" ] || [ -z "${VCPUS:-}" ] || [ "$VCPUS" = "None" ]; then
  bad "$TYPE is not an instance type in $REGION (or the CLI is not signed in: aws sts get-caller-identity)."
  exit 1
fi
if [ "${GPUS:-None}" = "None" ] || [ "${GPU_MAKER:-}" != "NVIDIA" ]; then
  bad "$TYPE has no NVIDIA GPU. Pick a g4dn, g5, g6, g6e or p family type."
else
  ok "$TYPE: $GPUS x $GPU_MAKER $GPU_NAME ($((GPU_MIB / 1024)) GiB), $VCPUS vCPU"
fi
if [ "${ARCH:-}" != "x86_64" ]; then
  bad "$TYPE is $ARCH; the GPU pool's AMI (AL2023_x86_64_NVIDIA) is x86 only."
fi

echo "2. Where it is offered"
read -r -a AZS < <(aws ec2 describe-availability-zones --region "$REGION" \
  --filters Name=opt-in-status,Values=opt-in-not-required Name=state,Values=available \
  --query 'AvailabilityZones[].ZoneName' --output text 2>/dev/null)
read -r -a OFFERED < <(aws ec2 describe-instance-type-offerings --region "$REGION" \
  --location-type availability-zone --filters "Name=instance-type,Values=$TYPE" \
  --query 'InstanceTypeOfferings[].Location' --output text 2>/dev/null)
USED=("${AZS[@]:0:$AZ_COUNT}")
hit=()
for az in "${USED[@]}"; do
  for o in "${OFFERED[@]}"; do [ "$az" = "$o" ] && hit+=("$az"); done
done
if [ "${#hit[@]}" -eq 0 ]; then
  bad "$TYPE is offered in ${OFFERED[*]:-no zone}, none of the cluster's zones (${USED[*]}). Pick another type, or another region."
elif [ "${#hit[@]}" -lt "${#USED[@]}" ]; then
  ok "$TYPE is offered in ${hit[*]} of the cluster's zones (${USED[*]}); GPU nodes start only there."
else
  ok "$TYPE is offered in every zone the cluster uses (${USED[*]})."
fi

echo "3. The account's quota"
case "$TYPE" in
  g* | vt*) family="G and VT"; od=L-DB2E81BA; spot=L-3819A6DF ;;
  p*) family="P"; od=L-417A185B; spot=L-7212CCBC ;;
  *) family=""; od=""; spot="" ;;
esac
if [ -z "$family" ]; then
  warn "no GPU quota known for the $TYPE family; check EC2's quotas in the console."
else
  code="$od"; label="Running On-Demand $family instances"
  if [ "$CAPACITY" = "SPOT" ]; then code="$spot"; label="All $family Spot Instance Requests"; fi
  have=$(aws service-quotas get-service-quota --region "$REGION" --service-code ec2 --quota-code "$code" \
    --query 'Quota.Value' --output text 2>/dev/null || echo "")
  need=$((VCPUS * MAX))
  have_int="${have%%.*}"
  if [ -z "$have_int" ] || [ "$have_int" = "None" ]; then
    warn "could not read the quota \"$label\" ($code); check it in the Service Quotas console."
  elif [ "$have_int" -lt "$need" ]; then
    bad "\"$label\" is $have_int vCPU; $MAX x $TYPE needs $need. Ask for more (approval can take a day):"
    echo "        aws service-quotas request-service-quota-increase --region $REGION --service-code ec2 --quota-code $code --desired-value $need"
  else
    ok "\"$label\" is $have_int vCPU; $MAX x $TYPE needs $need."
  fi
fi

if [ "$fail" -eq 0 ]; then
  echo "Ready: terraform apply -var gpu_node_max=$MAX -var 'gpu_instance_types=[\"$TYPE\"]' -var gpu_capacity_type=$CAPACITY"
else
  echo "Not ready: fix what failed above, then run this again."
fi
exit "$fail"
