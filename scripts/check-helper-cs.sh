#!/usr/bin/env bash
# Compile-check native/SayAnythingHelper.cs on Linux/macOS with Mono's mcs,
# enforcing the C# 5 language level the Windows csc.exe accepts. This catches
# syntax errors and C# 6+ features without a Windows machine. It does NOT run
# the helper: Windows behaviour is still verified by the Windows CI job.
# Requires: mcs (Debian/Ubuntu: apt-get install mono-mcs mono-devel).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
mcs -langversion:5 -target:winexe -platform:x64 -warnaserror- \
  -r:System.dll -r:System.Windows.Forms.dll -r:System.Drawing.dll \
  -out:"$OUT/SayAnythingHelper.exe" "$HERE/native/SayAnythingHelper.cs"
echo "check-helper-cs: OK (C# 5 compile check passed)"
