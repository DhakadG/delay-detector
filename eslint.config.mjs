export default [
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        localStorage: 'readonly', performance: 'readonly', console: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', confirm: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        AudioContext: 'readonly', AudioWorkletNode: 'readonly', Blob: 'readonly',
        URL: 'readonly', MutationObserver: 'readonly', Event: 'readonly',
        AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly',
        currentFrame: 'readonly', sampleRate: 'readonly', self: 'readonly',
        caches: 'readonly', fetch: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', {args: 'none'}],
    },
  },
];
