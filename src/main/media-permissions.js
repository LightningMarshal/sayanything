'use strict';

/**
 * Renderer permission policy: microphone only.
 *
 * Electron's 'media' permission covers BOTH microphone and camera, so a bare
 * allow would also permit webcam capture. The requested media type(s) are
 * inspected and only audio is granted; a getUserMedia({video:true}) request is
 * denied, and so is every other permission (notifications, geolocation,
 * clipboard-read, ...). PURE decision function, unit-tested by
 * test/media-permissions-test.js.
 */

/**
 * @param {string} permission
 * @param {{mediaTypes?: string[], mediaType?: string}} [details]
 * @returns {boolean}
 */
function audioOnlyAllowed(permission, details) {
  if (permission === 'microphone' || permission === 'audioCapture') return true;
  if (permission !== 'media') return false;
  const d = details || {};
  // The request handler exposes mediaTypes[]; the check handler exposes mediaType.
  const types = d.mediaTypes || (d.mediaType ? [d.mediaType] : []);
  return types.indexOf('video') === -1; // audio-only (or unspecified => mic) OK
}

/** Install the policy on an Electron session (no-op without one). */
function install(ses) {
  if (!ses) return;
  ses.setPermissionRequestHandler(function (_wc, permission, callback, details) {
    callback(audioOnlyAllowed(permission, details));
  });
  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler(function (_wc, permission, _origin, details) {
      return audioOnlyAllowed(permission, details);
    });
  }
}

module.exports = { audioOnlyAllowed: audioOnlyAllowed, install: install };
