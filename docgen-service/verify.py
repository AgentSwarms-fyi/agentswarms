"""
Rasterise a generated .pptx with LibreOffice: PDF, then images of its slides.

The images serve the thumbnail and Deep mode's slide review. The review itself
(the vision model, its constrained fixes) runs in the app as the user, since
R405: src/lib/docGen/deckReview.ts and src/utils/deckReview.server.ts. This
service holds no model key and makes no outbound call.
"""
from __future__ import annotations

import io
import os
import subprocess
import tempfile

from pdf2image import convert_from_path

THUMB_DPI = 90
# Review slides go to a model inside one request, and the app's chat channel
# refuses a request over 500k characters. Ten 90 dpi PNGs, base64-encoded,
# came to more than that, so the first live review was refused (413). At
# 48 dpi a 13.33 in slide is 640 px wide, enough to see overflowing or
# clipped text; as JPEG it is a few tens of kilobytes.
REVIEW_DPI = 48
REVIEW_JPEG_QUALITY = 70


def _to_pdf(pptx_bytes: bytes, d: str) -> str | None:
    src = os.path.join(d, "deck.pptx")
    with open(src, "wb") as f:
        f.write(pptx_bytes)
    try:
        subprocess.run(
            ["soffice", f"-env:UserInstallation=file://{os.path.join(d, 'lo')}",
             "--headless", "--convert-to", "pdf", "--outdir", d, src],
            check=True, timeout=120, capture_output=True,
        )
    except Exception:
        return None
    pdf = os.path.join(d, "deck.pdf")
    return pdf if os.path.exists(pdf) else None


def _pages(pdf: str, dpi: int, last: int, fmt: str) -> list[bytes]:
    try:
        # Only the pages asked for: a thumbnail needs one, not the deck.
        pages = convert_from_path(pdf, dpi=dpi, last_page=last)
    except Exception:
        return []
    out: list[bytes] = []
    for pg in pages[:last]:
        b = io.BytesIO()
        if fmt == "JPEG":
            pg.convert("RGB").save(b, format="JPEG", quality=REVIEW_JPEG_QUALITY, optimize=True)
        else:
            pg.save(b, format="PNG")
        out.append(b.getvalue())
    return out


def slide_images(pptx_bytes: bytes, review_slides: int = 0) -> tuple[bytes | None, list[bytes]]:
    """One LibreOffice run: the first slide as a PNG thumbnail and, when asked,
    the first `review_slides` slides as small JPEGs. (None, []) without soffice."""
    with tempfile.TemporaryDirectory() as d:
        pdf = _to_pdf(pptx_bytes, d)
        if not pdf:
            return None, []
        thumb = _pages(pdf, THUMB_DPI, 1, "PNG")
        review = _pages(pdf, REVIEW_DPI, review_slides, "JPEG") if review_slides > 0 else []
        return (thumb[0] if thumb else None), review
