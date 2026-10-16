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
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
