#!/bin/sh
# Say Anything AppImage launcher.
#
# Installed by scripts/after-pack.js in AppImage builds only, as the
# executable AppRun starts; the real Electron binary sits next to it as
# sayanything-bin. The Flatpak and the plain package don't use this file.
#
# Inside an AppImage, Chromium can't use its setuid sandbox helper (the image
# is mounted nosuid), so it falls back to a user-namespace sandbox. Some
# systems block that: Ubuntu 24.04+ restricts unprivileged user namespaces
# through AppArmor, and some kernels disable them outright. There, and only
# there, the app is started with --no-sandbox so it runs at all, and a notice
# is printed. Everywhere else Chromium keeps its sandbox. On Ubuntu the
# Flatpak keeps a sandbox and is the recommended download.
#
# SAYANYTHING_NO_SANDBOX=1 forces --no-sandbox, =0 never adds it.
# SAYANYTHING_PROC overrides /proc (tests only).

HERE=$(dirname "$(readlink -f "$0")")
PROC=${SAYANYTHING_PROC:-/proc}

sandbox_blocked() {
  [ "$(cat "$PROC/sys/kernel/apparmor_restrict_unprivileged_userns" 2>/dev/null)" = "1" ] && return 0
  [ "$(cat "$PROC/sys/kernel/unprivileged_userns_clone" 2>/dev/null)" = "0" ] && return 0
  [ "$(cat "$PROC/sys/user/max_user_namespaces" 2>/dev/null)" = "0" ] && return 0
  return 1
}

case "${SAYANYTHING_NO_SANDBOX:-auto}" in
  1) disable=1 ;;
  0) disable=0 ;;
  *) if sandbox_blocked; then disable=1; else disable=0; fi ;;
esac

if [ "$disable" = "1" ]; then
  echo "Say Anything: this system blocks the sandbox Chromium needs inside an AppImage, so it is starting without it. The Flatpak keeps a sandbox." >&2
  SAYANYTHING_SANDBOX_DISABLED=1
  export SAYANYTHING_SANDBOX_DISABLED
  exec "$HERE/sayanything-bin" --no-sandbox "$@"
fi
exec "$HERE/sayanything-bin" "$@"
