# Say Anything, project overview

Free, local voice dictation for Windows and macOS. Hold a key, talk, and your words show up at your cursor. Runs 100% on-device (whisper.cpp), no account, no cloud, no telemetry. The differentiator is the **drop pad**: catch your words in a floating puck and drag it onto any text box to drop them exactly where you want.

- **Repo:** https://github.com/LightningMarshal/sayanything
- **Current version:** 0.2.0 (no Say Anything release published yet).

---

## Stack and hard constraints

- **Electron.** Main process is CommonJS; renderers are vanilla HTML/CSS/JS (no framework, no bundler). **Zero runtime npm deps** (only Electron + electron-builder as dev deps). Keep it that way.
- **Transcription:** self-hosted `whisper.cpp` `whisper-server.exe` (v1.9.1) on `127.0.0.1:8737`, `POST /inference` multipart. Model `small.en` is bundled so it works offline out of the box.
- **Native input:** a self-compiled C# helper (`SayAnythingHelper.exe`) does the global keyboard/mouse hooks and text injection. It is compiled by the .NET Framework `csc.exe` that ships with Windows, which is **C# 5 only**, no string interpolation, pattern matching, tuples, `out var`, etc.
- **Privacy is the product.** Nothing leaves the machine. The one network exception (optional AI rewrite) is hard-gated to loopback (see below). Do not add cloud anything.
- **Voice/brand:** informal, no em dashes in user-facing copy. Aurora palette (cyan/teal/violet), **never orange**. Logo is a voice waveform, never an "S"/monogram.

---

## Architecture

```
Electron main (src/main)                     Renderers (src/renderer)
  main.js        boot + IPC wiring              overlay/   the listening pill + mic capture
  state.js       dictation state machine        pad/       the drop pad (drag-to-drop)
  helper.js      supervises the C# helper       settings/  the settings window
  windows.js     all BrowserWindows             welcome/   first-run greeting
  ipc.js         channel names + preload allowlists
  config.js      paths (%APPDATA%/SayAnything, bundled resources)
  hotkey-match.js  pure combo-modifier matching (unit-tested)
  stores/        settings.js, history.js  (JSON on disk, atomic writes)
  whisper/       server.js, client.js, streaming.js, formatter.js, rewrite.js, models.js
                                             src/preload/  per-window context-bridge preloads

native/SayAnythingHelper.cs   WH_KEYBOARD_LL + WH_MOUSE_LL hooks, SendInput injection,
                               clipboard, foreground window, JSON-lines over stdio
bin/                           whisper-server.exe + the compiled helper (git-ignored; built/staged)
build-resources/models/        bundled ggml-small.en.bin
```

### The dictation flow
1. The C# helper installs a low-level keyboard hook and reports only **watched** keys (the hotkey + its modifiers, plus Esc while recording) to `helper.js` as JSON lines.
2. `state.js` is the machine: hotkey down → overlay `listening` + mic capture; release under 250 ms → latch (hands-free, VAD auto-stop); longer hold → finalize. It builds a WAV, POSTs to whisper, runs `formatter.format`, optionally runs the AI rewrite, then injects via the helper (clipboard-swap paste or unicode type).
3. **Combo hotkeys (v0.2):** a binding is `{ vk, mods, name }`. `hotkey-match.js` matches generic modifiers (either Alt satisfies Alt). The helper sends a real-time key-state snapshot with every event so a modifier lost across a lock-screen can't cause a misfire.
4. **Drop pad (the differentiator):** hold the pad key (Right Alt default), talk, and the text lands in a floating puck, auto-copied. Grab the puck and drag it onto a text box; on release the renderer sends `pad:place {x,y}` and the helper clicks that point + pastes. Renderer streams `pad:move {x,y}` during the drag so the window follows the cursor.
5. **Optional AI rewrite:** off by default. Points at a **local** model server (Ollama, or any OpenAI-compatible one like LM Studio / vLLM). `rewrite.js` `normalizeEndpoint()` refuses any non-loopback host and `fetch` uses `redirect:'error'`, so a transcript can never leave the machine even if a setting or a redirect tries.

