// Type declarations for the renderer scripts (type checking only; never shipped
// as code). Renderers are plain <script> files with no imports, so the things
// they share through `window` are declared here.

/** The channel-whitelisted bridge each preload exposes (src/preload/*.js). */
interface SayAnythingBridge {
  send(channel: string, payload?: unknown): void;
  /** Returns an unsubscribe function. */
  on(channel: string, callback: (payload: any) => void): () => void;
  invoke(channel: string, payload?: unknown): Promise<any>;
  /** Welcome preload only: process.platform, so it can branch for macOS onboarding. */
  readonly platform?: string;
}

interface SayAnythingVadApi {
  createVad(opts?: object): {
    push(rms: number, dtMs: number): { fire: boolean; hasSpoken: boolean; speaking: boolean; progress: number };
    reset(): void;
  };
  DEFAULTS: object;
}

interface Window {
  sayanything: SayAnythingBridge;
  /** vad.js, loaded before audio.js in the overlay page. */
  SayAnythingVad: SayAnythingVadApi;
  /** Older WebKit name, used only as a fallback. */
  webkitAudioContext?: typeof AudioContext;
  /** Shared namespace of the Settings window scripts (settings/core.js etc.). */
  SayAnythingSettings: Record<string, any>;
  /** Debug/test hooks the renderers publish for test/*-check.js. */
  __sayanythingOverlay?: unknown;
  __sayanythingPad?: unknown;
  __sayanythingWelcome?: unknown;
}

/** In-page events between audio.js and overlay.js (never cross IPC). */
interface WindowEventMap {
  'sayanything:level': CustomEvent<{ rms: number }>;
  'sayanything:vad': CustomEvent<{ active: boolean; progress: number }>;
}

/**
 * What the settings/welcome `$(id)` helper returns: the pages look up form
 * controls (inputs, selects, buttons) by id. One intersection type keeps the
 * call sites simple while still checking member names. (An intersection of the
 * three element types collapses to `never`, so the shared members are listed.)
 */
interface FormField extends HTMLElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  readonly options: HTMLOptionsCollection;
  /** Listeners on a form field see the field itself as `this`. */
  addEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: FormField, ev: HTMLElementEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions
  ): void;
}
