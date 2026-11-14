#!/usr/bin/env bash
# Copy a published multi-arch image into this account's ECR, registry to
# registry (deploy/aws/terraform/modules/sandboxes runs it).
#
#   copy-image.sh <source image> <ECR image> <region>
#
# A Fargate sandbox has no route out, so it pulls from ECR through the VPC
# endpoints, never from ghcr.io. `docker buildx imagetools create` copies the
# whole index (amd64 and arm64) without pulling it here. Needs docker with
# buildx and the AWS CLI, signed in to the account (aws sso login).
# Idempotent: a tag ECR already has is left as it is (the repository's tags
# are immutable).
set -euo pipefail
SRC="${1:?source image}"
DST="${2:?destination ECR image}"
REGION="${3:?region}"
REGISTRY="${DST%%/*}"
REPO_AND_TAG="${DST#*/}"
REPO="${REPO_AND_TAG%:*}"
TAG="${REPO_AND_TAG##*:}"

for tool in docker aws; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "copy-image: $tool is not installed here. Install it, or copy $SRC to $DST yourself and set sandbox_image_override." >&2
    exit 1
  }
done

if aws ecr describe-images --region "$REGION" --repository-name "$REPO" \
     --image-ids imageTag="$TAG" >/dev/null 2>&1; then
  echo "copy-image: $DST is already there"
  exit 0
fi

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
echo "copy-image: $SRC -> $DST"
docker buildx imagetools create --tag "$DST" "$SRC"
