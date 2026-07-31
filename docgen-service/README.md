# AgentSwarms doc-gen service (optional)

A small rendering service for the three Office formats:

- **PowerPoint** — **python-pptx** with **native, editable** charts / tables /
  KPI cards / text, plus an optional **LibreOffice render-verify loop**
  (rasterise the deck → a vision model reviews the slide images → constrained
  fixes → re-render).
- **Word** — **python-docx**: a cover page, an updatable table-of-contents field,
  level-1 sections that each start a new page (multi-page output), and
  fixed-width bordered/shaded tables.
- **Excel** — **openpyxl** + a LibreOffice recalc pass so live formulas open
  showing their **computed values** (not blank cells) in any spreadsheet app.

This is **optional and Node/Docker-only**. By default AgentSwarms generates all
three formats **in the browser** (pptxgenjs / docx / write-excel-file) — which
works on every deploy. When this service is
configured the app uses it and **falls back to the browser generators** if it's
unreachable, so nothing breaks by default.

## Run it

```bash
docker compose --profile docgen up -d --build
```

Then point the app at it (in `.env`):

```bash
DOCGEN_SERVICE_URL=http://docgen:8099
# optional, if you set DOCGEN_TOKEN on the container, set the same here:
DOCGEN_TOKEN=your-shared-secret
```

The PowerPoint render-verify loop additionally needs `OPENROUTER_API_KEY` on the
container (a vision-capable default model). Without it, rendering still works;
only the review/refine pass is skipped.

## How the app uses it

1. The browser plans the document and **fills numbers from your real data** (BI
   analyst) — chart data + diagram SVGs for decks, materialised SQL rows +
   live formulas for spreadsheets.
2. It POSTs the filled plan to the app route (`/api/docgen/pptx`, `/docx` or
   `/xlsx`), which forwards to this service.
3. The service builds the native file and returns it (base64) + a first-page
   thumbnail.

## Endpoints

- `GET  /health` → `{ ok, soffice, verify_available, formats }`
- `POST /render` → `{ pptx_base64, thumb, notes }` (body: `{ plan, verify?, model? }`)
- `POST /render/docx` → `{ docx_base64, thumb }` (body: `{ plan }`)
- `POST /render/xlsx` → `{ xlsx_base64, thumb }` (body: `{ plan }`, sheets already materialised)

## Local dev (without Docker)

```bash
pip install -r requirements.txt
# LibreOffice (Impress + Writer + Calc) and poppler must be on PATH for the
# verify loop, Excel recalc, and thumbnails. On Debian/Ubuntu:
#   apt-get install libreoffice-impress libreoffice-writer libreoffice-calc poppler-utils
uvicorn app:app --host 0.0.0.0 --port 8099
```
