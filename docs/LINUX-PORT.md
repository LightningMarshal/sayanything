# Linux port plan

Status: **plan, not started.** Priority order agreed with the owner: Windows,
then Linux, then macOS. Linux was a non-goal upstream; this document is what
changes to make it a goal.

## What is already portable

Everything above the native helper: the Electron main process, renderers,
state machine, whisper client, formatter, rewrite, settings, history and the
JSON-lines helper protocol (`docs/CONTRACTS.md`). whisper.cpp builds on Linux
(CPU, or Vulkan/CUDA). Electron's `safeStorage` uses libsecret / KWallet when
a keyring is running, so history encryption works there too (and falls back to
plain JSON with a warning when it is not, see `src/main/stores/history.js`).

A Linux port is therefore one new helper (`native/linux/`) speaking the same
protocol, plus packaging (AppImage and .deb via electron-builder) and a few
`process.platform` branches (`config.js` paths, `binaries.js`, `helper.js`
spawn, `permissions.js`).

## The hard part: global hotkeys and text insertion

| Need | X11 | Wayland |
|---|---|---|
| Watch the hotkey (press and release) | XInput2 raw key events, filtered to watched keys inside the helper | No global key access for normal apps. Options: (a) **xdg-desktop-portal GlobalShortcuts** (press = Activated, release = Deactivated; supported by KDE Plasma 5.27+ and GNOME 48+; the user approves the binding once), (b) reading `/dev/input` (evdev), which needs the `input` group and lets the process see every keystroke |
| "Chord" bit (WS-5) | Yes, from the same XInput2 stream | Portal: not available (the compositor only reports the shortcut) |
| Insert text | XTest Ctrl+V after a clipboard swap, or XTest unicode via keysym remapping | **RemoteDesktop portal** (user prompt per session), `wtype` (wlroots compositors only), `ydotool` (uinput, needs a root daemon) |
| Clipboard | X selections (CLIPBOARD) | `wl-clipboard`, or Electron's own clipboard from the main process |
| Clipboard-history opt-out | `x-kde-passwordManagerHint=secret` MIME type (KDE Klipper), most managers ignore | Same hint; GNOME extensions vary |
| Foreground app (history "app") | `_NET_ACTIVE_WINDOW` + `_NET_WM_PID` | Not available to normal apps (leave blank) |
| Drop pad "place at point" | XTest move + click | Not possible without RemoteDesktop portal |

## Recommendation

1. **Phase 1: X11 (and XWayland sessions), full feature parity.** A small C
   helper using Xlib + XInput2 + XTest, ~800 lines, same protocol. Built at
   setup with the system `cc` like the Windows helper (needs `libx11-dev
   libxi-dev libxtst-dev`), or shipped prebuilt and signed in the AppImage.
   The privacy rule holds exactly as on Windows: the helper sees raw key events
   but only reports watched keys plus the one-bit `chord`.
2. **Phase 2: Wayland via portals only.** GlobalShortcuts for hold-to-talk,
   RemoteDesktop (or clipboard + "press Ctrl+V yourself") for insertion. No
   evdev: reading `/dev/input` means every keystroke in the system is readable
   by the app, which breaks the project's core privacy promise.
3. **Never:** an always-running root daemon, or `input`-group access.

## CI

The Linux CI job already runs lint, types, all unit tests and the C# compile
check. Phase 1 adds: build the C helper, run `test/helper-selftest.js` under
Xvfb (XTest and XInput2 work there), and an Electron smoke test under Xvfb.

## Open questions for the owner

- **L1.** Which desktop do you (and early users) run: GNOME, KDE, something
  wlroots-based (Sway, Hyprland), or X11? This decides whether Phase 1 alone is
  useful.
- **L2.** Is "build the helper at setup with `cc`" acceptable on Linux (needs
  three `-dev` packages), or should it ship prebuilt inside the AppImage?
- **L3.** On Wayland without portal support, is "the text is copied, press
  Ctrl+V" an acceptable fallback, instead of automatic insertion?
- **L4.** Packaging targets: AppImage only, or also .deb / Flatpak? (Flatpak
  pushes strongly toward the portal-only design.)
