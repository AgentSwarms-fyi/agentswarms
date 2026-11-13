#!/usr/bin/env bash
# The sandbox image: the kernel gateway starts and answers only to the
# session's token (R466), and the libraries notebooks import are there.
. "$(dirname "$0")/lib.sh"
PORT=18888
TOKEN="smoke-$(date +%s)-$$"

echo "== $IMAGE"
not_root

docker run --rm --entrypoint python "$IMAGE" -c \
  "import duckdb, pandas, pyarrow, sklearn, pyspark, langchain, fastmcp, httpx; print('imports ok, duckdb', duckdb.__version__)" \
  | sed 's/^/  | /' || fail "the notebook libraries do not import"
ok "duckdb, pandas, pyarrow, scikit-learn, pyspark, langchain, fastmcp and httpx import"

start -p 127.0.0.1:$PORT:8888 -e KG_AUTH_TOKEN="$TOKEN" "$IMAGE"
wait_for_status "http://127.0.0.1:$PORT/api" 120 401
ok "the kernel gateway refuses a request without the token (401)"
code=$(status_of -H "Authorization: token $TOKEN" "http://127.0.0.1:$PORT/api")
[ "$code" = "200" ] || fail "with the token, /api answered $code"
ok "and answers one with it (200)"
echo "PASSED"
