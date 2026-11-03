#!/usr/bin/env bash
#
# build-whisper-linux.sh — build whisper.cpp's whisper-server for Linux and stage
# it at bin/whisper/whisper-server (docs/LINUX-PORT.md, phase 1 step 4).
#
# Like macOS, Linux has no official whisper-server release to download, so this
# script is the only producer of bin/whisper/whisper-server on Linux.
# binaries.js on Linux just checks that the file exists and is executable.
#
# Portability choices (the binary must run on other people's machines, not just
# the build host):
#   - Static ggml/whisper (BUILD_SHARED_LIBS=OFF): one file, no .so to ship.
#   - GGML_OPENMP=OFF: ggml's own thread pool, so no libgomp at runtime.
#   - x86_64: GGML_NATIVE=OFF with an explicit x86-64-v3 baseline (AVX, AVX2,
#     FMA, F16C). Covers the Steam Deck (Zen 2) and PCs from ~2013 (Haswell)
#     on; never -march=native, which would bake in the build machine's CPU.
#   - aarch64: GGML_NATIVE=OFF (NEON is the baseline there).
#   - CPU only for now. A Vulkan build for GPUs is a later option.
# The result links only glibc, libstdc++, libm and libgcc_s (checked below).
#
# Usage:
#   scripts/build-whisper-linux.sh
#
# Env overrides (all optional):
#   WHISPER_CPP_REPO_URL   git remote to clone (default: upstream ggml-org repo)
#   WHISPER_CPP_TAG        tag to build (default: v1.9.1)
#   WHISPER_CPP_COMMIT     commit the tag must resolve to (default: the pinned
#                          v1.9.1 commit, same as build-whisper-mac.sh)
#   WHISPER_CPP_SRC_DIR    where to clone/reuse the source tree
#                          (default: ${XDG_CACHE_HOME:-~/.cache}/SayAnything/whisper-build/whisper.cpp)
#   JOBS                   parallel build jobs (default: nproc)
#
# Re-running is safe: an existing clone at the right tag is reused and the
# cmake build is incremental.

set -euo pipefail

REPO_URL="${WHISPER_CPP_REPO_URL:-https://github.com/ggml-org/whisper.cpp}"
TAG="${WHISPER_CPP_TAG:-v1.9.1}"
# Same pin as build-whisper-mac.sh: tags can be moved, commits cannot.
PINNED_COMMIT="${WHISPER_CPP_COMMIT:-f049fff95a089aa9969deb009cdd4892b3e74916}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="${WHISPER_CPP_SRC_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/SayAnything/whisper-build/whisper.cpp}"
BUILD_DIR="$SRC_DIR/build-linux"
STAGE_DIR="$WORKSPACE_ROOT/bin/whisper"
STAGE_BIN="$STAGE_DIR/whisper-server"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

log() { printf '[build-whisper-linux] %s\n' "$*" >&2; }
die() { printf '[build-whisper-linux] ERROR: %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO (see above for the command that failed)"' ERR

case "${1:-}" in
  -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) die "unknown argument: $1 (see --help)" ;;
esac

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
[[ "$(uname -s)" == "Linux" ]] || die "this script only builds on Linux (got $(uname -s))"
for tool in git cmake c++ ldd; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH (install git, cmake and a C++ compiler)"
done
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  CPU_FLAGS=(-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON) ;;
  aarch64) CPU_FLAGS=(-DGGML_NATIVE=OFF) ;;
  *) die "unsupported architecture $ARCH (want x86_64 or aarch64)" ;;
esac
log "repo=$REPO_URL tag=$TAG arch=$ARCH src=$SRC_DIR jobs=$JOBS"

# ---------------------------------------------------------------------------
# 2. Clone (shallow, pinned) or reuse an existing clone at that tag
# ---------------------------------------------------------------------------
if [[ -d "$SRC_DIR/.git" ]]; then
  current_tag="$(git -C "$SRC_DIR" describe --tags --exact-match 2>/dev/null || true)"
  if [[ "$current_tag" == "$TAG" ]]; then
    log "reusing existing clone at $SRC_DIR (already at $TAG)"
  else
    log "existing clone is at '${current_tag:-<no tag>}', re-pointing to $TAG"
    git -C "$SRC_DIR" fetch --depth 1 origin tag "$TAG"
    git -C "$SRC_DIR" checkout --force "tags/$TAG"
  fi
else
  [[ -e "$SRC_DIR" ]] && die "$SRC_DIR exists but is not a git repo; remove it and re-run"
  log "cloning $REPO_URL @ $TAG (shallow) into $SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --branch "$TAG" --depth 1 "$REPO_URL" "$SRC_DIR"
fi
actual_commit="$(git -C "$SRC_DIR" rev-parse HEAD)"
[[ "$actual_commit" == "$PINNED_COMMIT" ]] || die "tag $TAG resolves to $actual_commit, expected pinned $PINNED_COMMIT (tag moved? refusing to build)"
log "source confirmed at $TAG, commit $actual_commit (pinned)"

# ---------------------------------------------------------------------------
# 3. Configure + build
# ---------------------------------------------------------------------------
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  "${CPU_FLAGS[@]}" \
  -DGGML_OPENMP=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_SDL2=OFF \
  -DWHISPER_CURL=OFF
cmake --build "$BUILD_DIR" --config Release --target whisper-server -j "$JOBS"

BUILT="$BUILD_DIR/bin/whisper-server"
[[ -x "$BUILT" ]] || die "built binary not found at $BUILT"

# ---------------------------------------------------------------------------
# 4. Verify: no unexpected shared libraries, binary runs
# ---------------------------------------------------------------------------
unexpected="$(ldd "$BUILT" | awk '{print $1}' | grep -Ev '^(linux-vdso\.so|linux-gate\.so|/lib.*/ld-linux.*|ld-linux.*|libc\.so|libm\.so|libstdc\+\+\.so|libgcc_s\.so|libpthread\.so|libdl\.so|librt\.so)' || true)"
[[ -z "$unexpected" ]] || die "whisper-server links unexpected shared libraries: $unexpected"
"$BUILT" --help >/dev/null 2>&1 || die "whisper-server --help failed"
"$BUILT" --help 2>&1 | grep -q -- '--request-path' || die "whisper-server has no --request-path flag (the app relies on it)"

# ---------------------------------------------------------------------------
# 5. Stage atomically
# ---------------------------------------------------------------------------
mkdir -p "$STAGE_DIR"
tmp="$STAGE_BIN.tmp.$$"
cp -f "$BUILT" "$tmp"
strip "$tmp" 2>/dev/null || true
chmod 0755 "$tmp"
mv -f "$tmp" "$STAGE_BIN"
log "staged $STAGE_BIN ($(du -h "$STAGE_BIN" | cut -f1), sha256 $(sha256sum "$STAGE_BIN" | cut -c1-16)...)"
