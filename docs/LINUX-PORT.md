# Linux port plan

Status: **plan, not started; revised after a market check (see below).** Priority order agreed with the owner: Windows,
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

## CI

The Linux CI job already runs lint, types, all unit tests and the C# compile
check. Phase 1 adds an Electron smoke test under Xvfb and unit tests for the portal
client with a fake D-Bus. Portal behaviour itself needs real GNOME and KDE
sessions (manual test matrix, or a GNOME/KDE VM in CI later).

## Open questions for the owner

- **L1.** Answered: SteamOS (KDE Plasma, Wayland) and Ubuntu (GNOME, Wayland).
- **L2.** Answered by the market check: ship prebuilt in a Flatpak/AppImage.
- **L3.** Is "the text is copied, press Ctrl+V" an acceptable fallback when
  the RemoteDesktop portal is refused or unavailable?
- **L4.** Is the default Linux hotkey allowed to be a chord (for example
  Super+Space), since bare-modifier shortcuts may not be supported by portals?

## Sources (November 2026)

- Steam survey October 2026: https://www.gamingonlinux.com/2026/11/steam-survey-october-2026-shows-an-uptick-for-the-linux-user-share/ , https://hwbusters.com/news/steam-hardware-survey-october-undoes-september-putting-16gb-and-the-rtx-3060-back-on-top/
- Ubuntu 26.04 / GNOME 50 Wayland-only: https://linuxiac.com/ubuntu-26-04-lts-resolute-raccoon-released/ , https://theregister.com/2026/03/19/gnome_50/
- SteamOS 3.8 Wayland default: https://www.phoronix.com/news/SteamOS-3.8-Preview , https://ostechnix.com/steamos-3-8-released/
- Desktop and Wayland trends: https://commandlinux.com/statistics/wayland-vs-xorg-adoption-trends/ , https://commandlinux.com/statistics/linux-desktop-environments/
- Portals: https://wiki.archlinux.org/title/XDG_Desktop_Portal , https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html , https://pypi.org/project/global-shortcut-portal/ , https://bugs.kde.org/show_bug.cgi?id=456025 , https://bugs.kde.org/show_bug.cgi?id=502509
