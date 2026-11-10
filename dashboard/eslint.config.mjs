import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.ts', '**/*.vue', '**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { parser: ts.parser, extraFileExtensions: ['.vue'] }
    },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
  }
];
