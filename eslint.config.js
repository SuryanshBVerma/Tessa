import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/build/',
      '**/.react-router/',
      '**/node_modules/',
      '**/coverage/',
      'Context/',
      '**/src/schemas/generated/*.ts',
      '!**/src/schemas/generated/index.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Security: no dynamic code execution anywhere in Tessa.
      'no-eval': 'error',
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-new-func': 'error',
      // React Router uses thrown redirects and data() responses for control flow.
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'lib', name: 'Response' },
            { from: 'package', package: 'react-router', name: 'DataWithResponseInit' },
          ],
        },
      ],
    },
  },
  {
    // Tests mutate untyped JSON fixtures to build invalid cases.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The report page runs in the browser, not Node.
    files: ['mcp-server/templates/report/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        fetch: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        CSS: 'readonly',
        Event: 'readonly',
      },
    },
  },
  prettier,
);
