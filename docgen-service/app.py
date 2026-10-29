"""
AgentSwarms doc-gen service — FastAPI wrapper around the python-pptx renderer,
with LibreOffice for thumbnails and slide images.

Endpoints:
  GET  /health                 → liveness + capability flags
  POST /render       { plan, images? }
       → { pptx_base64, thumb, images? }        (PowerPoint)
  POST /render/docx  { plan }
       → { docx_base64, thumb }                 (Word, python-docx)
  POST /render/xlsx  { plan }
       → { xlsx_base64, thumb }                 (Excel, openpyxl + LO recalc)

Auth: a shared bearer token (env DOCGEN_TOKEN) the app sends; if unset, open
(intended for a private in-network service only).

The service calls no model. Deep mode's slide review used to run here, on this
container's own OpenRouter key and with whatever model the request named; the
app now runs it as the user (src/utils/deckReview.server.ts) on the images
`/render` returns with `images: true` (R405, VA-2026-10-25-37).
"""
from __future__ import annotations

import base64
import os
import shutil
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from renderer import render_pptx
from renderer_docx import render_docx
from renderer_xlsx import render_xlsx
from thumbs import office_first_thumb
from verify import slide_images

app = FastAPI(title="AgentSwarms doc-gen")

HAS_SOFFICE = shutil.which("soffice") is not None
# Slides returned for review; the app shows at most this many to the model.
MAX_IMAGES = 10


class RenderRequest(BaseModel):
    plan: dict[str, Any]
    # Return the rendered slides as small JPEG data URIs too, for the app's review.
    images: bool = False


class DocRenderRequest(BaseModel):
    plan: dict[str, Any]


def _check_auth(authorization: str | None):
    token = os.environ.get("DOCGEN_TOKEN", "").strip()
    if not token:
        return
    if authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
def health():
    return {
        "ok": True,
        "soffice": HAS_SOFFICE,
        # The review needs only the slide images; the app brings the model.
        "verify_available": HAS_SOFFICE,
        "formats": ["pptx", "docx", "xlsx"],
    }


@app.post("/render")
def render(req: RenderRequest, authorization: str | None = Header(default=None)):
    _check_auth(authorization)
    try:
        pptx = render_pptx(req.plan)
    except Exception as e:  # renderer failure → let the caller fall back
        raise HTTPException(status_code=500, detail=f"render failed: {e}")

    # One LibreOffice run serves both the thumbnail and the review slides.
    thumb, review = slide_images(pptx, MAX_IMAGES if req.images else 0) if HAS_SOFFICE else (None, [])
    out: dict[str, Any] = {
        "pptx_base64": base64.b64encode(pptx).decode(),
        "thumb": "data:image/png;base64," + base64.b64encode(thumb).decode() if thumb else None,
    }
    if req.images:
        out["images"] = ["data:image/jpeg;base64," + base64.b64encode(j).decode() for j in review]
    return out


@app.post("/render/docx")
def render_word(req: DocRenderRequest, authorization: str | None = Header(default=None)):
    _check_auth(authorization)
    try:
        docx = render_docx(req.plan)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"docx render failed: {e}")
    thumb = office_first_thumb(docx, ".docx") if HAS_SOFFICE else None
    return {"docx_base64": base64.b64encode(docx).decode(), "thumb": thumb}


@app.post("/render/xlsx")
def render_excel(req: DocRenderRequest, authorization: str | None = Header(default=None)):
    _check_auth(authorization)
    try:
        # recalc needs LibreOffice; skip it (formulas still valid) when absent.
        xlsx = render_xlsx(req.plan, recalc=HAS_SOFFICE)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"xlsx render failed: {e}")
    thumb = office_first_thumb(xlsx, ".xlsx") if HAS_SOFFICE else None
    return {"xlsx_base64": base64.b64encode(xlsx).decode(), "thumb": thumb}
