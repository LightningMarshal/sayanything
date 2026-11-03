# Linux port plan

Status: **phase 1 in progress.** Steps 1-3 are done (D-Bus and portal clients,
the Linux adapter wired into the app, Settings on Linux + cancel shortcut);
see "Phase 1 progress" below. Next: step 4 (Linux whisper-server + Flatpak). The plan was revised after a market check
(see below). Priority order agreed with the owner: Windows,
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
| Watch the hotkey (press and release) | XInput2 raw key events, filtered to watched keys inside the helper | No global key access for normal apps. Options: (a) **xdg-desktop-portal GlobalShortcuts** (press = Activated, release = Deactivated; supported by KDE Plasma 6+ and GNOME 48+; the user approves the binding once), (b) reading `/dev/input` (evdev), which needs the `input` group and lets the process see every keystroke |
| "Chord" bit (WS-5) | Yes, from the same XInput2 stream | Portal: not available (the compositor only reports the shortcut) |
| Insert text | XTest Ctrl+V after a clipboard swap, or XTest unicode via keysym remapping | **RemoteDesktop portal** (user prompt per session), `wtype` (wlroots compositors only), `ydotool` (uinput, needs a root daemon) |
| Clipboard | X selections (CLIPBOARD) | `wl-clipboard`, or Electron's own clipboard from the main process |
| Clipboard-history opt-out | `x-kde-passwordManagerHint=secret` MIME type (KDE Klipper), most managers ignore | Same hint; GNOME extensions vary |
| Foreground app (history "app") | `_NET_ACTIVE_WINDOW` + `_NET_WM_PID` | Not available to normal apps (leave blank) |
| Drop pad "place at point" | XTest move + click | Not possible without RemoteDesktop portal |

## Market check (November 2026)

The X11-first idea in the first draft of this plan is obsolete: every
mainstream desktop has moved to Wayland-only or Wayland-by-default.

- **Who uses Linux desktops.** Linux is 3.95% of the October 2026 Steam
  survey. Among Linux Steam users, the largest distributions are CachyOS
  (16.4%), SteamOS Holo (13.9%, the Steam Deck), Arch (8.9%), Linux Mint 22.3
  (8.4%), SteamOS (8.1%) and Bazzite (6.7%); Ubuntu 26.04 is 3.6%. Outside
  gaming, Ubuntu remains the default developer/office distribution.
- **Desktops.** KDE Plasma is the most common desktop among enthusiast and
  gaming distributions (SteamOS, Bazzite, CachyOS default to it); GNOME is the
  default on Ubuntu and Fedora Workstation. Estimates vary by source, but the
  two together are the large majority.
- **Wayland.** Ubuntu 26.04 LTS ships GNOME 50, which has no X11 session at all.
  KDE Plasma 6.8 (October 2026) is Wayland-only. SteamOS 3.8 made Wayland the
  default for Desktop Mode (X11 is still selectable in developer settings).
  X11 apps still run through XWayland, but XWayland apps cannot see global
  keyboard input or inject keys into native Wayland windows.

The owner's own machines (SteamOS and Ubuntu) are exactly the two main
targets: **KDE Plasma on Wayland** and **GNOME on Wayland**.

## Recommendation (revised)

1. **Wayland via portals is phase 1, not phase 2.**
   - Hotkey: **xdg-desktop-portal GlobalShortcuts.** Its `Activated` and
     `Deactivated` signals are press and release, so hold-to-talk and
     tap-to-latch keep working. KDE Plasma 6 and GNOME 48+ implement it. KDE
     binds silently and lists the shortcut in System Settings; GNOME asks for
     consent the first time. This is the most privacy-friendly design of any
     platform: the app never sees a single keystroke, only "shortcut pressed /
     released". The `chord` bit is not needed (the compositor resolves
     shortcuts itself).
   - Text insertion: put the text on the clipboard (Electron's own clipboard
     API), then send Ctrl+V through the **RemoteDesktop portal** (user grants
     keyboard access once per session; KDE has implemented keyboard input since
     2022, GNOME to be verified on Ubuntu 26.04). Fallback: leave the text on
     the clipboard and show "press Ctrl+V" (the drop pad already works this
     way).
   - Drop pad "place at point": not possible on Wayland without RemoteDesktop
     pointer access; Phase 1 offers pad + Ctrl+V only.
   - Foreground app for history: not available on Wayland; left blank.
