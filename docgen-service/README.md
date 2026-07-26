# AgentSwarms doc-gen service (optional)

A small **python-pptx** rendering service that produces PowerPoint decks with
**native, editable** charts / tables / KPI cards / text, and an optional
**LibreOffice render-verify loop** (rasterise the deck → a vision model reviews
the slide images → constrained fixes → re-render).

This is **optional and Node/Docker-only**. By default AgentSwarms generates decks
**in the browser** (pptxgenjs) — which works on every deploy including Cloudflare
Workers. When this service is configured the app uses it and **falls back to the
browser generator** if it's unreachable, so nothing breaks by default.

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

The render-verify loop additionally needs `OPENROUTER_API_KEY` on the container
(a vision-capable default model). Without it, rendering still works; only the
review/refine pass is skipped.

## How the app uses it

1. The browser plans the deck and **fills chart data from your real data** (BI
   analyst) + pre-renders each diagram to SVG.
2. It POSTs the filled plan to the app route `POST /api/docgen/pptx`, which
   forwards to this service's `POST /render`.
3. The service builds a native `.pptx` (charts/tables/text editable; diagrams
   embedded as images), optionally runs the verify loop, and returns the file +
   a first-slide thumbnail.

## Endpoints

- `GET /health` → `{ ok, soffice, verify_available }`
- `POST /render` → `{ pptx_base64, thumb, notes }`  (body: `{ plan, verify?, model? }`)

## Local dev (without Docker)

```bash
pip install -r requirements.txt
# LibreOffice + poppler must be on PATH for the verify loop / thumbnails
uvicorn app:app --host 0.0.0.0 --port 8099
```
