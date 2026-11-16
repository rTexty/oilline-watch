import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['docs/**', 'dist/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'validation/artifacts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.{ts,tsx}'], languageOptions: { globals: { ...globals.browser, ...globals.worker } } },
  { files: ['src/ui/**/*.tsx'], plugins: { 'react-hooks': reactHooks }, rules: reactHooks.configs.recommended.rules },
  { files: ['tools/**', 'tests/**', '*.config.*'], languageOptions: { globals: globals.node } },
)