2. **Packaging: Flatpak first, AppImage second.** SteamOS has a read-only root
   filesystem and installs desktop apps through Discover (Flathub), so `apt`
   packages and "compile the helper with `cc` at setup" do not work there. A
   Flatpak also gives the app the installed `.desktop` identity that recent
   portals (xdg-desktop-portal 1.21+, GNOME 50) require before they will serve
   GlobalShortcuts to an app. The helper (if one is needed at all, portals are
   D-Bus and could be called from Node) ships prebuilt inside the package.
3. **X11 / XWayland** support only as a later extra for users who select an
   X11 session (SteamOS developer setting, older distributions).
4. **Never:** `/dev/input` (evdev) access, the `input` group, or a root daemon
   such as ydotool. Each lets the app read or forge every keystroke on the
   system, which breaks the project's core privacy promise.

## Risks to verify on real machines

- GNOME 50 RemoteDesktop keyboard input from an unsandboxed or Flatpak app.
- KDE RemoteDesktop key ordering bugs reported against older Plasma (6.2);
  SteamOS 3.8 ships Plasma 6.4.
- GlobalShortcuts with a bare modifier (Right Ctrl alone) as the shortcut: some
  compositors only accept chords; the default Linux hotkey may need to be a
  chord such as Super+Space.

## Phase 1 progress

Design decision: **no Linux native helper.** The portals are D-Bus services,
so the main process talks to them directly through a small D-Bus client in
plain Node (`src/main/linux/dbus.js`, zero npm dependencies). Nothing has to be
compiled inside the Flatpak, and the code is tested in CI against a real bus.

| Step | What | Status |
|---|---|---|
| 1 | `src/main/linux/dbus.js`: session-bus connection (SASL EXTERNAL), method calls, signals, full type marshalling. `src/main/linux/portal.js`: GlobalShortcuts (bind, list, activated/deactivated) and RemoteDesktop (keyboard-only, persist_mode=2 + restore token, Ctrl+V as keysyms). Portal signals are only accepted from the bus name that owns `org.freedesktop.portal.Desktop`, so another program on the bus can't forge a hotkey press. | Done. `test/dbus-test.js` (wire format on every OS; interop with a private `dbus-daemon` and systemd's `busctl` on Linux) and `test/portal-test.js` (fake portal on a private bus) |
| 2 | `src/main/linux/helper-linux.js`: Linux stand-in behind the existing helper interface (`helper.js` exports it on Linux). Shortcut activated/deactivated -> new `'shortcut'` event, which `state.js` maps to the same hold / tap-to-latch gestures. Paste = Electron clipboard + RemoteDesktop Ctrl+V (session created on the first paste, restore token saved 0600 in `linux-portal.json`), clipboard restored after; refused or missing keyboard access leaves the text on the clipboard and the overlay says "Copied. Press Ctrl+V to paste" (L3). Default triggers when the hotkey is a bare modifier: Ctrl+Super+Space (main) and Ctrl+Super+Shift+Space (pad); not Super+Space, which GNOME uses to switch keyboard layouts. `config.js`: user data in `$XDG_CONFIG_HOME/SayAnything`. `binaries.js`: one locally built `whisper-server` like macOS, with a clear error until step 4 | Done. `test/helper-linux-test.js` (fake portal), new `state-test.js` scenarios, and `test/linux-boot-check.js`, which boots the real app (`--smoke`) under Xvfb against a fake portal in CI |
| 3 | Settings > Hotkey on Linux shows the shortcuts the desktop actually bound (new `hotkey:linux` IPC: `{linux, bound}`), hides the press-to-capture buttons, and says to change them in the desktop's keyboard shortcut settings. **Cancel without Esc:** a third portal shortcut, `cancel` (default Ctrl+Super+Esc, a chord so plain Esc is never taken from other apps), cancels a recording like Esc does elsewhere | Done. `ipc-handlers-test`, `state-test` (cancel scenario), `helper-linux-test`, `settings-tabs-check` (Linux layout via the demo bridge's `?linux=1`), and the boot check now expects three shortcuts |
| 4 | whisper-server for Linux (CPU build from the pinned v1.9.1 tag), Flatpak manifest, `.desktop` file, AppImage second | Next |
| 5 | Manual test matrix on SteamOS (KDE, Wayland) and Ubuntu 26.04 (GNOME 50, Wayland) | Needs the owner's machines |

