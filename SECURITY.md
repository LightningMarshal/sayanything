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
  catalog models are currently checked for size only and are labelled "not
  hash-verified" in the app; `scripts/pin-model-hashes.js` (or the "Pin model
  hashes" workflow) pins them after cross-checking Hugging Face's own LFS
  digests. On macOS, whisper.cpp is built from tag v1.9.1 and the build fails
  unless the tag resolves to the pinned commit
  f049fff95a089aa9969deb009cdd4892b3e74916.
- **Clipboard.** Text is inserted by a clipboard swap. The temporary entry and
  drop-pad copies carry the Windows clipboard-history / cloud-clipboard opt-out
  formats and the macOS concealed/transient pasteboard types. Third-party
  clipboard managers may ignore these markers.
- **History.** Off by default. When enabled it is encrypted at rest with the OS
  keystore (Electron safeStorage: DPAPI on Windows, Keychain on macOS). Where no
  real keystore exists (Linux without a keyring) it is stored as plain JSON with
  owner-only permissions and a warning is logged.

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
