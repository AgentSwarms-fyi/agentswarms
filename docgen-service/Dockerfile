# AgentSwarms doc-gen service: python-pptx renderer + LibreOffice render-verify.
# Optional, self-hosted (Node/Docker deploys only) — the app falls back to the
# in-browser pptxgenjs generator when this service isn't configured.
FROM python:3.12-slim

# LibreOffice components: Impress (pptx→pdf for the verify loop), Writer
# (docx→pdf thumbnails) and Calc (xlsx formula recalc + thumbnails). Without
# Writer/Calc, soffice loads .pptx but reports "source file could not be loaded"
# for .docx/.xlsx. Plus poppler (pdf→png), cairo/pango (SVG rasterisation for
# diagrams), and fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress libreoffice-writer libreoffice-calc libreoffice-core \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
      poppler-utils fonts-dejavu fonts-liberation fontconfig \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

EXPOSE 8099
# HOME is needed so LibreOffice can create its profile dir.
ENV HOME=/tmp
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8099", "--workers", "2"]
