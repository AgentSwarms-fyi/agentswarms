# AgentSwarms doc-gen service (optional)

A small rendering service for the three Office formats:

- **PowerPoint** — **python-pptx** with **native, editable** charts / tables /
  KPI cards / text, and LibreOffice to rasterise the slides for Deep mode's
  review (the app shows them to a vision model, applies its constrained fixes,
  and asks for a second render).
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

The service needs no model key and makes no outbound call. Deep mode's slide
review used to run here, on the container's own `OPENROUTER_API_KEY` and with a
model the request named, outside every budget and trace. Since R405 the app
runs it as the user (`src/utils/deckReview.server.ts`): on the chat's model,
else the instance default, through the same channel as every other model call.

## How the app uses it

1. The browser plans the document and **fills numbers from your real data** (BI
   analyst) — chart data + diagram SVGs for decks, materialised SQL rows +
   live formulas for spreadsheets.
2. It POSTs the filled plan to the app route (`/api/docgen/pptx`, `/docx` or
   `/xlsx`), which forwards to this service.
3. The service builds the native file and returns it (base64) + a first-page
   thumbnail. For a Deep deck it also returns small JPEGs of the slides; the app has a
   vision model review them as the user, applies the fixes, and renders again.

## Endpoints

- `GET  /health` → `{ ok, soffice, verify_available, formats }`
- `POST /render` → `{ pptx_base64, thumb, images? }` (body: `{ plan, images? }`; `images: true`
  adds up to ten slides as small JPEG data URIs, 640 px wide, so a review fits
  in one request to the app's chat channel)
- `POST /render/docx` → `{ docx_base64, thumb }` (body: `{ plan }`)
- `POST /render/xlsx` → `{ xlsx_base64, thumb }` (body: `{ plan }`, sheets already materialised)

## Local dev (without Docker)

```bash
pip install -r requirements.txt
# LibreOffice (Impress + Writer + Calc) and poppler must be on PATH for slide
# images, Excel recalc, and thumbnails. On Debian/Ubuntu:
#   apt-get install libreoffice-impress libreoffice-writer libreoffice-calc poppler-utils
uvicorn app:app --host 0.0.0.0 --port 8099
```
