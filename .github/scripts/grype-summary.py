"""Helpers for .github/workflows/image-scan.yml (VA-2026-10-25-25).

  grype-summary.py REPORT.json         markdown for the run summary: findings by
                                       severity, how many have a fixed version,
                                       and the fixable critical and high ones
  grype-summary.py --compose-images F  the third-party images docker-compose.yml
                                       runs, one per line (what scan.sh reads)

Standard library only: the runner's python3 has no PyYAML guarantee.
"""
from __future__ import annotations

import json
import re
import sys

SEVERITIES = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"]


def compose_images(path: str) -> list[str]:
    seen: list[str] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*image:\s*([^\s#]+)", line)
            if m and not m.group(1).startswith("agentswarms/") and m.group(1) not in seen:
                seen.append(m.group(1))
    return seen


def summary(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        report = json.load(f)
    counts = {s: [0, 0] for s in SEVERITIES}
    fixable: list[tuple[str, str, str, str, str]] = []
    for m in report.get("matches", []):
        v = m.get("vulnerability", {})
        sev = v.get("severity", "Unknown")
        sev = sev if sev in counts else "Unknown"
        fixed = [x for x in (v.get("fix", {}).get("versions") or []) if x]
        counts[sev][0] += 1
        if fixed:
            counts[sev][1] += 1
            if sev in ("Critical", "High"):
                a = m.get("artifact", {})
                fixable.append((sev, a.get("name", "?"), a.get("version", "?"), fixed[0], v.get("id", "?")))
    lines = ["| Severity | Findings | With a fix |", "| --- | ---: | ---: |"]
    lines += [f"| {s} | {n} | {f} |" for s, (n, f) in counts.items() if n]
    if len(lines) == 2:
        lines.append("| (none) | 0 | 0 |")
    if fixable:
        fixable.sort(key=lambda r: (SEVERITIES.index(r[0]), r[1]))
        lines += ["", "Fixable critical and high:", "", "| Severity | Package | Installed | Fixed in | Advisory |",
                  "| --- | --- | --- | --- | --- |"]
        lines += [f"| {s} | {n} | {i} | {fx} | {vid} |" for s, n, i, fx, vid in fixable[:25]]
        if len(fixable) > 25:
            lines.append(f"| … | {len(fixable) - 25} more in the report | | | |")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--compose-images":
        print("\n".join(compose_images(sys.argv[2])))
    elif len(sys.argv) == 2:
        sys.stdout.write(summary(sys.argv[1]))
    else:
        sys.exit(__doc__)
