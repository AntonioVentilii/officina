import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

/**
 * The quality gate. Limits are the standard's (rule 9, no god files or functions); code that was
 * over them when the gate came in is listed in `eslint-suppressions.json`, which only shrinks.
 * Import boundaries are those of `docs/ai/structure.md`.
 */

const ours = (...names) => names.map((name) => `@officina/${name}`);

const SDK = {
  group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
  message: 'Only runner/src/sdk.ts calls Managed Agents; everything else uses ManagedAgentsPort.'
};

/** What a part of the workspace may not import, with the reason people read when they try. */
const boundary = (files, banned, message, options = {}) => ({
  files,
  ignores: options.ignores ?? [],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          ...(banned.length ? [{ group: banned, message }] : []),
          ...(options.sdk === false ? [] : [SDK])
        ]
      }
    ]
  }
});

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'apps/board/.svelte-kit/**', 'apps/board/build/**'] },
  { files: ['**/*.ts'], extends: [tseslint.configs.recommended] },
  {
    files: ['apps/board/**/*.svelte', 'apps/board/**/*.svelte.ts'],
    extends: [svelte.configs['flat/recommended']],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    rules: {
      // The board is served at the site root, so its links need no base path.
      'svelte/no-navigation-without-resolve': 'off'
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      // A rest sibling or a `_` name drops a field on purpose.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['**/*.ts', '**/*.svelte'],
    rules: {
      complexity: ['error', 10],
      'max-depth': ['error', 4],
      'max-params': ['error', 4]
    }
  },
  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,svelte}'],
    rules: { 'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }] }
  },
  boundary(
    ['packages/core/src/**'],
    [...ours('*'), 'pg'],
    'core is pure domain logic: it imports nothing of ours and does no I/O.'
  ),
  boundary(
    ['packages/db/src/**'],
    ours('engine', 'runner', 'github', 'api'),
    'db imports only core.'
  ),
  boundary(
    ['packages/runner/src/**'],
    ours('db', 'engine', 'github', 'api'),
    'runner imports only core.',
    {
      ignores: [
        'packages/runner/src/sdk.ts',
        'packages/runner/src/credentials.ts',
        'packages/runner/src/definitions.ts'
      ]
    }
  ),
  boundary(
    [
      'packages/runner/src/sdk.ts',
      'packages/runner/src/credentials.ts',
      'packages/runner/src/definitions.ts'
    ],
    ours('db', 'engine', 'github', 'api'),
    'runner imports only core.',
    { sdk: false }
  ),
  boundary(
    ['packages/github/src/**'],
    ours('db', 'engine', 'runner', 'api'),
    'github imports only core.'
  ),
  boundary(['packages/engine/src/**'], ours('api'), 'engine never imports the API app.'),
  boundary(['apps/api/src/**'], [], ''),
  boundary(
    ['apps/board/src/**'],
    ours('*'),
    'The board reads /api/* over HTTP and never imports a workspace package.'
  )
);
