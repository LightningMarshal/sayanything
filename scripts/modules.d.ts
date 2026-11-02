// @electron/fuses is ESM-only and publishes types only through "exports", which
// the project's node10 module resolution cannot see. Typed loosely here; the
// fuse names are validated at runtime in scripts/fuses.js.
declare module '@electron/fuses';
