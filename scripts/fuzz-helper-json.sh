#!/usr/bin/env bash
# Fuzz the Windows helper's JSON command parser with Mono (Linux/macOS).
# Compiles native/SayAnythingHelper.cs together with test/helper-fuzz/JsonFuzz.cs
# (C# 5, JsonFuzz.Main as the entry point) and runs it. Requires mcs + mono.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
mcs -langversion:5 -nowarn:169,414,649 -main:JsonFuzz \
  -r:System.dll -r:System.Windows.Forms.dll -r:System.Drawing.dll \
  -out:"$OUT/fuzz.exe" "$HERE/native/SayAnythingHelper.cs" "$HERE/test/helper-fuzz/JsonFuzz.cs"
mono "$OUT/fuzz.exe"