### Known gaps in phase 1 (by design or not yet done)

- **Cancel is a chord, not Esc** (Ctrl+Super+Esc by default): a global plain Esc would steal Esc from every app.
- **Default shortcuts are unverified on real desktops** (Ctrl+Super+Space, Ctrl+Super+Shift+Space, Ctrl+Super+Esc): they may clash with a desktop or distribution default. The user can rebind them in the desktop's settings; step 5 checks them on SteamOS and Ubuntu.
- **Clipboard history:** the dictation briefly sits on the clipboard during a paste. Electron can't add KDE's `x-kde-passwordManagerHint` alongside the text, so Klipper and similar managers may record it. The restore puts back text, HTML, RTF and images only; other formats on the clipboard are lost.
- **Typing mode** pastes instead (no per-character typing through the portal yet).
- **Drop pad "place at point"** and the history "app" name are not available on Wayland.

## CI

The Linux CI job already runs lint, types, all unit tests and the C# compile
check. Phase 1 adds unit tests for the D-Bus and portal clients against a private
`dbus-daemon` and a fake portal (done), and an Electron smoke test under Xvfb
(step 2). Portal behaviour itself needs real GNOME and KDE
sessions (manual test matrix, or a GNOME/KDE VM in CI later).

## Open questions for the owner

- **L1.** Answered: SteamOS (KDE Plasma, Wayland) and Ubuntu (GNOME, Wayland).
- **L2.** Answered by the market check: ship prebuilt in a Flatpak/AppImage.
- **L3.** Answered: yes. When the RemoteDesktop portal is refused or
  unavailable, the text is left on the clipboard with a "press Ctrl+V" notice.
- **L4.** Answered: yes. The default Linux hotkey may be a chord (for example
  Super+Space) where the portal does not accept a bare modifier.

## Sources (November 2026)

- Steam survey October 2026: https://www.gamingonlinux.com/2026/11/steam-survey-october-2026-shows-an-uptick-for-the-linux-user-share/ , https://hwbusters.com/news/steam-hardware-survey-october-undoes-september-putting-16gb-and-the-rtx-3060-back-on-top/
- Ubuntu 26.04 / GNOME 50 Wayland-only: https://linuxiac.com/ubuntu-26-04-lts-resolute-raccoon-released/ , https://theregister.com/2026/03/19/gnome_50/
- SteamOS 3.8 Wayland default: https://www.phoronix.com/news/SteamOS-3.8-Preview , https://ostechnix.com/steamos-3-8-released/
- Desktop and Wayland trends: https://commandlinux.com/statistics/wayland-vs-xorg-adoption-trends/ , https://commandlinux.com/statistics/linux-desktop-environments/
- Portals: https://wiki.archlinux.org/title/XDG_Desktop_Portal , https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html , https://pypi.org/project/global-shortcut-portal/ , https://bugs.kde.org/show_bug.cgi?id=456025 , https://bugs.kde.org/show_bug.cgi?id=502509
