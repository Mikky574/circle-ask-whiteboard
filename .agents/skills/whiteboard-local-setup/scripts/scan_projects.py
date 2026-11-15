"""Find project candidates inside explicitly chosen roots."""

import argparse
import json
import os
from pathlib import Path
import stat
import sys


MANIFESTS = {
    "package.json", "pyproject.toml", "setup.py", "requirements.txt", "environment.yml",
    "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "CMakeLists.txt",
}
SKIP_DIRS = {"__pycache__", "node_modules", "vendor", "dist", "build", "venv", "target"}


def candidate_markers(entries):
    markers = []
    for entry in entries:
        name = entry.name
        if name == ".git":
            markers.append(name)
        elif (name in MANIFESTS or name.lower().split(".")[0] == "readme"
              or name.lower().endswith((".sln", ".csproj"))) and entry.is_file(follow_symlinks=False):
            markers.append(name)
    return sorted(markers)


def scan(roots, depth):
    scanned_depths = {}
    candidates = {}
    pending = [(root, depth) for root in reversed(roots)]
    while pending:
        directory, remaining = pending.pop()
        key = os.path.normcase(str(directory))
        if scanned_depths.get(key, -1) >= remaining:
            continue
        scanned_depths[key] = remaining
        try:
            with os.scandir(directory) as listing:
                entries = sorted(listing, key=lambda entry: entry.name.casefold())
            markers = candidate_markers(entries)
            if markers:
                candidates[key] = {"path": str(directory), "markers": markers}
            if remaining == 0:
                continue
            for entry in reversed(entries):
                if entry.name.startswith(".") or entry.name.casefold() in SKIP_DIRS or not entry.is_dir(follow_symlinks=False):
                    continue
                attributes = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
                if not attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    pending.append((Path(entry.path), remaining - 1))
        except OSError as error:
            print(f"Could not finish scanning {directory}: {error}", file=sys.stderr)
    return list(candidates.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", type=Path, nargs="+", help="Directories to scan")
    parser.add_argument("--depth", type=int, default=2, help="Levels below each root (default: 2)")
    args = parser.parse_args()
    if args.depth < 0:
        parser.error("--depth must be nonnegative")
    roots = [path.resolve() for path in args.roots]
    for root in roots:
        if not root.is_dir():
            parser.error(f"Not a directory: {root}")
    print(json.dumps(scan(roots, args.depth), ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
