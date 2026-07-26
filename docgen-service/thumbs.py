"""
Generic first-page thumbnail for any office file (docx / xlsx / pptx) via
LibreOffice → PDF → PNG. Returns a data: URI, or None when soffice is missing
so the caller can fall back to its own SVG thumbnail.
"""
from __future__ import annotations

import base64
import io
import os
import subprocess
import tempfile

from pdf2image import convert_from_path


def office_first_thumb(data: bytes, suffix: str, dpi: int = 96) -> str | None:
    """Rasterise the first page of an office document as a PNG data URI."""
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, f"doc{suffix}")
        with open(src, "wb") as f:
            f.write(data)
        try:
            subprocess.run(
                ["soffice", f"-env:UserInstallation=file://{os.path.join(d, 'lo')}",
                 "--headless", "--convert-to", "pdf", "--outdir", d, src],
                check=True, timeout=120, capture_output=True,
            )
        except Exception:
            return None
        pdf = os.path.join(d, "doc.pdf")
        if not os.path.exists(pdf):
            return None
        try:
            pages = convert_from_path(pdf, dpi=dpi, first_page=1, last_page=1)
        except Exception:
            return None
        if not pages:
            return None
        b = io.BytesIO()
        pages[0].save(b, format="PNG")
        return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()
