"""
Render-verify loop: rasterise the generated .pptx with LibreOffice, show the
slide images to a vision LLM, get structured fixes, apply them, and re-render.

Kept deliberately CONSTRAINED — the model may only request safe adjustments
(shrink a slide's title, trim overflowing bullets, drop an empty visual) so a
bad suggestion can never corrupt the deck. Best-effort: any failure returns the
deck unchanged.
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
from typing import Any

import httpx
from pdf2image import convert_from_path

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def pptx_to_images(pptx_bytes: bytes, max_slides: int = 12) -> list[bytes]:
    """LibreOffice → PDF → PNG per slide. Returns [] if soffice is unavailable."""
    with tempfile.TemporaryDirectory() as d:
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
            return []
        pdf = os.path.join(d, "deck.pdf")
        if not os.path.exists(pdf):
            return []
        try:
            pages = convert_from_path(pdf, dpi=90)
        except Exception:
            return []
        out: list[bytes] = []
        for pg in pages[:max_slides]:
            buf = tempfile.SpooledTemporaryFile()
            import io
            b = io.BytesIO()
            pg.save(b, format="PNG")
            out.append(b.getvalue())
            buf.close()
        return out


def first_thumb(pptx_bytes: bytes) -> str | None:
    imgs = pptx_to_images(pptx_bytes, max_slides=1)
    if not imgs:
        return None
    return "data:image/png;base64," + base64.b64encode(imgs[0]).decode()


def critique(images: list[bytes], plan: dict[str, Any], model: str | None) -> dict[str, Any]:
    """Ask a vision model for constrained per-slide fixes. Returns {} on any error."""
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key or not images:
        return {}
    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                "You are a presentation design reviewer. These are rendered slides of a deck "
                "(slide 1 is the cover). Identify ONLY real problems: text overflowing its box, "
                "text clipped/cut off, unreadable low contrast, or an empty/blank visual area. "
                "Return STRICT JSON: {\"fixes\":[{\"slide\":<1-based content-slide index EXCLUDING the "
                "cover>,\"action\":\"shrink_title\"|\"trim_bullets\"|\"drop_visual\",\"reason\":\"...\"}]}. "
                "If the deck looks good, return {\"fixes\":[]}. Max 6 fixes."
            ),
        }
    ]
    for img in images[:10]:
        content.append({
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64," + base64.b64encode(img).decode()},
        })
    try:
        r = httpx.post(
            OPENROUTER_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": model or os.environ.get("OPENROUTER_DEFAULT_MODEL", "openai/gpt-4o-mini"),
                "messages": [{"role": "user", "content": content}],
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
            timeout=90,
        )
        r.raise_for_status()
        txt = r.json()["choices"][0]["message"]["content"]
        return json.loads(txt)
    except Exception:
        return {}


def _has_text(slide: dict[str, Any]) -> bool:
    """Does the slide still say something once its visual is gone?"""
    return bool(slide.get("bullets") or slide.get("paragraph") or slide.get("table")
                or slide.get("kpis"))


def apply_fixes(plan: dict[str, Any], fixes: dict[str, Any]) -> bool:
    """Apply the constrained fixes to the plan in place. Returns True if changed.
    `slide` is 1-based over the content slides (the auto cover is not counted)."""
    slides = plan.get("slides", [])
    changed = False
    for fix in (fixes.get("fixes") or [])[:6]:
        idx = int(fix.get("slide", 0)) - 1
        if idx < 0 or idx >= len(slides):
            continue
        s = slides[idx]
        action = fix.get("action")
        if action == "shrink_title" and s.get("title"):
            s["title"] = s["title"][:70]
            changed = True
        elif action == "trim_bullets" and s.get("bullets"):
            s["bullets"] = [b[:90] for b in s["bullets"][:4]]
            changed = True
        elif action == "drop_visual":
            # The reviewer flags a blank visual and asks us to remove it — but
            # on a slide whose ONLY content IS that visual, removing it leaves a
            # title over white space. That turned "chart didn't fill" into "slide
            # is empty", and it happened in Deep mode only, because only Deep
            # runs this loop. Promote the notes to body text so the slide still
            # carries its point; refuse the fix outright if there is nothing to
            # promote, since a weak visual beats a blank slide.
            if not _has_text(s):
                notes = str(s.get("notes") or "").strip()
                takeaway = str(s.get("takeaway") or "").strip()
                body = notes or takeaway
                if not body:
                    continue
                s["paragraph"] = body[:600]
            s.pop("chart", None)
            s.pop("diagram", None)
            s.pop("diagramSvg", None)
            changed = True
    return changed
