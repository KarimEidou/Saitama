// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'android/**',
      'ios/**',
      'assets/source/**',
      'assets/generated/**',
      // Generated GPU-native asset output (`npm run assets:process`), including
      // the vendored Emscripten `basis/basis_transcoder.js`. Gitignored, but flat
      // config does not read .gitignore, so it needs listing here too.
      'public/assets/**',
      'verification/*.png',
      // Scratch/probe files written while investigating. Flat config does NOT
      // read .gitignore, so these need listing here or they fail the lint gate
      // for every workstream.
      '.probe*.mjs',
      '.probe*.ts',
      '.*-scratch/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Unused vars are warnings, not errors: 17 parallel workstreams write
      // stubs and partially-wired systems. `_`-prefixed args are always ok.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `any` shows up in third-party GL/WebXR interop; keep it visible but
      // non-blocking.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-console': 'off',
      'prefer-const': 'warn',
    },
  },

  // Node-side tooling: allow console + node globals freely.
  {
    files: ['tools/**/*.ts', 'verification/**/*.ts', '*.config.ts', '*.config.js'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Must stay last: turns off stylistic rules that conflict with Prettier.
  prettier
);
