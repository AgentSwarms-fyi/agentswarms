#!/usr/bin/env bash
# The Office renderer image: it renders a deck, and LibreOffice (which makes
# the thumbnail) runs as the image's own unprivileged user (R469).
. "$(dirname "$0")/lib.sh"
PORT=18099

echo "== $IMAGE"
not_root

start -p 127.0.0.1:$PORT:8099 "$IMAGE"
wait_for_status "http://127.0.0.1:$PORT/health" 120
grep -q '"soffice":true' "$BODY_FILE" || fail "LibreOffice is missing: $(head -c 200 "$BODY_FILE")"
ok "/health: LibreOffice present"

# LibreOffice's first start in a fresh container takes a while.
code=$(MAX_TIME=180 status_of -X POST -H "Content-Type: application/json" \
  --data '{"plan":{"title":"Release smoke test","slides":[{"title":"One","bullets":["a","b"]}]}}' \
  "http://127.0.0.1:$PORT/render")
[ "$code" = "200" ] || fail "/render answered $code: $(head -c 200 "$BODY_FILE")"
grep -q '"pptx_base64":"UEsDB' "$BODY_FILE" || fail "/render returned no .pptx"
grep -q '"thumb":"data:image/png;base64,' "$BODY_FILE" || fail "no thumbnail: LibreOffice did not render"
ok "renders a deck, and LibreOffice renders its thumbnail"

# Writer and Calc are separate LibreOffice paths; Calc also recalculates the
# workbook's formulas through a profile of its own.
code=$(MAX_TIME=180 status_of -X POST -H "Content-Type: application/json" \
  --data '{"plan":{"title":"Release smoke test","blocks":[{"type":"paragraph","text":"One."}]}}' \
  "http://127.0.0.1:$PORT/render/docx")
[ "$code" = "200" ] || fail "/render/docx answered $code: $(head -c 200 "$BODY_FILE")"
grep -q '"docx_base64":"UEsDB' "$BODY_FILE" || fail "/render/docx returned no .docx"
grep -q '"thumb":"data:image/png;base64,' "$BODY_FILE" || fail "no .docx thumbnail: Writer did not render"
ok "renders a document, and Writer its thumbnail"
code=$(MAX_TIME=180 status_of -X POST -H "Content-Type: application/json" \
  --data '{"plan":{"sheets":[{"name":"S","headers":["a","b","sum"],"rows":[[2,3,"=A2+B2"]]}]}}' \
  "http://127.0.0.1:$PORT/render/xlsx")
[ "$code" = "200" ] || fail "/render/xlsx answered $code: $(head -c 200 "$BODY_FILE")"
grep -q '"xlsx_base64":"UEsDB' "$BODY_FILE" || fail "/render/xlsx returned no .xlsx"
grep -q '"thumb":"data:image/png;base64,' "$BODY_FILE" || fail "no .xlsx thumbnail: Calc did not render"
# The recalc is best-effort and silent when it fails: read the formula's
# cached value back, with the image's own openpyxl.
cached=$(docker run --rm -i --entrypoint python "$IMAGE" -c \
  "import sys,json,base64,io,openpyxl; d=json.load(sys.stdin); wb=openpyxl.load_workbook(io.BytesIO(base64.b64decode(d['xlsx_base64'])), data_only=True); print(wb['S']['C2'].value)" \
  <"$BODY_FILE") || fail "could not read the workbook back"
[ "$cached" = "5" ] || fail "=A2+B2 holds '$cached', not 5: Calc did not recalculate"
ok "renders a workbook, Calc recalculates =A2+B2 to 5 and renders it"
echo "PASSED"
