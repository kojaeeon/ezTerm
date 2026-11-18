"""Stage the pinned Helix release for ezTerm installers and portable packages."""

import argparse
import hashlib
from pathlib import Path
import shutil
import tarfile
import tempfile
from urllib.request import urlretrieve
import zipfile

VERSION = "25.07.1"
ASSETS = {
    "windows-x86_64": (
        "x86_64-windows.zip",
        "5c8325ced8bacd8418d62706f669e96d9c3578a9237526e34d546900cbc049b6",
    ),
    "linux-x86_64": (
        "x86_64-linux.tar.xz",
        "3f08e63ecd388fff657ad39722f88bb03dcf326f1f2da2700d99e1dc40ab2e8b",
    ),
    "linux-aarch64": (
        "aarch64-linux.tar.xz",
        "ce23fa8d395e633e3e54c052012f11965d91d8d5c2bfa659685f50430b4f8175",
    ),
    "macos-aarch64": (
        "aarch64-macos.tar.xz",
        "00b1651b4fdbbe0a2ae981c8e76b858bd26a7c33f5b3583f3b6bb9137d54f1ff",
    ),
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("platform", choices=ASSETS)
parser.add_argument("--archive", type=Path, help="Use an existing release archive")
args = parser.parse_args()
suffix, digest = ASSETS[args.platform]
asset = f"helix-{VERSION}-{suffix}"
release = f"https://github.com/helix-editor/helix/releases/tag/{VERSION}"
destination = Path(__file__).resolve().parents[1] / "src-tauri" / "helix"

with tempfile.TemporaryDirectory() as temporary:
    scratch = Path(temporary)
    archive = args.archive or scratch / asset
    if args.archive is None:
        urlretrieve(release.replace("/tag/", "/download/") + f"/{asset}", archive)
    with archive.open("rb") as contents:
        if hashlib.file_digest(contents, "sha256").hexdigest() != digest:
            raise SystemExit(f"SHA-256 mismatch for {asset}")

    extracted = scratch / "extracted"
    if suffix.endswith(".zip"):
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(extracted)
        binary = "hx.exe"
    else:
        with tarfile.open(archive) as bundle:
            bundle.extractall(extracted, filter="data")
        binary = "hx"

    programs = list(extracted.rglob(binary))
    if len(programs) != 1 or not (programs[0].parent / "runtime").is_dir():
        raise SystemExit(f"Missing Helix executable or runtime in {asset}")
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(programs[0].parent, destination)
    (destination / ".gitkeep").touch()
    (destination / "HELIX-SOURCE.txt").write_text(
        f"Helix {VERSION} is distributed under the Mozilla Public License 2.0.\n"
        f"Release and corresponding source code: {release}\n",
        encoding="utf-8",
    )
