import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/**', 'var/**'] },
  js.configs.recommended,
  {
    files: ['src/vendor/**/*.js'],
    languageOptions: { globals: { performance: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', fetch: 'readonly', Response: 'readonly', AbortController: 'readonly', TextDecoder: 'readonly', DecompressionStream: 'readonly', URL: 'readonly' } },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