---

## Build / run / test

```
npm install            # Electron + electron-builder
node scripts/setup.js  # one-time: fetch + verify whisper binaries and the small.en model
npm start              # run the app (electron .); compiles the C# helper on first run
npm test               # formatter / rewrite / wav / vad / streaming / hotkey-match
node test/helper-selftest.js   # spawns the helper, checks the stdio protocol (CI=1 skips clipboard read-back)
```

**Cutting a release**
```
# bump "version" in package.json, then:
npm run dist           # -> dist/SayAnything-Setup-<ver>.exe (NSIS) + dist/win-unpacked/
# portable zip is a manual zip of dist/win-unpacked:
#   Compress-Archive dist/win-unpacked/* -> dist/SayAnything-<ver>-win-x64-portable.zip
gh release create v<ver> -R LightningMarshal/sayanything -t "..." -F notes.md \
  dist/SayAnything-Setup-<ver>.exe dist/SayAnything-<ver>-win-x64-portable.zip
```
Both artifacts are **unsigned**, so Windows SmartScreen says "unknown publisher" (More info → Run anyway). Code signing is unbought; see roadmap.

---

## What's done (v0.2.0)

- Core dictation: hold-to-talk, tap-to-latch hands-free + VAD auto-stop, live preview, smart formatting (punctuation, filler removal, spoken "new line", artifact strip), custom dictionary, history.
- **Combo hotkeys** (issue #1): bind e.g. Alt+T.
- **Configurable local rewrite endpoint** (issue #2): Ollama or any OpenAI-compatible local server, loopback-only.
- **Newline fix** (issue #3): whisper segment breaks are flattened before formatting.
- **Drop pad**: drag-to-drop (was click-to-place).
- Reviewed after each feature; the review-found bugs (hotkey mis-route, stale-modifier misfire, loopback redirect bypass) are fixed.

## Fork remediation status (Say Anything, updated 2026-11-03)

Work items from the fork review (IDs WS-0 to WS-15). "CI" means verified by the
three-platform GitHub Actions workflow; "hardware" means it still needs a real
desktop, see `docs/MANUAL-TESTS.md`.

| ID | Item | Status |
|---|---|---|
| WS-0 | Rebrand to Say Anything, scrub previous maintainer details | Done |
| WS-1 | Rewrite sanitizer could delete dictated text | Fixed, tests |
| WS-2 | Dictations in clipboard history / cloud clipboard | Fixed; Windows opt-out formats verified in CI; hardware check pending |
| WS-3 | Clipboard restore lost rich content | Fixed (all formats, bounded); HTML restore verified in CI |
| WS-4 | Download integrity | Done: every model and the Windows zip SHA-256 pinned (cross-checked with Hugging Face), Mac whisper commit pinned |
| WS-5 | Hotkey shortcuts (Ctrl+Arrow, AltGr) misfire | Fixed with the one-bit `chord` event; hardware check pending |
| WS-6 | State machine untestable | Refactored, 21 scenarios; main.js split into ipc-handlers / smoke / onboarding / media-permissions modules; Settings renderer split into one file per tab (PR #9) |
| WS-7 | CI Windows-only | Linux + Windows + macOS + Electron renderer jobs; lint and type checks cover main, preloads and renderers |
| WS-8 | Doc drift, docs shipped in installer | Fixed; docs-drift test guards it |
| WS-9 | Insert without the clipboard (UIA / AX) | Not started |
| WS-10 | History privacy | Off by default, encrypted at rest, fail closed |
| WS-11 | Boot fails silently | Required modules now fatal with a dialog |
| WS-12 | Distribution and trust (signing, releases, fuses) | Electron fuses on packaged builds (verified in CI on the built .exe); Windows packaging job in CI; draft-release workflow with SHA256SUMS + provenance attestation (PR #11). Code signing deferred by the owner until every category is above 9 |
| WS-13 | Unfinished code review | Code read-through done. Done: renderer CSP without 'unsafe-inline', no dynamic innerHTML, preload allowlists == IPC handlers (tested), mic-only permissions (tested), helper JSON parser fuzzed (stack-overflow fixed), Electron fuses (PR #10). whisper-server/client/streaming reviewed: server routes now sit behind a random per-launch `--request-path` because upstream v1.9.1 has no auth, sends `Access-Control-Allow-Origin: *` and exposes `POST /load <any path>` (tested with a fake server). Swift helper reviewed: macOS clipboard restore now re-marks content as concealed (Windows already did). Remaining: network egress test (WS-14, needs hardware); see 'WS-13 follow-ups' below |
| WS-14 | Empirical "100% local" egress test | Not started (needs hardware) |
| WS-15 | Product ideas | Owner's call |
| Linux | Port | Phase 1 (Wayland portals, Flatpak). Steps 1-4 done: zero-dependency D-Bus client, GlobalShortcuts/RemoteDesktop clients, Linux adapter wired into the app (hotkey, paste with clipboard-only fallback, Ctrl+Super+Esc cancel), Settings shows desktop-bound shortcuts, portable static whisper-server build, and a Flatpak bundle (`io.github.lightningmarshal.SayAnything`) built in CI. CI transcribes real speech with the real engine on Linux and checks the packaged app. Next: step 5, testing on SteamOS and Ubuntu (install steps in `docs/LINUX-PORT.md`). Flathub submission later |

## WS-13 follow-ups (low priority, not done)

- **Clipboard restore can clobber a copy made mid-paste.** Both helpers restore the saved clipboard `restoreMs` after pasting without checking whether the user copied something in between. A `changeCount` (mac) / `GetClipboardSequenceNumber` (Windows) guard would fix it, but some clipboard managers rewrite the clipboard themselves, so it needs testing on real machines first.
- **Password-manager auto-clear.** Restoring the clipboard counts as a new change, so password managers that clear the clipboard after N seconds may see "the user copied something else" and skip clearing. Inherent to clipboard-swap paste; WS-9 (insert without the clipboard) is the real fix.
- **The secret is visible in the process list.** `--request-path` is a command-line argument, so other local accounts can read it on Linux (`ps`), and same-user software can on every OS. It is meant to keep browsers and remote origins out, not other local software.
- **Port reuse on Windows/macOS.** cpp-httplib sets `SO_REUSEADDR` (Windows) / `SO_REUSEPORT` (macOS, Linux) on its listening socket. A same-user process could bind the same port, but same-user code can already read the app's data, so this adds no new exposure.

## Roadmap / open items

- **macOS port** — DONE (Apple Silicon + Intel). The Swift helper (`native/SayAnythingHelper.swift`) speaks the same stdio protocol as the C# one (Windows-VK translation at the boundary, so settings stay portable), whisper.cpp builds locally with Metal (`scripts/build-whisper-mac.sh`), first-run TCC onboarding lives in the welcome window, and electron-builder makes a dmg+zip per arch. The two native binaries (the Swift helper and whisper-server) are universal (arm64 + x86_64 via lipo), so the one bundled `bin/` tree runs on both; the Intel whisper slice is CPU/Accelerate (no Metal). Guide: `docs/MAC-PORT.md`, pinned decisions: `docs/MAC-PORT-ADDENDUM.md`. Remaining: a live hands-on dictation pass after granting TCC, and Developer ID signing/notarization (steps in MAC-PORT.md §8).
- **Code signing** — Windows (SmartScreen) and macOS (Gatekeeper/notarization) both show "unknown/unidentified developer" while unsigned. Buying certs removes the scare screens.
- **Branding assets** — the demo GIF, screenshots and social preview still show the old product name and need regenerating (`scripts/capture-screens.js`).

## Docs

- `docs/SPEC.md` — intended behavior of every feature and the state machine.
- `docs/CONTRACTS.md` — module contracts, the settings schema, and the helper/IPC protocols.
- `docs/MAC-PORT.md` — how to recreate this on macOS.
