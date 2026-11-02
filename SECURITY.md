# Security policy

Say Anything is local-first by design: your audio, keystrokes, clipboard, and
transcripts are not sent off your machine by the app. There are no runtime network
calls except the local whisper server on `127.0.0.1` and, only if you turn it on,
a local rewrite server that must be on a loopback address. The app touches the
internet only when setup downloads binaries and models, or when you download a
model from the Model tab.

Known limits, stated plainly:

- **Download verification is partial.** The Windows whisper binary zip and the
  default `small.en` model are checked against pinned SHA-256 digests. Other
  catalog models are currently checked for size only. On macOS, whisper.cpp is
  built from a git tag, not a pinned commit. Pinning both is tracked work.
- **Clipboard.** Text is inserted by a clipboard swap. The temporary entry and
  drop-pad copies carry the Windows clipboard-history / cloud-clipboard opt-out
  formats and the macOS concealed/transient pasteboard types. Third-party
  clipboard managers may ignore these markers.
- **History.** When enabled, dictation history is stored unencrypted in the app's
  data folder. It is off by default.

## Reporting a vulnerability

Please **don't open a public issue for security problems.** Instead, use GitHub's
private **"Report a vulnerability"** button under this repository's **Security**
tab of https://github.com/LightningMarshal/sayanything. Reports are acknowledged
within a few days.

Especially interested in anything that could:

- send a user's audio, keystrokes, clipboard, or text off the device;
- escape the renderer sandbox or the IPC channel whitelists;
- abuse the native helper (keyboard/mouse hooks, clipboard, input injection);
- undermine the integrity of the downloaded model or whisper binaries.
