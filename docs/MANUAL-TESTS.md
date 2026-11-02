# Manual hardware test matrix

Behaviour that automated tests cannot prove, because it depends on a real
desktop session, real keyboard layouts or real clipboard history. Run these
before calling a release ready on a platform, and record the result, the date,
the OS build and who ran it. "Not run" is a valid result; a guess is not.

Automated coverage that backs these up:

- `npm test` (any OS): state machine scenarios incl. chords (`test/state-test.js`),
  sanitizer, settings defaults.
- `scripts/check-helper-cs.sh` (Linux/macOS with Mono): the Windows helper
  compiles under C# 5.
- Windows CI `node test/helper-selftest.js`: helper protocol, and when the runner
  has a clipboard session, the clipboard-history opt-out formats and HTML
  restore after a paste.

## Windows 10 / 11

| # | Setup | Steps | Expected | Result |
|---|---|---|---|---|
| W1 | Win 11, Settings → System → Clipboard: history ON, sync ON | Dictate a sentence into Notepad (Right Ctrl hold) | Text appears. Win+V shows no entry for it. Other device shows nothing. | Not run |
| W2 | Same | Drop-pad dictation (Right Alt hold), then Ctrl+V into Notepad | Pastes. Win+V shows no entry. | Not run |
| W3 | Same, turn OFF "Keep drop-pad text out of clipboard history" | Drop-pad dictation | Win+V DOES show the entry. | Not run |
| W4 | Copy a formatted range in Excel | Dictate into Word, then paste into Word | The Excel range pastes with formatting. | Not run |
| W5 | Copy an image (Snipping Tool) | Dictate, then paste into Paint | The image pastes. | Not run |
| W6 | Copy a file in Explorer | Dictate, then paste in another folder | The file is copied. | Not run |
| W7 | Empty clipboard (sign out/in) | Dictate, then Ctrl+V | Nothing pastes (the dictation did not linger). | Not run |
| W8 | US layout | In Notepad hold Right Ctrl, press Right Arrow quickly, release | Caret jumps a word. No pill stays open, nothing inserted. | Not run |
| W9 | German layout (DE) | Type `@` (AltGr+Q), `€` (AltGr+E), `\` (AltGr+ß) ten times | Characters typed. Drop pad never opens. | Not run |
| W10 | US layout | Tap Right Ctrl (latch), speak, press Right Ctrl+C, keep speaking, tap Right Ctrl | One dictation containing both halves. | Not run |
| W11 | Any | Lone tap of Right Alt in Notepad and Word | Note whether the menu bar activates (known, not fixed). | Not run |
| W12 | Elevated app (Notepad "Run as administrator") | Dictate into it | Record what happens (UIPI may block hook/injection). | Not run |
| W13 | RDP / slow app | Dictate with `restoreClipboardMs` 300, then 1000 | Record whether the OLD clipboard is pasted at 300 ms. | Not run |

## macOS 13+

| # | Setup | Steps | Expected | Result |
|---|---|---|---|---|
| M1 | A clipboard manager that honours nspasteboard.org types (e.g. Maccy, Paste) | Dictate into TextEdit | No new history entry. | Not run |
| M2 | Copy rich text from Pages | Dictate, then paste into Pages | Formatting preserved. | Not run |
| M3 | US layout | Hold Right Cmd, press Right Arrow, release | No dictation. | Not run |
| M4 | Right Option as pad key, US layout | Type Option+e e (é) | Drop pad never opens. | Not run |

## Linux

Not yet supported (see the roadmap).
