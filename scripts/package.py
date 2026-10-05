"""Validate and package only the loadable extension, using the standard library."""
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"


def main():
    subprocess.run(["node", str(ROOT / "scripts" / "check.mjs")], cwd=ROOT, check=True)
    version = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["version"]
    target = ROOT / "dist" / f"yt-nyan-play-{version}.zip"
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for source in sorted(EXTENSION.rglob("*")):
            if not source.is_file():
                continue
            entry = zipfile.ZipInfo(source.relative_to(EXTENSION).as_posix(), (2026, 10, 5, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, source.read_bytes())
    print(f"Created {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
