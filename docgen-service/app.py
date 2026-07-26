"""
AgentSwarms doc-gen service — FastAPI wrapper around the python-pptx renderer
and the optional LibreOffice render-verify loop.

Endpoints:
  GET  /health                 → liveness + capability flags
  POST /render       { plan, verify?, model?, verify_rounds? }
       → { pptx_base64, thumb, notes[] }        (PowerPoint)
  POST /render/docx  { plan }
       → { docx_base64, thumb }                 (Word, python-docx)
  POST /render/xlsx  { plan }
       → { xlsx_base64, thumb }                 (Excel, openpyxl + LO recalc)

Auth: a shared bearer token (env DOCGEN_TOKEN) the app sends; if unset, open
(intended for a private in-network service only).
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
from verify import apply_fixes, critique, first_thumb, pptx_to_images

app = FastAPI(title="AgentSwarms doc-gen")

HAS_SOFFICE = shutil.which("soffice") is not None


class RenderRequest(BaseModel):
    plan: dict[str, Any]
    verify: bool = False
    model: str | None = None
    verify_rounds: int = 1


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
        "verify_available": HAS_SOFFICE and bool(os.environ.get("OPENROUTER_API_KEY")),
        "formats": ["pptx", "docx", "xlsx"],
    }


@app.post("/render")
def render(req: RenderRequest, authorization: str | None = Header(default=None)):
    _check_auth(authorization)
    plan = req.plan
    notes: list[str] = []
    try:
        pptx = render_pptx(plan)
    except Exception as e:  # renderer failure → let the caller fall back
        raise HTTPException(status_code=500, detail=f"render failed: {e}")

    if req.verify and HAS_SOFFICE and os.environ.get("OPENROUTER_API_KEY"):
        for _ in range(max(0, min(req.verify_rounds, 2))):
            images = pptx_to_images(pptx)
            if not images:
                break
            fixes = critique(images, plan, req.model)
            note = fixes.get("summary") if isinstance(fixes, dict) else None
            if note:
                notes.append(str(note))
            if not apply_fixes(plan, fixes):
                break
            try:
                pptx = render_pptx(plan)
            except Exception:
                break

    thumb = first_thumb(pptx) if HAS_SOFFICE else None
    return {
        "pptx_base64": base64.b64encode(pptx).decode(),
        "thumb": thumb,
        "notes": notes,
    }


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
