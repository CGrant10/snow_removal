"""
Moves all three version strings at once.

    python tools/bump_version.py 1.2.1
    python tools/bump_version.py            # just report what's there

They have to agree:

    updater.js   APP_VERSION  what the app believes it is
    sw-core.js   VERSION      names the cache; changing it evicts old files
    version.txt  the string the running app polls to notice an update

If version.txt drifts behind, the app offers an update that never resolves.
If it runs ahead, nobody is ever told there's a new version. Use this instead
of editing them by hand.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TARGETS = [
    (ROOT / "updater.js", re.compile(r'(APP_VERSION\s*=\s*")([^"]+)(")')),
    (ROOT / "sw-core.js", re.compile(r'(VERSION\s*=\s*"v)([^"]+)(")')),
]
VERSION_TXT = ROOT / "version.txt"


def current() -> dict[str, str]:
    found = {}
    for path, pattern in TARGETS:
        m = pattern.search(path.read_text(encoding="utf-8"))
        found[path.name] = m.group(2) if m else "?"
    found["version.txt"] = (
        VERSION_TXT.read_text(encoding="utf-8").strip()
        if VERSION_TXT.exists() else "?"
    )
    return found


def report() -> bool:
    found = current()
    for name, value in found.items():
        print(f"  {name:<14} {value}")
    agree = len(set(found.values())) == 1
    print("  all in sync" if agree else "  !! MISMATCH — run this with a version to fix")
    return agree


def bump(version: str) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"'{version}' is not a x.y.z version")

    for path, pattern in TARGETS:
        text = path.read_text(encoding="utf-8")
        new, n = pattern.subn(rf"\g<1>{version}\g<3>", text, count=1)
        if not n:
            sys.exit(f"couldn't find the version string in {path.name}")
        path.write_text(new, encoding="utf-8", newline="\n")

    VERSION_TXT.write_text(version + "\n", encoding="utf-8", newline="\n")
    print(f"bumped to {version}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        bump(sys.argv[1])
    else:
        print("current versions:")
    report()
