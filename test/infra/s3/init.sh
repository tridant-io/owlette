#!/bin/sh
# Bucket initialisation for the roost S3 stand-in (versitygw), local and CI.
#
# Mirrors infra/r2/r2-bucket-policy.json — the same default-deny posture
# applied to production Cloudflare R2. Anonymous requests are refused;
# signed URLs minted by the web API (which has root credentials here,
# R2 IAM creds in production) are the only path to read/write objects.
# The gateway refuses unsigned requests on its own, so the buckets carry
# no policy — the check at the end is what proves the posture.
#
# Idempotent — re-running against a live gateway is a no-op.

set -e

S3_URL="${S3_URL:-http://s3:9000}"
BUCKETS="owlette-dev-content owlette-dev-manifests"

for bucket in ${BUCKETS}; do
  if aws --endpoint-url "${S3_URL}" s3api head-bucket --bucket "${bucket}" > /dev/null 2>&1; then
    echo "==> bucket ${bucket} already exists"
  else
    echo "==> creating bucket ${bucket}"
    aws --endpoint-url "${S3_URL}" s3api create-bucket --bucket "${bucket}" > /dev/null
  fi
done

# Sanity-check: an unsigned listing must be refused, which is how an end
# user sees the bucket via its public URL.
echo "==> sanity-checking anonymous access is denied"
for bucket in ${BUCKETS}; do
  if aws --endpoint-url "${S3_URL}" --no-sign-request s3api list-objects-v2 --bucket "${bucket}" > /dev/null 2>&1; then
    echo "FAIL: anonymous listing of ${bucket} succeeded — default-deny broken"
    exit 1
  fi
done

echo "==> init complete."
echo "    API:    ${S3_URL}"
echo "    bucket: ${BUCKETS}"
