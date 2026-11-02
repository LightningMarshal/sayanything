'use strict';

// ESLint flat config. Dev-only: ESLint never ships in the app (zero runtime
// dependencies is still the rule). Run with `npm run lint`.
//
// The rule set is @eslint/js "recommended" (real bugs: undefined variables,
// unreachable code, duplicate keys, bad typeof comparisons...) plus a few
// project rules. Style is not enforced here.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'bin/**', 'build-resources/**'],
  },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Unused args are common in callbacks (e, info, ...); unused locals are not.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      // Swallowed errors are deliberate in this codebase but must say so.
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'off',
      'no-implicit-globals': 'off',
    },
  },
  {
    // Main process, scripts, tests, this config: Node CommonJS.
    files: ['src/main/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2024, globals: { ...globals.node } },
  },
  {
    // Sandboxed preloads: CommonJS `require('electron')` + browser globals.
    files: ['src/preload/**/*.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2024, globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Renderers: plain <script> files, browser only, no require.
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'script', ecmaVersion: 2024, globals: { ...globals.browser } },
  },
  {
    // The AudioWorklet runs in AudioWorkletGlobalScope.
    files: ['src/renderer/overlay/worklet.js'],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
  {
    // Electron-run checks (`electron test/...`) use both Node and browser APIs.
    files: ['test/*-check.js', 'scripts/capture-screens.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
