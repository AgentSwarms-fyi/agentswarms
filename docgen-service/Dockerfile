# AgentSwarms doc-gen service: python-pptx renderer + LibreOffice render-verify.
# Optional, self-hosted (Node/Docker deploys only) — the app falls back to the
# in-browser pptxgenjs generator when this service isn't configured.
# The base is pinned by digest (R406, VA-25). The bare tag had frozen on
# whatever this host first pulled, two months old, with nothing to say so.
# Dependabot proposes the next digest weekly, and the image-scan workflow
# reads what it brings.
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159

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
# The base's pip is 25.0.1, with six advisories fixed in the 26 releases
# (grype, R406). Upgraded first, so the requirements install runs on it.
RUN pip install --no-cache-dir --upgrade "pip>=26.2"
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

EXPOSE 8099
# HOME is needed so LibreOffice can create its profile dir.
ENV HOME=/tmp
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8099", "--workers", "2"]
