#!/bin/sh
# Flatpak launcher. zypak (from the Electron BaseApp) provides Chromium's
# sandbox inside the Flatpak; --ozone-platform-hint=auto runs natively on
# Wayland and falls back to X11.
exec zypak-wrapper /app/lib/sayanything/sayanything --ozone-platform-hint=auto "$@"
